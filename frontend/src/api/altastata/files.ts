/**
 * File / directory / share / preview / download operations.
 */
import type { FileEntry, ListResponse, VersionEntry } from "@/types";
import { authHint, getAccount, maybeBootstrap, withBootstrapRetry } from "./auth";
import {
  guessMime,
  normalizePath,
  parentPath,
  parseCreated,
  parseVersionTag,
  parseVersionTimestamp,
  splitVersionedPath,
  toApiPath,
  toCloudPath
} from "./paths";
import {
  DELETE_REQUEST_TIMEOUT_MS,
  LIST_DIR_FAST_TIMEOUT_MS,
  STREAM_UPLOAD_CHUNK_FALLBACK_BYTES,
  STREAM_UPLOAD_THRESHOLD_BYTES,
  UPLOAD_REQUEST_TIMEOUT_MS,
  grpcServerStream,
  grpcServerStreamWithCallback,
  grpcUnary
} from "./transport";

async function getAttributes(
  filePath: string,
  names: string[],
  snapshotTime = 0,
): Promise<Record<string, string>> {
  const resp = await grpcUnary(
    "altastata.v1.AttributesService/GetAttributes",
    "GetAttributesRequest",
    { filePath, snapshotTime, names },
    "AttributeMap",
    true,
  );
  const attrs = resp.attributes;
  if (!attrs || typeof attrs !== "object") return {};
  return attrs as Record<string, string>;
}

export async function listDir(path: string): Promise<ListResponse> {
  try {
    const apiPath = normalizePath(path);
    const cloudPrefix = toCloudPath(apiPath);
    // eslint-disable-next-line no-console
    console.info("[altastata] listDir", { path: apiPath, cloudPrefix });
    const groups = await withBootstrapRetry(() => grpcServerStream(
      "altastata.v1.FileOpsService/ListVersions",
      "ListVersionsRequest",
      {
        cloudPathPrefix: cloudPrefix,
        // Mirror JavaFX listDirectory: immediate children only (Miller columns).
        includingSubdirectories: false,
        timeIntervalStart: "",
        timeIntervalEnd: "",
      },
      "VersionEntry",
      true,
      LIST_DIR_FAST_TIMEOUT_MS,
    ));

    const latestVersionByFile = new Map<string, string | null>();

    for (const group of groups) {
      const versionsRaw = group.versions;
      const versions = Array.isArray(versionsRaw) ? versionsRaw : [];
      for (const versionedPath of versions) {
        const raw = String(versionedPath ?? "");
        if (!raw) continue;
        const { base, version } = splitVersionedPath(raw);
        const filePath = base.replace(/^\/+/, "").replace(/\/+$/, "");
        if (!filePath) continue;
        const current = latestVersionByFile.get(filePath);
        if (!current || ((version ?? "") > current)) latestVersionByFile.set(filePath, version);
      }
    }

    const entries: FileEntry[] = [];
    const filePaths = [...latestVersionByFile.keys()].sort((a, b) => a.localeCompare(b));
    const fileEntries = filePaths.map((filePath): FileEntry => {
      const version = latestVersionByFile.get(filePath) ?? null;
      const name = filePath.split("/").at(-1) ?? filePath;
      const isDir = version == null;
      return {
        name,
        path: toApiPath(filePath),
        is_dir: isDir,
        size: null,
        created: isDir ? null : parseCreated(version),
        version: isDir ? null : version,
        readers: [],
        encrypted: false,
        mime_type: isDir ? null : guessMime(name),
      };
    });

    entries.push(...fileEntries);
    return { path: apiPath, entries };
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("[altastata] listDir failed", { path, error: String(error) });
    throw authHint(error);
  }
}

export async function listVersions(path: string): Promise<VersionEntry[]> {
  try {
    await maybeBootstrap();
    const cloudPath = toCloudPath(path);
    const groups = await withBootstrapRetry(() => grpcServerStream(
        "altastata.v1.FileOpsService/ListVersions",
        "ListVersionsRequest",
        {
          cloudPathPrefix: cloudPath,
          includingSubdirectories: true,
          timeIntervalStart: "",
          timeIntervalEnd: "",
        },
        "VersionEntry",
        true,
    ));
    const versionedPaths: string[] = [];
    for (const group of groups) {
      const versionsRaw = group.versions;
      if (!Array.isArray(versionsRaw)) continue;
      for (const versioned of versionsRaw) {
        versionedPaths.push(String(versioned ?? ""));
      }
    }
    const relevant = versionedPaths
      .map((item) => splitVersionedPath(item))
      .filter((item) => item.base === cloudPath && item.version);

    const out = await Promise.all(relevant.map(async ({ base, version }) => {
      const fullPath = `${base}✹${version}`;
      const attrs = await getAttributes(fullPath, ["size", "tag"]);
      return {
        version: version as string,
        created: parseCreated(version) ?? (version as string),
        size: attrs.size && /^\d+$/.test(attrs.size) ? Number(attrs.size) : 0,
        author: attrs.tag ?? null,
      };
    }));
    return out.sort((a, b) => a.version.localeCompare(b.version));
  } catch (error) {
    throw authHint(error);
  }
}

export async function fetchPreviewBlob(
  path: string,
  version: string | null,
  mimeType: string | null,
): Promise<Blob> {
  try {
    await maybeBootstrap();
    const cloudPath = toCloudPath(path);
    const versionedPath = version ? `${cloudPath}✹${version}` : cloudPath;
    const chunks = await withBootstrapRetry(() => grpcServerStream(
        "altastata.v1.FileOpsService/ReadStream",
        "ReadStreamRequest",
        {
          filePath: versionedPath,
          snapshotTime: 0,
          startPosition: 0,
          parallelChunks: 4,
          chunkSize: 256 * 1024,
        },
        "ReadStreamChunk",
        true,
    ));
    const bytesList: Uint8Array[] = [];
    let total = 0;
    for (const chunk of chunks) {
      const data = chunk.data;
      if (data instanceof Uint8Array) {
        bytesList.push(data);
        total += data.length;
      } else if (Array.isArray(data)) {
        const arr = new Uint8Array(data as number[]);
        bytesList.push(arr);
        total += arr.length;
      }
    }
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const bytes of bytesList) {
      merged.set(bytes, offset);
      offset += bytes.length;
    }
    return new Blob([merged], { type: mimeType ?? "application/octet-stream" });
  } catch (error) {
    throw authHint(error);
  }
}

export interface TextPreviewChunk {
  text: string;
  bytesRead: number;
  truncated: boolean;
}

export async function fetchTextPreviewChunk(
  path: string,
  version: string | null,
  maxBytes = 4 * 1024,
): Promise<TextPreviewChunk> {
  try {
    await maybeBootstrap();
    const cloudPath = toCloudPath(path);
    const versionedPath = version ? `${cloudPath}✹${version}` : cloudPath;
    const resp = await withBootstrapRetry(() => grpcUnary(
      "altastata.v1.FileOpsService/GetBuffer",
      "GetBufferRequest",
      {
        filePath: versionedPath,
        snapshotTime: 0,
        startPosition: 0,
        parallelChunks: 1,
        size: maxBytes,
        trustCachedSize: true,
      },
      "GetBufferResponse",
      true,
      15_000,
    ));
    const raw = resp.data;
    let firstChunk = new Uint8Array(0);
    if (raw instanceof Uint8Array) firstChunk = new Uint8Array(raw);
    else if (Array.isArray(raw)) firstChunk = new Uint8Array(raw as number[]);

    return {
      text: new TextDecoder().decode(firstChunk),
      bytesRead: firstChunk.length,
      truncated: firstChunk.length >= maxBytes,
    };
  } catch (error) {
    throw authHint(error);
  }
}

export interface FilePreviewMetadata {
  size: number | null;
  sizeRaw: string | null;
  tag: string | null;
  readers: string[];
}

export async function fetchFilePreviewMetadata(
  path: string,
  version: string | null,
): Promise<FilePreviewMetadata> {
  try {
    await maybeBootstrap();
    const cloudPath = toCloudPath(path);
    // We must send BOTH the version-suffixed path (`✹tag_createTime`) AND the
    // exact `snapshotTime`. Reasons:
    //   * AltaStataFileSystem.getFileAttributes() with a `✹`-suffixed path
    //     takes the "fast path" and parses a CloudFile that holds exactly one
    //     VersionAttributes (the one we asked for). It then calls
    //     SecureCloudFileSystemModel.getDataAttributesForCloudFile(cloudFile,
    //     createTime, names) which calls
    //     CloudFile.getBestMatchingVersionAttributes(long timestamp).
    //   * If we pass snapshotTime=0 the gRPC service converts it to a
    //     java.lang.Long null, and Scala's BoxesRunTime.unboxToLong(null)
    //     silently yields 0L. The Java method then compares each version's
    //     createTime (e.g. 1735834189000) against 0 and never matches, so it
    //     returns null. The Scala model treats that as "no version found" and
    //     substitutes the stub value "-1" for the "size" attribute — exactly
    //     the bug the preview pane used to render as "Size: -1".
    //   * Sending the version's createTime as snapshotTime makes the lookup
    //     deterministic and returns the real stored size.
    //
    // Readers are still queried on the bare path with snapshotTime=0 so we get
    // the LIVE ACL (what the user expects right after Share / Revoke). If we
    // pinned the readers query to the version's snapshot, sharing a file
    // post-creation would not show up here until a new version was written.
    const versionSnapshot = parseVersionTimestamp(version) ?? 0;
    const sizePath = version ? `${cloudPath}✹${version}` : cloudPath;
    const [sizeAttrs, readerAttrs] = await Promise.all([
      withBootstrapRetry(() => getAttributes(sizePath, ["size"], versionSnapshot)),
      withBootstrapRetry(() => getAttributes(cloudPath, ["readers"], 0)),
    ]);
    const normalizedSize = (sizeAttrs.size ?? "").replace(/,/g, "").trim();
    const size = normalizedSize && /^\d+$/.test(normalizedSize) ? Number(normalizedSize) : null;
    const sizeRaw = sizeAttrs.size?.trim() ? sizeAttrs.size.trim() : null;
    const tag = parseVersionTag(version);
    const readersRaw = readerAttrs.readers?.trim() ?? "";
    const readers = readersRaw
      ? readersRaw.split(/[;,\n]/).map((item) => item.trim()).filter(Boolean)
      : [];
    return { size, sizeRaw, tag, readers };
  } catch (error) {
    throw authHint(error);
  }
}

export async function uploadFile(targetPath: string, content: Uint8Array): Promise<void> {
  try {
    await maybeBootstrap();
    const cloudPath = toCloudPath(targetPath);
    // eslint-disable-next-line no-console
    console.info("[altastata] uploadFile", { targetPath, cloudPath, bytes: content.length });
    const resp = await withBootstrapRetry(() => grpcUnary(
        "altastata.v1.FileOpsService/CreateFile",
        "CreateFileRequest",
        { filePath: cloudPath, content },
        "CreateFileResponse",
        true,
        UPLOAD_REQUEST_TIMEOUT_MS,
    ));
    const status = resp.status as { error?: string; operationState?: string } | undefined;
    if (status?.error) {
      throw new Error(status.error);
    }
  } catch (error) {
    throw authHint(error);
  }
}

function resolveUploadChunkSize(serverChunkSize: unknown): number {
  const n = typeof serverChunkSize === "number" ? serverChunkSize : Number(serverChunkSize);
  if (!Number.isFinite(n) || n <= 0) return STREAM_UPLOAD_CHUNK_FALLBACK_BYTES;
  const normalized = Math.floor(n);
  if (normalized <= 0) return STREAM_UPLOAD_CHUNK_FALLBACK_BYTES;
  return Math.min(16 * 1024 * 1024, normalized);
}

/**
 * Browser-friendly upload that avoids reading the whole file into memory.
 * Small files keep the single-RPC CreateFile fast path; large files stream
 * through BeginUpload/UploadChunk/CompleteUpload with bounded chunk buffers.
 */
export async function uploadBrowserFile(
  targetPath: string,
  file: File,
  onProgress?: (bytesSent: number, totalBytes: number) => void,
): Promise<void> {
  const totalBytes = file.size || 0;
  onProgress?.(0, totalBytes);
  if (totalBytes <= STREAM_UPLOAD_THRESHOLD_BYTES) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    await uploadFile(targetPath, bytes);
    onProgress?.(bytes.length, totalBytes);
    return;
  }

  await maybeBootstrap();
  const cloudPath = toCloudPath(targetPath);
  let uploadId = "";
  try {
    const begin = await withBootstrapRetry(() => grpcUnary(
      "altastata.v1.FileOpsService/BeginUpload",
      "BeginUploadRequest",
      { cloudPath, totalSize: totalBytes },
      "BeginUploadResponse",
      true,
      UPLOAD_REQUEST_TIMEOUT_MS,
    ));
    uploadId = typeof begin.uploadId === "string" ? begin.uploadId : "";
    if (!uploadId) {
      throw new Error("BeginUpload response missing upload_id");
    }
    const chunkSize = resolveUploadChunkSize(begin.chunkSize);

    let offset = 0;
    while (offset < totalBytes) {
      const end = Math.min(offset + chunkSize, totalBytes);
      const chunk = new Uint8Array(await file.slice(offset, end).arrayBuffer());
      await withBootstrapRetry(() => grpcUnary(
        "altastata.v1.FileOpsService/UploadChunk",
        "UploadChunkRequest",
        { uploadId, offset, data: chunk },
        "UploadChunkResponse",
        true,
        UPLOAD_REQUEST_TIMEOUT_MS,
      ));
      offset = end;
      onProgress?.(offset, totalBytes);
    }

    const complete = await withBootstrapRetry(() => grpcUnary(
      "altastata.v1.FileOpsService/CompleteUpload",
      "CompleteUploadRequest",
      { uploadId },
      "CompleteUploadResponse",
      true,
      UPLOAD_REQUEST_TIMEOUT_MS,
    ));
    const status = complete.status as { error?: string } | undefined;
    if (status?.error) {
      throw new Error(status.error);
    }
  } catch (error) {
    if (uploadId) {
      try {
        await grpcUnary(
          "altastata.v1.FileOpsService/AbortUpload",
          "AbortUploadRequest",
          { uploadId },
          "AbortUploadResponse",
          true,
          UPLOAD_REQUEST_TIMEOUT_MS,
        );
      } catch {
        // Best effort cleanup; report original failure.
      }
    }
    throw authHint(error);
  }
}

export async function deletePath(path: string): Promise<void> {
  try {
    await maybeBootstrap();
    const cloudPath = toCloudPath(path);
    // eslint-disable-next-line no-console
    console.info("[altastata] deletePath", { path, cloudPath });
    const resp = await withBootstrapRetry(() => grpcUnary(
        "altastata.v1.FileOpsService/Delete",
        "DeleteRequest",
        {
          cloudPathPrefix: cloudPath,
          includingSubdirectories: true,
          timeIntervalStart: "",
          timeIntervalEnd: "",
        },
        "DeleteResponse",
        true,
        DELETE_REQUEST_TIMEOUT_MS,
    ));
    const statuses = Array.isArray(resp.statuses)
      ? (resp.statuses as { error?: string }[])
      : [];
    const failed = statuses.find((item) => item.error && item.error.trim().length > 0);
    if (failed?.error) {
      throw new Error(failed.error);
    }
  } catch (error) {
    throw authHint(error);
  }
}

export async function sharePaths(paths: string[], readers: string[]): Promise<void> {
  try {
    await maybeBootstrap();
    const cloudPaths = paths.map((p) => toCloudPath(p)).filter(Boolean);
    if (cloudPaths.length === 0) return;
    // eslint-disable-next-line no-console
    console.info("[altastata] sharePaths", { paths: cloudPaths, readers });
    const resp = await withBootstrapRetry(() => grpcUnary(
        "altastata.v1.SharingService/Share",
        "ShareRequest",
        { filePaths: cloudPaths, readers },
        "ShareResult",
        true,
    ));
    const statuses = Array.isArray(resp.statuses)
      ? (resp.statuses as { error?: string }[])
      : [];
    const failed = statuses.find((item) => item.error && item.error.trim().length > 0);
    if (failed?.error) {
      throw new Error(failed.error);
    }
  } catch (error) {
    throw authHint(error);
  }
}

export async function revokePaths(paths: string[], readers: string[]): Promise<void> {
  try {
    await maybeBootstrap();
    const cloudPaths = paths.map((p) => toCloudPath(p)).filter(Boolean);
    if (cloudPaths.length === 0) return;
    // eslint-disable-next-line no-console
    console.info("[altastata] revokePaths", { paths: cloudPaths, readers });
    const resp = await withBootstrapRetry(() => grpcUnary(
        "altastata.v1.SharingService/Revoke",
        "RevokeRequest",
        { filePaths: cloudPaths, readers },
        "RevokeResult",
        true,
    ));
    const statuses = Array.isArray(resp.statuses)
      ? (resp.statuses as { error?: string }[])
      : [];
    const failed = statuses.find((item) => item.error && item.error.trim().length > 0);
    if (failed?.error) {
      throw new Error(failed.error);
    }
  } catch (error) {
    throw authHint(error);
  }
}

/**
 * Returns the user-supplied list of known accounts (skipping the current
 * user and the custodian) — the set the JavaFX UI shows in its share /
 * revoke autocomplete combobox.
 */
export async function listKnownUsers(): Promise<string[]> {
  try {
    await maybeBootstrap();
    const messages = await withBootstrapRetry(() => grpcServerStream(
      "altastata.v1.UsersService/ListUsers",
      "Empty",
      {},
      "UserSummary",
      true,
    ));
    const myAccount = await getAccount().catch(() => null);
    const me = myAccount?.account_id?.split(".").at(-1) ?? null;
    const seen = new Set<string>();
    const users: string[] = [];
    for (const msg of messages) {
      const name = typeof msg.userName === "string" ? msg.userName : "";
      if (!name || seen.has(name)) continue;
      if (name === me) continue;
      if (name.toLowerCase() === "custodian") continue;
      seen.add(name);
      users.push(name);
    }
    users.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
    return users;
  } catch (error) {
    throw authHint(error);
  }
}

export async function downloadFile(path: string, version: string | null): Promise<Blob> {
  // eslint-disable-next-line no-console
  console.info("[altastata] downloadFile", { path, version });
  return fetchPreviewBlob(path, version, null);
}

const ZIP_STREAM_IDLE_TIMEOUT_MS = 60_000;

export interface StreamDirectoryZipOptions {
  signal?: AbortSignal;
  idleTimeoutMs?: number;
}

export async function streamDirectoryZip(
  path: string,
  onChunk: (chunk: Uint8Array) => void | Promise<void>,
  options: StreamDirectoryZipOptions = {},
): Promise<void> {
  try {
    await maybeBootstrap();
    const cloudPath = toCloudPath(path);
    // eslint-disable-next-line no-console
    console.info("[altastata] streamDirectoryZip", { path, cloudPath });
    await withBootstrapRetry(() => grpcServerStreamWithCallback(
      "altastata.v1.FileOpsService/DownloadDirectoryAsZip",
      "DownloadDirectoryAsZipRequest",
      { cloudPathPrefix: cloudPath },
      "DownloadDirectoryAsZipChunk",
      true,
      async (msg) => {
        const data = msg.data;
        if (data instanceof Uint8Array) {
          if (data.length > 0) await onChunk(data);
        } else if (Array.isArray(data)) {
          const arr = new Uint8Array(data as number[]);
          if (arr.length > 0) await onChunk(arr);
        }
      },
      {
        idleTimeoutMs: options.idleTimeoutMs ?? ZIP_STREAM_IDLE_TIMEOUT_MS,
        signal: options.signal,
      },
    ));
  } catch (error) {
    throw authHint(error);
  }
}

export async function streamFileDownload(
  path: string,
  version: string | null,
  onChunk: (chunk: Uint8Array) => void | Promise<void>,
  options: StreamDirectoryZipOptions = {},
): Promise<void> {
  try {
    await maybeBootstrap();
    const cloudPath = toCloudPath(path);
    const versionedPath = version ? `${cloudPath}✹${version}` : cloudPath;
    await withBootstrapRetry(() => grpcServerStreamWithCallback(
      "altastata.v1.FileOpsService/ReadStream",
      "ReadStreamRequest",
      {
        filePath: versionedPath,
        snapshotTime: 0,
        startPosition: 0,
        parallelChunks: 4,
        chunkSize: 256 * 1024,
      },
      "ReadStreamChunk",
      true,
      async (msg) => {
        const data = msg.data;
        if (data instanceof Uint8Array) {
          if (data.length > 0) await onChunk(data);
        } else if (Array.isArray(data)) {
          const arr = new Uint8Array(data as number[]);
          if (arr.length > 0) await onChunk(arr);
        }
      },
      {
        idleTimeoutMs: options.idleTimeoutMs ?? ZIP_STREAM_IDLE_TIMEOUT_MS,
        signal: options.signal,
      },
    ));
  } catch (error) {
    throw authHint(error);
  }
}

export function suggestedZipFileName(path: string): string {
  const normalized = normalizePath(path);
  if (normalized === "/") return "root.zip";
  const segments = normalized.split("/").filter(Boolean);
  const last = segments[segments.length - 1] || "root";
  return `${last}.zip`;
}

export function resolveUploadTargetPath(
  fileName: string,
  selectedEntry: FileEntry | null,
  activePath: string,
): string {
  if (selectedEntry?.is_dir) {
    return `${normalizePath(selectedEntry.path)}/${fileName}`.replace("//", "/");
  }
  const baseDir = selectedEntry ? parentPath(selectedEntry.path) : normalizePath(activePath);
  return `${normalizePath(baseDir)}/${fileName}`.replace("//", "/");
}

/**
 * Returns `name` if it is not present in `used`, otherwise appends a numeric
 * suffix before the extension (e.g. `report (2).pdf`) until it is unique.
 * Mutates `used` to claim the resulting name.
 */
export function makeUniqueArchiveName(name: string, used: Set<string>): string {
  if (!used.has(name)) {
    used.add(name);
    return name;
  }
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let i = 2; i < 10_000; i += 1) {
    const candidate = `${stem} (${i})${ext}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
  // Pathological fallback — should never happen in practice.
  const fallback = `${stem}-${Date.now()}${ext}`;
  used.add(fallback);
  return fallback;
}

/**
 * Suggests a name for a multi-item ZIP archive. If every selected entry
 * shares the same parent directory (and that parent is not root), the parent
 * name is reused; otherwise a generic fallback is returned.
 */
export function suggestMultiZipName(entries: ReadonlyArray<{ path: string }>): string {
  if (entries.length === 0) return "altastata-download.zip";
  const parents = entries.map((e) => parentPath(e.path));
  const first = parents[0];
  const allSame = parents.every((p) => p === first);
  if (allSame && first && first !== "/") {
    const last = first.split("/").filter(Boolean).pop();
    if (last) return `${last}.zip`;
  }
  return `altastata-download-${entries.length}-items.zip`;
}

