import {
  Box,
  IconButton,
  InputBase,
  LinearProgress,
  Stack,
  Tooltip,
  Divider,
  Typography,
} from "@mui/material";
import CreateNewFolderIcon from "@mui/icons-material/CreateNewFolder";
import DeleteIcon from "@mui/icons-material/Delete";
import SearchIcon from "@mui/icons-material/Search";
import DownloadIcon from "@mui/icons-material/Download";
import UploadIcon from "@mui/icons-material/Upload";
import DriveFolderUploadIcon from "@mui/icons-material/DriveFolderUpload";
import ShareIcon from "@mui/icons-material/Share";
import LockIcon from "@mui/icons-material/Lock";
import GridViewIcon from "@mui/icons-material/GridView";
import { useRef, useState, type ChangeEvent } from "react";
import { zip } from "fflate";
import {
  deletePath,
  downloadFile,
  makeUniqueArchiveName,
  resolveUploadTargetPath,
  runWithConcurrency,
  sharePaths,
  streamDirectoryZip,
  suggestMultiZipName,
  suggestedZipFileName,
  uploadFile,
} from "@/api/altastata";

const FOLDER_UPLOAD_CONCURRENCY = 4;
import type { FileEntry } from "@/types";

interface Props {
  selectedEntries: FileEntry[];
  activePath: string;
  onRefresh: () => void;
}

type SaveFileHandle = {
  createWritable: () => Promise<{
    write: (data: Uint8Array | ArrayBuffer) => Promise<void>;
    close: () => Promise<void>;
    abort: () => Promise<void>;
  }>;
};

type SavePickerWindow = Window & {
  showSaveFilePicker?: (options?: {
    suggestedName?: string;
    types?: Array<{
      description: string;
      accept: Record<string, string[]>;
    }>;
  }) => Promise<SaveFileHandle>;
};

export default function BottomToolbar({ selectedEntries, activePath, onRefresh }: Props) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string>("Ready");
  const [filterText, setFilterText] = useState("");

  const selectionCount = selectedEntries.length;
  const singleSelection: FileEntry | null = selectionCount === 1 ? selectedEntries[0] : null;
  // Upload always targets a single context: the lone selection or the active dir.
  const uploadAnchor = singleSelection;

  const selectedLabel = selectionCount === 0
    ? `Path: ${activePath}`
    : singleSelection
      ? (singleSelection.is_dir ? `Folder: ${singleSelection.path}` : `File: ${singleSelection.path}`)
      : `${selectionCount} items selected`;

  const runAction = async (label: string, fn: () => Promise<void>) => {
    setBusy(true);
    setStatus(`${label}...`);
    try {
      await fn();
      setStatus(`${label} done`);
      onRefresh();
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        setStatus(`${label} cancelled`);
        return;
      }
      setStatus(error instanceof Error ? `${label} failed: ${error.message}` : `${label} failed`);
    } finally {
      setBusy(false);
    }
  };

  const handleUploadClick = () => {
    if (busy) return;
    fileInputRef.current?.click();
  };

  const handleUploadSelected = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const targetPath = resolveUploadTargetPath(file.name, uploadAnchor, activePath);
    await runAction("Upload", async () => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      await uploadFile(targetPath, bytes);
    });
    event.target.value = "";
  };

  const handleUploadFolderClick = () => {
    if (busy) return;
    folderInputRef.current?.click();
  };

  const handleUploadFolderSelected = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (files.length === 0) return;

    setBusy(true);
    let completed = 0;
    setStatus(`Uploading folder (0/${files.length}, ×${FOLDER_UPLOAD_CONCURRENCY})...`);
    try {
      await runWithConcurrency(files, FOLDER_UPLOAD_CONCURRENCY, async (file) => {
        const relativePath = file.webkitRelativePath || file.name;
        const targetPath = resolveUploadTargetPath(relativePath, uploadAnchor, activePath);
        const bytes = new Uint8Array(await file.arrayBuffer());
        await uploadFile(targetPath, bytes);
        completed += 1;
        setStatus(`Uploading folder (${completed}/${files.length}, ×${FOLDER_UPLOAD_CONCURRENCY})...`);
      });
      setStatus(`Folder upload done (${completed}/${files.length})`);
      onRefresh();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setStatus(`Folder upload failed after ${completed}/${files.length}: ${detail}`);
    } finally {
      setBusy(false);
    }
  };

  const startBrowserDownload = (href: string, downloadName: string) => {
    const link = document.createElement("a");
    link.href = href;
    link.download = downloadName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setStatus("Download started (watch browser downloads for completion)");
  };

  const streamZipToHandle = async (handle: SaveFileHandle, path: string) => {
    const writable = await handle.createWritable();
    try {
      await streamDirectoryZip(path, async (chunk) => {
        await writable.write(chunk);
      });
      await writable.close();
    } catch (error) {
      try {
        await writable.abort();
      } catch {
        // Ignore abort errors if writer is already closed.
      }
      throw error;
    }
  };

  const collectZipBlob = async (path: string): Promise<Blob> => {
    const parts: BlobPart[] = [];
    await streamDirectoryZip(path, (chunk) => {
      parts.push(chunk.slice());
    });
    return new Blob(parts, { type: "application/zip" });
  };

  const writeBlobToHandle = async (handle: SaveFileHandle, blob: Blob) => {
    const writable = await handle.createWritable();
    try {
      await writable.write(await blob.arrayBuffer());
      await writable.close();
    } catch (error) {
      try {
        await writable.abort();
      } catch {
        // Ignore abort errors if writer is already closed.
      }
      throw error;
    }
  };

  const downloadSingleWithSavePicker = async (entry: FileEntry) => {
    const downloadName = entry.is_dir ? suggestedZipFileName(entry.path) : entry.name;
    const showSaveFilePicker = (window as SavePickerWindow).showSaveFilePicker;

    // Must open the save dialog synchronously in the click handler (user gesture).
    let saveHandle: SaveFileHandle | null = null;
    if (showSaveFilePicker) {
      try {
        saveHandle = await showSaveFilePicker(
          entry.is_dir
            ? {
              suggestedName: downloadName,
              types: [{ description: "ZIP archive", accept: { "application/zip": [".zip"] } }],
            }
            : { suggestedName: downloadName },
        );
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          setStatus("Download cancelled");
          return;
        }
        // SecurityError or unsupported options — fall back to browser download.
        saveHandle = null;
      }
    }

    if (!saveHandle) {
      await runAction("Download", async () => {
        const blob = entry.is_dir
          ? await collectZipBlob(entry.path)
          : await downloadFile(entry.path, entry.version);
        const url = URL.createObjectURL(blob);
        try {
          startBrowserDownload(url, downloadName);
        } finally {
          URL.revokeObjectURL(url);
        }
      });
      return;
    }

    await runAction("Download", async () => {
      if (entry.is_dir) {
        await streamZipToHandle(saveHandle as SaveFileHandle, entry.path);
        return;
      }
      const blob = await downloadFile(entry.path, entry.version);
      await writeBlobToHandle(saveHandle as SaveFileHandle, blob);
    });
  };

  const downloadEntryAsBytes = async (entry: FileEntry): Promise<Uint8Array> => {
    const blob = entry.is_dir
      ? await collectZipBlob(entry.path)
      : await downloadFile(entry.path, entry.version);
    return new Uint8Array(await blob.arrayBuffer());
  };

  const buildZipArchive = (files: Record<string, Uint8Array>): Promise<Uint8Array> => {
    return new Promise((resolve, reject) => {
      // Default level (6); covers text well, only mild slowdown on already-compressed media.
      zip(files, (err, data) => (err ? reject(err) : resolve(data)));
    });
  };

  const handleDownloadMultiAsZip = async (entries: FileEntry[]) => {
    const archiveName = suggestMultiZipName(entries);
    const showSaveFilePicker = (window as SavePickerWindow).showSaveFilePicker;

    // Open save dialog in the user-gesture window before any heavy work.
    let saveHandle: SaveFileHandle | null = null;
    if (showSaveFilePicker) {
      try {
        saveHandle = await showSaveFilePicker({
          suggestedName: archiveName,
          types: [{ description: "ZIP archive", accept: { "application/zip": [".zip"] } }],
        });
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          setStatus("Download cancelled");
          return;
        }
        // Unsupported / SecurityError — fall back to anchor-click below.
        saveHandle = null;
      }
    }

    const total = entries.length;
    setBusy(true);
    let collected = 0;
    setStatus(`Preparing ZIP (0/${total})...`);
    try {
      const archive: Record<string, Uint8Array> = {};
      const used = new Set<string>();
      for (const entry of entries) {
        const baseName = entry.is_dir ? suggestedZipFileName(entry.path) : entry.name;
        const uniqueName = makeUniqueArchiveName(baseName, used);
        archive[uniqueName] = await downloadEntryAsBytes(entry);
        collected += 1;
        setStatus(`Preparing ZIP (${collected}/${total})...`);
      }
      setStatus(`Compressing ZIP (${collected}/${total})...`);
      const zipped = await buildZipArchive(archive);
      // TS lib infers `Uint8Array<ArrayBufferLike>` from fflate, which the
      // current `BlobPart` typings reject; the cast is purely a typing nudge.
      const zipBlob = new Blob([zipped as unknown as BlobPart], { type: "application/zip" });

      if (saveHandle) {
        await writeBlobToHandle(saveHandle, zipBlob);
      } else {
        const url = URL.createObjectURL(zipBlob);
        try {
          startBrowserDownload(url, archiveName);
        } finally {
          URL.revokeObjectURL(url);
        }
      }
      setStatus(`Download done (${collected}/${total} packed into ${archiveName})`);
      onRefresh();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setStatus(`Download failed at ${collected + 1}/${total}: ${detail}`);
    } finally {
      setBusy(false);
    }
  };

  const handleDownload = async () => {
    if (selectionCount === 0 || busy) return;
    if (selectionCount === 1) {
      await downloadSingleWithSavePicker(selectedEntries[0]);
      return;
    }
    await handleDownloadMultiAsZip(selectedEntries);
  };

  const handleDelete = async () => {
    if (selectionCount === 0) return;
    const message = selectionCount === 1
      ? `Delete ${selectedEntries[0].path}?`
      : `Delete ${selectionCount} items?\n\n${selectedEntries.map((e) => e.path).join("\n")}`;
    const confirmed = window.confirm(message);
    if (!confirmed) return;
    const label = selectionCount === 1 ? "Delete" : `Delete ${selectionCount} items`;
    await runAction(label, async () => {
      for (const entry of selectedEntries) {
        await deletePath(entry.path);
      }
    });
  };

  const handleShare = async () => {
    if (!singleSelection || singleSelection.is_dir) return;
    const currentReaders = singleSelection.readers.join(", ");
    const input = window.prompt("Share with readers (comma separated)", currentReaders);
    if (!input) return;
    const readers = input.split(",").map((item) => item.trim()).filter(Boolean);
    if (readers.length === 0) return;
    await runAction("Share", async () => {
      await sharePaths([singleSelection.path], readers);
    });
  };

  return (
    <Box
      sx={{
        display: "grid",
        gridTemplateColumns: "1fr auto",
        alignItems: "center",
        columnGap: 1,
        rowGap: 0.5,
        px: 1.25,
        py: 0.75,
        borderTop: 1,
        borderColor: "divider",
        bgcolor: "background.paper",
      }}
    >
      <Stack direction="row" spacing={0.5} sx={{ alignItems: "center", minWidth: 0 }}>
        <Tooltip title="New folder">
          <span>
            <IconButton size="small" disabled>
            <CreateNewFolderIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip
          title={selectionCount > 1 ? `Delete ${selectionCount} items` : "Delete"}
        >
          <span>
            <IconButton size="small" disabled={busy || selectionCount === 0} onClick={() => void handleDelete()}>
            <DeleteIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>

        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            ml: 0.5,
            px: 1,
            border: 1,
            borderColor: "divider",
            borderRadius: 1,
            bgcolor: "#fafafa",
          }}
        >
          <SearchIcon fontSize="small" sx={{ opacity: 0.6 }} />
          <InputBase
            placeholder="Filter (local only)"
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
            sx={{ ml: 0.5, fontSize: 13, width: 160 }}
          />
        </Box>

        <Divider orientation="vertical" flexItem />

        <Stack direction="row" spacing={0.5}>
          <Tooltip
            title={
              selectionCount > 1
                ? `Download ${selectionCount} items as a single ZIP`
                : singleSelection?.is_dir
                  ? "Download selected folder as ZIP"
                  : "Download selected file"
            }
          >
            <span>
              <IconButton size="small" disabled={busy || selectionCount === 0} onClick={() => void handleDownload()}>
                <DownloadIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
          <Tooltip title="Upload file">
            <span>
              <IconButton size="small" disabled={busy} onClick={handleUploadClick}>
                <UploadIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
          <Tooltip title="Upload folder (preserves subdirectory structure)">
            <span>
              <IconButton size="small" disabled={busy} onClick={handleUploadFolderClick}>
                <DriveFolderUploadIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
          <Tooltip title={selectionCount > 1 ? "Select a single file to share" : "Share selected file"}>
            <span>
              <IconButton
                size="small"
                disabled={busy || !singleSelection || singleSelection.is_dir}
                onClick={() => void handleShare()}
              >
                <ShareIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
          <Tooltip title="Lock / encrypt (not wired yet)">
            <span>
              <IconButton size="small" disabled>
                <LockIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
        </Stack>

        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ ml: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
          title={selectedLabel}
        >
          {selectedLabel}
        </Typography>
      </Stack>

      <Stack direction="row" spacing={1} sx={{ alignItems: "center", justifySelf: "end" }}>
        <Typography
          variant="caption"
          color={status.includes("failed") ? "error.main" : "text.secondary"}
          sx={{ maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
          title={status}
        >
          {status}
        </Typography>
        {busy && <LinearProgress sx={{ width: 96 }} />}
        <Tooltip title="View options">
          <span>
            <IconButton size="small" disabled>
              <GridViewIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
      </Stack>

      <input
        ref={fileInputRef}
        type="file"
        style={{ display: "none" }}
        onChange={(e) => void handleUploadSelected(e)}
      />
      <input
        ref={(node) => {
          folderInputRef.current = node;
          if (node) {
            // webkitdirectory / directory are non-standard HTML attributes
            // (Chrome/Edge/Safari/Firefox all support webkitdirectory). They
            // are not in React's typed prop set, so we install them
            // imperatively to avoid casts or @ts-expect-error noise.
            node.setAttribute("webkitdirectory", "");
            node.setAttribute("directory", "");
          }
        }}
        type="file"
        multiple
        style={{ display: "none" }}
        onChange={(e) => void handleUploadFolderSelected(e)}
      />
    </Box>
  );
}
