import { Zip, ZipPassThrough, zip } from "fflate";
import {
  downloadFile,
  fetchFilePreviewMetadata,
  makeUniqueArchiveName,
  streamDirectoryZip,
  streamFileDownload,
  suggestedZipFileName,
} from "@/api/altastata";
import type { FileEntry } from "@/types";
import { ZIP_WRITE_BACKPRESSURE_BYTES } from "./constants";
import { formatBytes } from "./formatBytes";
import type { SaveFileHandle } from "./types";

export type StatusSetter = (status: string) => void;

export function startBrowserDownload(
  href: string,
  downloadName: string,
  setStatus: StatusSetter,
): void {
  const link = document.createElement("a");
  link.href = href;
  link.download = downloadName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setStatus("Download started (watch browser downloads for completion)");
}

export async function streamZipToHandle(
  handle: SaveFileHandle,
  path: string,
  setStatus: StatusSetter,
): Promise<void> {
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
}

export async function streamFileToHandle(
  handle: SaveFileHandle,
  path: string,
  version: string | null,
  setStatus: StatusSetter,
  totalBytesHint: number | null = null,
  selectedEntries: FileEntry[] = [],
): Promise<void> {
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
}

export async function collectFileBlobStreaming(
  path: string,
  version: string | null,
  totalBytesHint: number | null,
  setStatus: StatusSetter,
): Promise<Blob> {
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
}

export async function resolveSingleFileSizeHint(entry: FileEntry): Promise<number | null> {
  if (entry.is_dir) return null;
  if (typeof entry.size === "number" && entry.size > 0) return entry.size;
  try {
    const metadata = await fetchFilePreviewMetadata(entry.path, entry.version);
    if (typeof metadata.size === "number" && metadata.size >= 0) return metadata.size;
  } catch {
    // Best effort only for nicer progress display.
  }
  return null;
}

export async function collectZipBlob(path: string): Promise<Blob> {
  const parts: BlobPart[] = [];
  await streamDirectoryZip(path, (chunk) => {
    parts.push(chunk.slice());
  });
  return new Blob(parts, { type: "application/zip" });
}

export async function downloadEntryAsBytes(entry: FileEntry): Promise<Uint8Array> {
  const blob = entry.is_dir
    ? await collectZipBlob(entry.path)
    : await downloadFile(entry.path, entry.version);
  return new Uint8Array(await blob.arrayBuffer());
}

export function buildZipArchive(files: Record<string, Uint8Array>): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    // Default level (6); covers text well, only mild slowdown on already-compressed media.
    zip(files, (err, data) => (err ? reject(err) : resolve(data)));
  });
}

export async function streamMultiZipToHandle(
  handle: SaveFileHandle,
  entries: FileEntry[],
  archiveName: string,
  setStatus: StatusSetter,
): Promise<void> {
  const writable = await handle.createWritable();
  let settled = false;
  let totalZipBytes = 0;
  let pendingWriteBytes = 0;
  let lastProgressAt = 0;
  const totalEntries = entries.length;
  let processedEntries = 0;
  let writeChain: Promise<void> = Promise.resolve();
  let writeError: unknown = null;

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
          const writeData = data.slice();
          pendingWriteBytes += writeData.length;
          writeChain = writeChain
            .then(async () => {
              await writable.write(writeData);
              totalZipBytes += writeData.length;
              pendingWriteBytes -= writeData.length;
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
              writeError = error;
              pendingWriteBytes = 0;
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
          const maybeDrainWrites = async () => {
            if (writeError) throw writeError;
            if (pendingWriteBytes >= ZIP_WRITE_BACKPRESSURE_BYTES) {
              await writeChain;
            }
            if (writeError) throw writeError;
          };
          const used = new Set<string>();
          for (let i = 0; i < entries.length; i += 1) {
            const entry = entries[i];
            const baseName = entry.is_dir ? suggestedZipFileName(entry.path) : entry.name;
            const uniqueName = makeUniqueArchiveName(baseName, used);
            setStatus(`Preparing ZIP ${i + 1}/${totalEntries}: ${uniqueName}...`);
            const zipEntry = new ZipPassThrough(uniqueName);
            zipper.add(zipEntry);
            if (entry.is_dir) {
              await streamDirectoryZip(entry.path, async (chunk) => {
                zipEntry.push(chunk, false);
                await maybeDrainWrites();
              });
            } else {
              await streamFileDownload(entry.path, entry.version, async (chunk) => {
                zipEntry.push(chunk, false);
                await maybeDrainWrites();
              });
            }
            zipEntry.push(new Uint8Array(0), true);
            await maybeDrainWrites();
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
}
