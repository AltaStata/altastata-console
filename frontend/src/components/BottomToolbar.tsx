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
import { Zip, ZipPassThrough, zip } from "fflate";
import {
  deletePath,
  fetchFilePreviewMetadata,
  downloadFile,
  listKnownUsers,
  makeUniqueArchiveName,
  resolveUploadTargetPath,
  revokePaths,
  runWithConcurrency,
  sharePaths,
  streamDirectoryZip,
  streamFileDownload,
  suggestMultiZipName,
  suggestedZipFileName,
  uploadBrowserFile,
} from "@/api/altastata";

const FOLDER_UPLOAD_CONCURRENCY_DEFAULT = 4;
const FOLDER_UPLOAD_CONCURRENCY_MAX_SMALL_FILES = 12;
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

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = value;
  let idx = 0;
  while (n >= 1024 && idx < units.length - 1) {
    n /= 1024;
    idx += 1;
  }
  const fixed = n >= 100 || idx === 0 ? 0 : 1;
  return `${n.toFixed(fixed)} ${units[idx]}`;
}

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
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string>("Ready");
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

  const chooseFolderUploadConcurrency = (files: File[]): number => {
    if (files.length === 0) return FOLDER_UPLOAD_CONCURRENCY_DEFAULT;
    // Small-file bursts (hundreds/thousands) are dominated by per-file RPC and
    // metadata latency, so higher parallelism improves throughput significantly.
    const maxSize = files.reduce((m, f) => Math.max(m, f.size || 0), 0);
    const hw = (typeof navigator !== "undefined" && navigator.hardwareConcurrency)
      ? navigator.hardwareConcurrency
      : 8;
    if (files.length >= 500 && maxSize <= 256 * 1024) {
      return Math.min(FOLDER_UPLOAD_CONCURRENCY_MAX_SMALL_FILES, Math.max(6, hw));
    }
    if (files.length >= 100 && maxSize <= 1024 * 1024) {
      return Math.min(8, Math.max(4, hw));
    }
    return FOLDER_UPLOAD_CONCURRENCY_DEFAULT;
  };

  const enqueuePendingFoldersForTargetPath = (targetPath: string) => {
    if (!onAddPendingFolder) return;
    const normalized = targetPath.trim().replace(/\/+/g, "/");
    const lastSlash = normalized.lastIndexOf("/");
    if (lastSlash <= 0) return;
    let parent = normalized.slice(0, lastSlash);
    while (parent && parent !== "/") {
      onAddPendingFolder(parent);
      const idx = parent.lastIndexOf("/");
      parent = idx <= 0 ? "/" : parent.slice(0, idx);
    }
  };

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
    const totalBytes = file.size || 0;
    setBusy(true);
    setStatus(totalBytes > 0 ? `Uploading 0 B / ${formatBytes(totalBytes)}...` : "Uploading 0 B...");
    try {
      let lastProgressAt = 0;
      let hasReportedProgress = false;
      await uploadBrowserFile(targetPath, file, (bytesSent, totalBytes) => {
        const now = Date.now();
        const isFinal = totalBytes > 0 && bytesSent >= totalBytes;
        if (hasReportedProgress && !isFinal && now - lastProgressAt < 200) return;
        const progress = totalBytes > 0
          ? `${formatBytes(bytesSent)} / ${formatBytes(totalBytes)}`
          : formatBytes(bytesSent);
        setStatus(`Uploading ${progress}...`);
        hasReportedProgress = true;
        lastProgressAt = now;
      });
      const doneSuffix = totalBytes > 0 ? ` (${formatBytes(totalBytes)})` : "";
      setStatus(`Upload done${doneSuffix}`);
      onRefresh();
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        setStatus("Upload cancelled");
      } else {
        setStatus(error instanceof Error ? `Upload failed: ${error.message}` : "Upload failed");
      }
    } finally {
      setBusy(false);
    }
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

    const folderUploadConcurrency = chooseFolderUploadConcurrency(files);
    setBusy(true);
    let completed = 0;
    setStatus(`Uploading folder (0/${files.length}, ×${folderUploadConcurrency})...`);
    try {
      // Show the folder tree immediately while files are still uploading.
      for (const file of files) {
        const relativePath = file.webkitRelativePath || file.name;
        const targetPath = resolveUploadTargetPath(relativePath, uploadAnchor, activePath);
        enqueuePendingFoldersForTargetPath(targetPath);
      }

      await runWithConcurrency(files, folderUploadConcurrency, async (file) => {
        const relativePath = file.webkitRelativePath || file.name;
        const targetPath = resolveUploadTargetPath(relativePath, uploadAnchor, activePath);
        await uploadBrowserFile(targetPath, file);
        completed += 1;
        setStatus(`Uploading folder (${completed}/${files.length}, ×${folderUploadConcurrency})...`);
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
    let writtenBytes = 0;
    let lastProgressAt = 0;
    try {
      await streamDirectoryZip(path, async (chunk) => {
        await writable.write(chunk);
        writtenBytes += chunk.length;
        const now = Date.now();
        if (now - lastProgressAt >= 250) {
          setStatus(`Downloading ZIP ${formatBytes(writtenBytes)}...`);
          lastProgressAt = now;
        }
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

  const streamFileToHandle = async (
    handle: SaveFileHandle,
    path: string,
    version: string | null,
    totalBytesHint: number | null = null,
  ) => {
    const selected = selectedEntries.find((entry) => entry.path === path && entry.version === version) ?? null;
    const totalBytes = totalBytesHint ?? (
      typeof selected?.size === "number" && selected.size > 0 ? selected.size : null
    );
    let writtenBytes = 0;
    let lastProgressAt = 0;
    const writable = await handle.createWritable();
    try {
      await streamFileDownload(path, version, async (chunk) => {
        await writable.write(chunk);
        writtenBytes += chunk.length;
        const now = Date.now();
        if (now - lastProgressAt >= 250) {
          const progress = totalBytes
            ? `${formatBytes(writtenBytes)} / ${formatBytes(totalBytes)}`
            : formatBytes(writtenBytes);
          setStatus(`Downloading ${progress}...`);
          lastProgressAt = now;
        }
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

  const collectFileBlobStreaming = async (
    path: string,
    version: string | null,
    totalBytesHint: number | null,
  ): Promise<Blob> => {
    const parts: BlobPart[] = [];
    let writtenBytes = 0;
    let lastProgressAt = 0;
    await streamFileDownload(path, version, (chunk) => {
      parts.push(chunk.slice());
      writtenBytes += chunk.length;
      const now = Date.now();
      if (now - lastProgressAt >= 250) {
        const progress = totalBytesHint
          ? `${formatBytes(writtenBytes)} / ${formatBytes(totalBytesHint)}`
          : formatBytes(writtenBytes);
        setStatus(`Downloading ${progress}...`);
        lastProgressAt = now;
      }
    });
    return new Blob(parts, { type: "application/octet-stream" });
  };

  const resolveSingleFileSizeHint = async (entry: FileEntry): Promise<number | null> => {
    if (entry.is_dir) return null;
    if (typeof entry.size === "number" && entry.size > 0) return entry.size;
    try {
      const metadata = await fetchFilePreviewMetadata(entry.path, entry.version);
      if (typeof metadata.size === "number" && metadata.size >= 0) return metadata.size;
    } catch {
      // Best effort only for nicer progress display.
    }
    return null;
  };

  const collectZipBlob = async (path: string): Promise<Blob> => {
    const parts: BlobPart[] = [];
    await streamDirectoryZip(path, (chunk) => {
      parts.push(chunk.slice());
    });
    return new Blob(parts, { type: "application/zip" });
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

    const totalBytesHint = entry.is_dir ? null : await resolveSingleFileSizeHint(entry);

    if (!saveHandle) {
      await runAction("Download", async () => {
        const blob = entry.is_dir
          ? await collectZipBlob(entry.path)
          : await collectFileBlobStreaming(
            entry.path,
            entry.version,
            totalBytesHint,
          );
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
      await streamFileToHandle(saveHandle as SaveFileHandle, entry.path, entry.version, totalBytesHint);
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

  const streamMultiZipToHandle = async (
    handle: SaveFileHandle,
    entries: FileEntry[],
    archiveName: string,
  ): Promise<void> => {
    const writable = await handle.createWritable();
    let settled = false;
    let totalZipBytes = 0;
    let lastProgressAt = 0;
    const totalEntries = entries.length;
    let processedEntries = 0;
    let writeChain: Promise<void> = Promise.resolve();

    const rejectOnce = (reject: (reason?: unknown) => void, reason: unknown) => {
      if (settled) return;
      settled = true;
      reject(reason);
    };

    try {
      await new Promise<void>((resolve, reject) => {
        const zipper = new Zip((err, data, final) => {
          if (err) {
            rejectOnce(reject, err);
            return;
          }
          if (settled) return;
          if (data.length > 0) {
            writeChain = writeChain
              .then(async () => {
                await writable.write(data);
                totalZipBytes += data.length;
                const now = Date.now();
                if (now - lastProgressAt >= 250) {
                  setStatus(
                    `Writing ZIP ${formatBytes(totalZipBytes)} `
                    + `(${processedEntries}/${totalEntries})...`,
                  );
                  lastProgressAt = now;
                }
              })
              .catch((error) => {
                rejectOnce(reject, error);
              });
          }
          if (final) {
            writeChain
              .then(() => {
                if (settled) return;
                settled = true;
                resolve();
              })
              .catch((error) => {
                rejectOnce(reject, error);
              });
          }
        });

        void (async () => {
          try {
            const used = new Set<string>();
            for (let i = 0; i < entries.length; i += 1) {
              const entry = entries[i];
              const baseName = entry.is_dir ? suggestedZipFileName(entry.path) : entry.name;
              const uniqueName = makeUniqueArchiveName(baseName, used);
              setStatus(`Preparing ZIP ${i + 1}/${totalEntries}: ${uniqueName}...`);
              const zipEntry = new ZipPassThrough(uniqueName);
              zipper.add(zipEntry);
              if (entry.is_dir) {
                await streamDirectoryZip(entry.path, (chunk) => {
                  zipEntry.push(chunk, false);
                });
              } else {
                await streamFileDownload(entry.path, entry.version, (chunk) => {
                  zipEntry.push(chunk, false);
                });
              }
              zipEntry.push(new Uint8Array(0), true);
              processedEntries += 1;
              setStatus(`Preparing ZIP (${processedEntries}/${totalEntries})...`);
            }
            zipper.end();
          } catch (error) {
            rejectOnce(reject, error);
          }
        })();
      });
      await writable.close();
      setStatus(
        `Download done (${processedEntries}/${totalEntries} packed into ${archiveName}, `
        + `${formatBytes(totalZipBytes)})`,
      );
    } catch (error) {
      try {
        await writable.abort();
      } catch {
        // Ignore abort errors if writer is already closed.
      }
      throw error;
    }
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
      if (saveHandle) {
        await streamMultiZipToHandle(saveHandle, entries, archiveName);
        onRefresh();
        return;
      }

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

      const url = URL.createObjectURL(zipBlob);
      try {
        startBrowserDownload(url, archiveName);
      } finally {
        URL.revokeObjectURL(url);
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
    const refreshTimer = window.setInterval(() => {
      onRefresh();
    }, 2500);
    try {
      for (let i = 0; i < targets.length; i += 1) {
        const entry = targets[i];
        const mark: DeletingTarget = { path: entry.path, recursive: entry.is_dir };
        const statusLabel = entry.is_dir
          ? `Deleting folder${targets.length > 1 ? ` ${i + 1}/${targets.length}` : ""}: ${entry.path}…`
          : `${label} ${i + 1}/${targets.length}: ${entry.path}`;
        setStatus(statusLabel);
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
      window.clearInterval(refreshTimer);
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
