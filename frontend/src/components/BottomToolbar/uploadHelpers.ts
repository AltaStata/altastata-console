import {
  FOLDER_UPLOAD_CONCURRENCY_DEFAULT,
  FOLDER_UPLOAD_CONCURRENCY_MAX_SMALL_FILES,
} from "./constants";

export function chooseFolderUploadConcurrency(files: File[]): number {
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
}

/**
 * Walk parent prefixes of {@code targetPath} and register any missing pending
 * folders via {@code onAddPendingFolder}.
 */
export function enqueuePendingFoldersForTargetPath(
  targetPath: string,
  existing: ReadonlySet<string>,
  addedNow: Set<string>,
  onAddPendingFolder: (fullPath: string) => void,
): void {
  const normalized = targetPath.trim().replace(/\/+/g, "/");
  const lastSlash = normalized.lastIndexOf("/");
  if (lastSlash <= 0) return;
  let parent = normalized.slice(0, lastSlash);
  while (parent && parent !== "/") {
    if (!existing.has(parent) && !addedNow.has(parent)) {
      onAddPendingFolder(parent);
      addedNow.add(parent);
    }
    const idx = parent.lastIndexOf("/");
    parent = idx <= 0 ? "/" : parent.slice(0, idx);
  }
}
