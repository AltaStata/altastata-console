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
import ShareIcon from "@mui/icons-material/Share";
import LockIcon from "@mui/icons-material/Lock";
import GridViewIcon from "@mui/icons-material/GridView";
import { useRef, useState, type ChangeEvent } from "react";
import {
  deletePath,
  downloadFile,
  getDirectoryZipDownloadUrl,
  resolveUploadTargetPath,
  sharePaths,
  uploadFile,
} from "@/api/altastata";
import type { FileEntry } from "@/types";

interface Props {
  selectedEntry: FileEntry | null;
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

export default function BottomToolbar({ selectedEntry, activePath, onRefresh }: Props) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string>("Ready");
  const [filterText, setFilterText] = useState("");

  const selectedLabel = selectedEntry
    ? (selectedEntry.is_dir ? `Folder: ${selectedEntry.path}` : `File: ${selectedEntry.path}`)
    : `Path: ${activePath}`;

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
    const targetPath = resolveUploadTargetPath(file.name, selectedEntry, activePath);
    await runAction("Upload", async () => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      await uploadFile(targetPath, bytes);
    });
    event.target.value = "";
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

  const writeStreamToHandle = async (handle: SaveFileHandle, response: Response) => {
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`HTTP ${response.status} ${response.statusText}${detail ? ` - ${detail}` : ""}`);
    }
    const writable = await handle.createWritable();
    try {
      if (!response.body) {
        await writable.write(await response.arrayBuffer());
      } else {
        const reader = response.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) await writable.write(value);
        }
      }
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

  const handleDownload = async () => {
    if (!selectedEntry || busy) return;

    const entry = selectedEntry;
    const downloadName = entry.is_dir ? `${entry.name}.zip` : entry.name;
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
      if (entry.is_dir) {
        startBrowserDownload(getDirectoryZipDownloadUrl(entry.path), downloadName);
        return;
      }
      await runAction("Download", async () => {
        const blob = await downloadFile(entry.path, entry.version);
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
        const response = await fetch(getDirectoryZipDownloadUrl(entry.path), { method: "GET" });
        await writeStreamToHandle(saveHandle as SaveFileHandle, response);
        return;
      }
      const blob = await downloadFile(entry.path, entry.version);
      await writeBlobToHandle(saveHandle as SaveFileHandle, blob);
    });
  };

  const handleDelete = async () => {
    if (!selectedEntry) return;
    const confirmed = window.confirm(`Delete ${selectedEntry.path}?`);
    if (!confirmed) return;
    await runAction("Delete", async () => {
      await deletePath(selectedEntry.path);
    });
  };

  const handleShare = async () => {
    if (!selectedEntry || selectedEntry.is_dir) return;
    const currentReaders = selectedEntry.readers.join(", ");
    const input = window.prompt("Share with readers (comma separated)", currentReaders);
    if (!input) return;
    const readers = input.split(",").map((item) => item.trim()).filter(Boolean);
    if (readers.length === 0) return;
    await runAction("Share", async () => {
      await sharePaths([selectedEntry.path], readers);
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
        <Tooltip title="Delete">
          <span>
            <IconButton size="small" disabled={busy || !selectedEntry} onClick={() => void handleDelete()}>
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
          <Tooltip title={selectedEntry?.is_dir ? "Download selected folder as ZIP" : "Download selected file"}>
            <span>
              <IconButton size="small" disabled={busy || !selectedEntry} onClick={() => void handleDownload()}>
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
          <Tooltip title="Share selected file">
            <span>
              <IconButton size="small" disabled={busy || !selectedEntry || selectedEntry.is_dir} onClick={() => void handleShare()}>
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
    </Box>
  );
}
