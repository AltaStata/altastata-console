import {
  Box,
  Divider,
  IconButton,
  InputBase,
  LinearProgress,
  Stack,
  Tooltip,
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
import {
  deletePath,
  listKnownUsers,
  makeUniqueArchiveName,
  resolveUploadTargetPath,
  revokePaths,
  runWithConcurrency,
  sharePaths,
  suggestMultiZipName,
  suggestedZipFileName,
  uploadBrowserFile,
} from "@/api/altastata";
import type { FileEntry } from "@/types";
import type { DeletingTarget } from "@/utils/deletingTargets";
import AccessDialog from "./AccessDialog";
import NewFolderDialog from "./NewFolderDialog";
import {
  buildZipArchive,
  collectFileBlobStreaming,
  collectZipBlob,
  downloadEntryAsBytes,
  resolveSingleFileSizeHint,
  startBrowserDownload,
  streamFileToHandle,
  streamMultiZipToHandle,
  streamZipToHandle,
} from "./downloadPipeline";
import { formatBytes } from "./formatBytes";
import type {
  AccessDialogMode,
  AccessDialogState,
  BottomToolbarProps,
  NewFolderDialogState,
  SaveFileHandle,
  SavePickerWindow,
} from "./types";
import {
  chooseFolderUploadConcurrency,
  enqueuePendingFoldersForTargetPath,
} from "./uploadHelpers";

export type { BottomToolbarProps };

export default function BottomToolbar({
  selectedEntries,
  activePath,
  pendingFolderPaths,
  onAddPendingFolder,
  onRemovePendingFolders,
  onMarkPathsDeleting,
  onUnmarkPathsDeleting,
  onRefresh,
}: BottomToolbarProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string>("Ready");
  const [filterText, setFilterText] = useState("");
  const [newFolderDialog, setNewFolderDialog] = useState<NewFolderDialogState | null>(null);
  const [accessDialog, setAccessDialog] = useState<AccessDialogState | null>(null);

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
    const addedPendingFolders = new Set<string>();
    const existingPendingFolders = new Set(pendingFolderPaths ?? []);
    setStatus(`Uploading folder (0/${files.length}, ×${folderUploadConcurrency})...`);
    try {
      // Show the folder tree immediately while files are still uploading.
      for (const file of files) {
        const relativePath = file.webkitRelativePath || file.name;
        const targetPath = resolveUploadTargetPath(relativePath, uploadAnchor, activePath);
        if (onAddPendingFolder) {
          enqueuePendingFoldersForTargetPath(
            targetPath,
            existingPendingFolders,
            addedPendingFolders,
            onAddPendingFolder,
          );
        }
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
      if (addedPendingFolders.size > 0) {
        onRemovePendingFolders?.([...addedPendingFolders]);
      }
      const detail = error instanceof Error ? error.message : String(error);
      setStatus(`Folder upload failed after ${completed}/${files.length}: ${detail}`);
    } finally {
      setBusy(false);
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

    const totalBytesHint = entry.is_dir ? null : await resolveSingleFileSizeHint(entry);

    if (!saveHandle) {
      await runAction("Download", async () => {
        const blob = entry.is_dir
          ? await collectZipBlob(entry.path)
          : await collectFileBlobStreaming(
            entry.path,
            entry.version,
            totalBytesHint,
            setStatus,
          );
        const url = URL.createObjectURL(blob);
        try {
          startBrowserDownload(url, downloadName, setStatus);
        } finally {
          URL.revokeObjectURL(url);
        }
      });
      return;
    }

    await runAction("Download", async () => {
      if (entry.is_dir) {
        await streamZipToHandle(saveHandle as SaveFileHandle, entry.path, setStatus);
        return;
      }
      await streamFileToHandle(
        saveHandle as SaveFileHandle,
        entry.path,
        entry.version,
        setStatus,
        totalBytesHint,
        selectedEntries,
      );
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
      if (saveHandle) {
        await streamMultiZipToHandle(saveHandle, entries, archiveName, setStatus);
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
        startBrowserDownload(url, archiveName, setStatus);
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

      <NewFolderDialog
        open={newFolderDialog !== null}
        activePath={activePath}
        state={newFolderDialog}
        onClose={closeNewFolderDialog}
        onChange={setNewFolderDialog}
        onSubmit={submitNewFolderDialog}
      />

      <AccessDialog
        state={accessDialog}
        onClose={closeAccessDialog}
        onChange={setAccessDialog}
        onSubmit={() => void submitAccessDialog()}
      />
    </Box>
  );
}
