import {
  Autocomplete,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  InputBase,
  LinearProgress,
  Stack,
  TextField,
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
import PersonRemoveIcon from "@mui/icons-material/PersonRemove";
import GridViewIcon from "@mui/icons-material/GridView";
import { useRef, useState, type ChangeEvent } from "react";
import { zip } from "fflate";
import {
  deletePath,
  downloadFile,
  fetchFilePreviewMetadata,
  listKnownUsers,
  makeUniqueArchiveName,
  resolveUploadTargetPath,
  revokePaths,
  runWithConcurrency,
  sharePaths,
  streamFileDownload,
  streamDirectoryZip,
  suggestMultiZipName,
  suggestedZipFileName,
  uploadBrowserFile,
} from "@/api/altastata";

const FOLDER_UPLOAD_CONCURRENCY = 4;
import type { FileEntry } from "@/types";
import type { DeletingTarget } from "@/utils/deletingTargets";

interface Props {
  selectedEntries: FileEntry[];
  activePath: string;
  /**
   * Full paths of folders the user has just created locally and that are
   * not yet backed by any file in the cloud. We need this here only so the
   * New Folder dialog can warn on duplicates BEFORE adding another pending
   * entry; the actual merge into the column listing happens in App.tsx /
   * MillerColumns.
   */
  pendingFolderPaths?: Set<string>;
  /**
   * Owner-supplied callback that registers a new pending folder. Receives
   * the FULL absolute path (e.g. `/foo/new-dir`).
   */
  onAddPendingFolder?: (fullPath: string) => void;
  onMarkPathsDeleting?: (targets: DeletingTarget[]) => void;
  onUnmarkPathsDeleting?: (targets: DeletingTarget[]) => void;
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

export default function BottomToolbar({
  selectedEntries,
  activePath,
  pendingFolderPaths,
  onAddPendingFolder,
  onMarkPathsDeleting,
  onUnmarkPathsDeleting,
  onRefresh,
}: Props) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  /** Download UI phase before the first payload byte (preparing → waiting → active). */
  const downloadWaitPhaseRef = useRef<"preparing" | "waiting">("preparing");
  const downloadAbortRef = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string>("Ready");
  /** 0–100 when byte progress is known; null = indeterminate spinner bar. */
  const [transferPercent, setTransferPercent] = useState<number | null>(null);
  const [filterText, setFilterText] = useState("");
  const [newFolderDialog, setNewFolderDialog] = useState<
    { name: string; error: string | null } | null
  >(null);

  const selectionCount = selectedEntries.length;
  const singleSelection: FileEntry | null = selectionCount === 1 ? selectedEntries[0] : null;

  const openNewFolderDialog = () => {
    setNewFolderDialog({ name: "", error: null });
  };

  const closeNewFolderDialog = () => {
    setNewFolderDialog(null);
  };

  const submitNewFolderDialog = () => {
    if (!newFolderDialog || !onAddPendingFolder) return;
    const raw = newFolderDialog.name.trim();
    if (!raw) {
      setNewFolderDialog({ ...newFolderDialog, error: "Enter a folder name." });
      return;
    }
    if (raw.includes("/") || raw.includes("\\")) {
      setNewFolderDialog({
        ...newFolderDialog,
        error: "Slashes are not allowed in a folder name.",
      });
      return;
    }
    if (raw === "." || raw === "..") {
      setNewFolderDialog({ ...newFolderDialog, error: "Reserved name." });
      return;
    }
    // Compose the full absolute path. `activePath` is `/` for root or
    // `/foo/bar` for a nested folder; we just append `/<name>`. Mirrors how
    // altastata-ui builds parentDirAbsolutePath + "/" + name.
    const fullPath = activePath === "/" ? `/${raw}` : `${activePath}/${raw}`;
    if (pendingFolderPaths?.has(fullPath)) {
      setNewFolderDialog({
        ...newFolderDialog,
        error: "A folder with that name already exists here.",
      });
      return;
    }
    onAddPendingFolder(fullPath);
    setStatus(`Created (pending) ${fullPath}`);
    setNewFolderDialog(null);
  };
  // Upload always targets a single context: the lone selection or the active dir.
  const uploadAnchor = singleSelection;

  const selectedLabel = selectionCount === 0
    ? `Path: ${activePath}`
    : singleSelection
      ? (singleSelection.is_dir ? `Folder: ${singleSelection.path}` : `File: ${singleSelection.path}`)
      : `${selectionCount} items selected`;

  const runAction = async (label: string, fn: () => Promise<void>) => {
    setBusy(true);
    setTransferPercent(null);
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
      setTransferPercent(null);
    }
  };

  const reportByteProgress = (
    transferred: number,
    total: number | null | undefined,
    label: "Uploading" | "Downloading",
  ) => {
    if (total != null && total > 0) {
      setTransferPercent(Math.min(100, (transferred / total) * 100));
      const cap = Math.min(transferred, total).toLocaleString("en-US");
      const all = total.toLocaleString("en-US");
      const waitHint = transferred === 0 && label === "Downloading"
        ? (downloadWaitPhaseRef.current === "waiting" ? ", waiting for data" : ", preparing")
        : transferred === 0 ? ", preparing" : "";
      setStatus(`${label} (${cap}/${all} bytes${waitHint})...`);
      return;
    }
    setTransferPercent(null);
    if (transferred === 0) {
      const waitHint = label === "Downloading" && downloadWaitPhaseRef.current === "waiting"
        ? "waiting for data"
        : "preparing";
      setStatus(`${label} (${waitHint})...`);
      return;
    }
    setStatus(`${label} (${transferred.toLocaleString("en-US")} bytes)...`);
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
      reportByteProgress(0, file.size, "Uploading");
      await uploadBrowserFile(targetPath, file, (uploaded, total) => {
        reportByteProgress(uploaded, total, "Uploading");
      });
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

    const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    const inFlight = new Map<number, number>();
    let completedFiles = 0;
    let completedBytes = 0;

    const reportFolderUploadProgress = (currentName?: string) => {
      const inFlightBytes = Array.from(inFlight.values()).reduce((sum, n) => sum + n, 0);
      const transferred = completedBytes + inFlightBytes;
      if (totalBytes > 0) {
        setTransferPercent(Math.min(100, (transferred / totalBytes) * 100));
      } else {
        setTransferPercent(null);
      }
      const bytesPart = totalBytes > 0
        ? `${Math.min(transferred, totalBytes).toLocaleString("en-US")}/${totalBytes.toLocaleString("en-US")} bytes`
        : `${transferred.toLocaleString("en-US")} bytes`;
      const waitHint = transferred === 0 ? ", preparing" : "";
      const filePart = currentName
        ? `, ${currentName}`
        : completedFiles < files.length
          ? ", starting uploads"
          : "";
      setStatus(
        `Uploading folder (${completedFiles}/${files.length} files, ${bytesPart}${waitHint}${filePart})...`,
      );
    };

    setBusy(true);
    reportFolderUploadProgress();
    try {
      await runWithConcurrency(files, FOLDER_UPLOAD_CONCURRENCY, async (file, index) => {
        const relativePath = file.webkitRelativePath || file.name;
        const targetPath = resolveUploadTargetPath(relativePath, uploadAnchor, activePath);
        const displayName = relativePath.split("/").pop() ?? file.name;
        inFlight.set(index, 0);
        reportFolderUploadProgress(displayName);
        await uploadBrowserFile(targetPath, file, (uploaded) => {
          inFlight.set(index, uploaded);
          reportFolderUploadProgress(displayName);
        });
        inFlight.delete(index);
        completedBytes += file.size;
        completedFiles += 1;
        reportFolderUploadProgress();
      });
      setStatus(`Folder upload done (${completedFiles}/${files.length})`);
      onRefresh();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setStatus(`Folder upload failed after ${completedFiles}/${files.length}: ${detail}`);
    } finally {
      setBusy(false);
      setTransferPercent(null);
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

  const streamZipToHandle = async (
    handle: SaveFileHandle,
    path: string,
    onProgress?: (downloadedBytes: number) => void,
    signal?: AbortSignal,
  ) => {
    markDownloadWaiting(null);
    const writable = await handle.createWritable();
    try {
      await streamDirectoryZip(path, async (chunk) => {
        await writable.write(chunk);
      }, {
        onProgress,
        signal,
        onStreamOpen: () => markDownloadWaiting(null),
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

  const reportDownloadProgress = (downloaded: number, total: number | null | undefined) => {
    reportByteProgress(downloaded, total, "Downloading");
  };

  const markDownloadWaiting = (total: number | null | undefined) => {
    downloadWaitPhaseRef.current = "waiting";
    reportDownloadProgress(0, total);
  };

  const streamFileToHandle = async (
    handle: SaveFileHandle,
    path: string,
    version: string | null,
    totalBytes: number | null | undefined,
    onProgress?: (downloadedBytes: number) => void,
    signal?: AbortSignal,
  ) => {
    markDownloadWaiting(totalBytes);
    const writable = await handle.createWritable();
    try {
      await streamFileDownload(path, version, async (chunk) => {
        await writable.write(chunk);
      }, {
        onProgress,
        signal,
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

    let totalBytes = entry.is_dir ? null : entry.size;
    downloadAbortRef.current?.abort();
    const downloadAbort = new AbortController();
    downloadAbortRef.current = downloadAbort;
    setBusy(true);
    downloadWaitPhaseRef.current = "preparing";
    reportDownloadProgress(0, totalBytes);
    try {
      if (!entry.is_dir && (totalBytes == null || totalBytes <= 0)) {
        try {
          const meta = await fetchFilePreviewMetadata(entry.path, entry.version);
          if (meta.size != null && meta.size > 0) {
            totalBytes = meta.size;
            reportDownloadProgress(0, totalBytes);
          }
        } catch {
          // Keep indeterminate progress when size is unavailable.
        }
      }
      if (entry.is_dir) {
        await streamZipToHandle(
          saveHandle as SaveFileHandle,
          entry.path,
          (downloaded) => reportDownloadProgress(downloaded, null),
          downloadAbort.signal,
        );
      } else {
        await streamFileToHandle(
          saveHandle as SaveFileHandle,
          entry.path,
          entry.version,
          totalBytes,
          (downloaded) => reportDownloadProgress(downloaded, totalBytes),
          downloadAbort.signal,
        );
      }
      setStatus("Download done");
      onRefresh();
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        setStatus("Download cancelled");
      } else {
        const detail = error instanceof Error ? error.message : String(error);
        setStatus(`Download failed: ${detail}`);
      }
    } finally {
      setBusy(false);
      setTransferPercent(null);
    }
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
    const targets = [...selectedEntries];
    const deletingMarks: DeletingTarget[] = targets.map((entry) => ({
      path: entry.path,
      recursive: entry.is_dir,
    }));
    const label = selectionCount === 1 ? "Delete" : `Delete ${selectionCount} items`;
    onMarkPathsDeleting?.(deletingMarks);
    setBusy(true);
    try {
      for (let i = 0; i < targets.length; i += 1) {
        const entry = targets[i];
        const mark: DeletingTarget = { path: entry.path, recursive: entry.is_dir };
        setStatus(`${label} ${i + 1}/${targets.length}: ${entry.path}`);
        await deletePath(entry.path);
        onUnmarkPathsDeleting?.([mark]);
      }
      setStatus(`${label} done`);
      onRefresh();
    } catch (error) {
      onUnmarkPathsDeleting?.(deletingMarks);
      if (error instanceof DOMException && error.name === "AbortError") {
        setStatus(`${label} cancelled`);
        return;
      }
      setStatus(error instanceof Error ? `${label} failed: ${error.message}` : `${label} failed`);
    } finally {
      setBusy(false);
    }
  };

  type AccessDialogMode = "share" | "revoke";
  interface AccessDialogState {
    mode: AccessDialogMode;
    targets: FileEntry[];
    loadingUsers: boolean;
    knownUsers: string[];
    selected: string;
    error: string | null;
  }
  const [accessDialog, setAccessDialog] = useState<AccessDialogState | null>(null);

  const openAccessDialog = async (mode: AccessDialogMode) => {
    if (selectionCount === 0 || busy) return;
    const targets = [...selectedEntries];
    // Pre-seed with current readers (union across selection) so revoking is
    // intuitive — the user sees who already has access.
    const currentReaders = new Set<string>();
    for (const entry of targets) {
      for (const reader of entry.readers ?? []) {
        if (reader) currentReaders.add(reader);
      }
    }
    setAccessDialog({
      mode,
      targets,
      loadingUsers: true,
      knownUsers: [...currentReaders].sort((a, b) =>
        a.localeCompare(b, undefined, { sensitivity: "base" }),
      ),
      selected: "",
      error: null,
    });
    try {
      const users = await listKnownUsers();
      setAccessDialog((prev) => {
        if (!prev) return prev;
        const merged = new Set<string>([...prev.knownUsers, ...users]);
        return {
          ...prev,
          loadingUsers: false,
          knownUsers: [...merged].sort((a, b) =>
            a.localeCompare(b, undefined, { sensitivity: "base" }),
          ),
        };
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setAccessDialog((prev) =>
        prev ? { ...prev, loadingUsers: false, error: `Cannot list users: ${message}` } : prev,
      );
    }
  };

  const closeAccessDialog = () => {
    if (busy) return;
    setAccessDialog(null);
  };

  const submitAccessDialog = async () => {
    if (!accessDialog) return;
    const reader = accessDialog.selected.trim();
    if (!reader) {
      setAccessDialog({ ...accessDialog, error: "Pick a user." });
      return;
    }
    const { mode, targets } = accessDialog;
    const paths = targets.map((e) => e.path);
    setAccessDialog(null);
    const label = mode === "share"
      ? `Share with ${reader}`
      : `Revoke ${reader}`;
    await runAction(label, async () => {
      if (mode === "share") {
        await sharePaths(paths, [reader]);
      } else {
        await revokePaths(paths, [reader]);
      }
    });
    // Share is processed asynchronously by the AltaStata msgqueue / SecureCloudEventProcessor:
    // the gRPC call returns as soon as the ADDREADER message is queued, so the file's "readers"
    // attribute does not yet reflect the new reader when the immediate refresh fires. Schedule a
    // couple of follow-up refreshes so the preview pane catches up without the user having to
    // re-click the file. Revoke is applied synchronously, so no follow-up is needed.
    if (mode === "share") {
      window.setTimeout(() => onRefresh(), 1500);
      window.setTimeout(() => onRefresh(), 4000);
    }
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
        <Tooltip
          title={
            onAddPendingFolder
              ? "New folder (lives only in this browser session until you upload a file into it)"
              : "New folder"
          }
        >
          <span>
            <IconButton
              size="small"
              disabled={busy || !onAddPendingFolder}
              onClick={openNewFolderDialog}
            >
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
          <Tooltip
            title={
              selectionCount > 1
                ? `Share ${selectionCount} items with a reader`
                : "Share selected item with a reader"
            }
          >
            <span>
              <IconButton
                size="small"
                disabled={busy || selectionCount === 0}
                onClick={() => void openAccessDialog("share")}
              >
                <ShareIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
          <Tooltip
            title={
              selectionCount > 1
                ? `Revoke a reader's access from ${selectionCount} items`
                : "Revoke a reader's access from selected item"
            }
          >
            <span>
              <IconButton
                size="small"
                disabled={busy || selectionCount === 0}
                onClick={() => void openAccessDialog("revoke")}
              >
                <PersonRemoveIcon fontSize="small" />
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
          sx={{ maxWidth: 480, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
          title={status}
        >
          {status}
        </Typography>
        {busy && (
          <LinearProgress
            variant={transferPercent != null ? "determinate" : "indeterminate"}
            value={transferPercent ?? 0}
            sx={{ width: 128 }}
          />
        )}
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

      <Dialog
        open={newFolderDialog !== null}
        onClose={closeNewFolderDialog}
        fullWidth
        maxWidth="xs"
      >
        <DialogTitle sx={{ pb: 1 }}>New folder</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={1.5} sx={{ mt: 0.5 }}>
            <Typography variant="body2" color="text.secondary">
              Inside: {activePath}
            </Typography>
            <TextField
              autoFocus
              size="small"
              label="Folder name"
              placeholder="my-folder"
              value={newFolderDialog?.name ?? ""}
              onChange={(e) => {
                if (!newFolderDialog) return;
                setNewFolderDialog({
                  ...newFolderDialog,
                  name: e.target.value,
                  error: null,
                });
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  submitNewFolderDialog();
                }
              }}
              fullWidth
            />
            <Typography variant="caption" color="text.secondary">
              The folder is local to this browser session until you upload a
              file into it. AltaStata stores files keyed by path prefix, so an
              empty folder has no on-cloud representation.
            </Typography>
            {newFolderDialog?.error && (
              <Typography variant="caption" color="error.main">
                {newFolderDialog.error}
              </Typography>
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={closeNewFolderDialog}>Cancel</Button>
          <Button
            variant="contained"
            onClick={submitNewFolderDialog}
            disabled={!newFolderDialog?.name.trim()}
          >
            Create
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={accessDialog !== null}
        onClose={closeAccessDialog}
        fullWidth
        maxWidth="xs"
      >
        <DialogTitle sx={{ pb: 1 }}>
          {accessDialog?.mode === "share" ? "Share access" : "Revoke access"}
        </DialogTitle>
        <DialogContent dividers>
          <Stack spacing={1.5} sx={{ mt: 0.5 }}>
            <Typography variant="body2" color="text.secondary">
              {accessDialog
                ? accessDialog.targets.length === 1
                  ? `${accessDialog.targets[0].is_dir ? "Folder" : "File"}: ${accessDialog.targets[0].path}`
                  : `${accessDialog.targets.length} items selected`
                : ""}
            </Typography>
            <Autocomplete
              freeSolo
              size="small"
              options={accessDialog?.knownUsers ?? []}
              value={accessDialog?.selected ?? ""}
              onChange={(_, value) => {
                if (!accessDialog) return;
                setAccessDialog({
                  ...accessDialog,
                  selected: typeof value === "string" ? value : "",
                  error: null,
                });
              }}
              onInputChange={(_, value) => {
                if (!accessDialog) return;
                setAccessDialog({ ...accessDialog, selected: value, error: null });
              }}
              loading={accessDialog?.loadingUsers ?? false}
              renderInput={(params) => (
                <TextField
                  {...params}
                  autoFocus
                  label={accessDialog?.mode === "share" ? "Share with user" : "Revoke from user"}
                  placeholder="user.account"
                  InputProps={{
                    ...params.InputProps,
                    endAdornment: (
                      <>
                        {accessDialog?.loadingUsers
                          ? <CircularProgress color="inherit" size={16} />
                          : null}
                        {params.InputProps.endAdornment}
                      </>
                    ),
                  }}
                />
              )}
            />
            {accessDialog?.error && (
              <Typography variant="caption" color="error.main">
                {accessDialog.error}
              </Typography>
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={closeAccessDialog}>Cancel</Button>
          <Button
            variant="contained"
            color={accessDialog?.mode === "revoke" ? "warning" : "primary"}
            onClick={() => void submitAccessDialog()}
            disabled={!accessDialog || !accessDialog.selected.trim()}
          >
            {accessDialog?.mode === "share" ? "Share" : "Revoke"}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
