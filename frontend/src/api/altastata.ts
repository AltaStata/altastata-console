import protobufjs, { type Type } from "protobufjs/dist/protobuf";
import type { AccountInfo, FileEntry, ListResponse, VersionEntry } from "@/types";

type Bytes = Uint8Array;

function extractMyUserFromProperties(text: string): string {
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key === "myuser") return value;
  }
  return "";
}

const configuredAccountId = (import.meta.env.VITE_ALTASTATA_ACCOUNT_ID as string | undefined)
  ?? "unknown-account";
const configuredUserProperties = ((import.meta.env.VITE_ALTASTATA_USER_PROPERTIES as string | undefined) ?? "")
  .replace(/\\n/g, "\n");
const configuredUserName = import.meta.env.VITE_ALTASTATA_GRPC_USER_NAME as string | undefined;
const derivedMyUserName = extractMyUserFromProperties(configuredUserProperties);

const CONFIG = {
  grpcBaseUrl: (import.meta.env.VITE_ALTASTATA_GRPC_BASE_URL as string | undefined)
    ?? "http://127.0.0.1:9877",
  accountId: configuredAccountId,
  // Same behavior as altastata-ui: prefer myuser from account properties.
  userName: derivedMyUserName
    || configuredUserName
    || configuredAccountId.split(".").at(-1)
    || "",
  accountPassword: (import.meta.env.VITE_ALTASTATA_PASSWORD as string | undefined)
    ?? "",
  userProperties: configuredUserProperties,
  privateKey: ((import.meta.env.VITE_ALTASTATA_PRIVATE_KEY as string | undefined) ?? "")
    .replace(/\\n/g, "\n"),
  autoBootstrap: (import.meta.env.VITE_ALTASTATA_AUTO_BOOTSTRAP as string | undefined)
    === "true",
  bootstrapMode: (import.meta.env.VITE_ALTASTATA_BOOTSTRAP_MODE as string | undefined)
    ?? "auto",
};

const PROTO_DEF = `
syntax = "proto3";
package altastata.v1;

message Empty {}
message User {
  string user_name = 1;
  bool initialized = 2;
  string access_key = 3;
}
message GetMyAccountRequest {}
message SetUserPropertiesRequest {
  string user_name = 1;
  string user_properties = 2;
}
message SetUserPropertiesResponse { bool success = 1; }
message SetPrivateKeyRequest {
  string user_name = 1;
  string private_key_encrypted = 2;
}
message SetPrivateKeyResponse { bool success = 1; }
message SetPasswordForUserRequest {
  string user_name = 1;
  string account_password = 2;
}
message SetPasswordForUserResponse {
  bool success = 1;
  string access_key = 2;
  string secret_key = 3;
}
message FileStatus {
  string file_path = 1;
  string operation_state = 2;
  string error = 3;
}
message ListVersionsRequest {
  string cloud_path_prefix = 1;
  bool including_subdirectories = 2;
  string time_interval_start = 3;
  string time_interval_end = 4;
}
message VersionEntry { repeated string versions = 1; }
message CreateFileRequest {
  string file_path = 1;
  bytes content = 2;
}
message CreateFileResponse { FileStatus status = 1; }
message GetBufferRequest {
  string file_path = 1;
  int64 snapshot_time = 2;
  int64 start_position = 3;
  int32 parallel_chunks = 4;
  int32 size = 5;
  bool trust_cached_size = 6;
}
message GetBufferResponse { bytes data = 1; }
message DeleteRequest {
  string cloud_path_prefix = 1;
  bool including_subdirectories = 2;
  string time_interval_start = 3;
  string time_interval_end = 4;
}
message DeleteResponse { repeated FileStatus statuses = 1; }
message ShareRequest {
  repeated string file_paths = 1;
  repeated string readers = 2;
}
message ShareResult { repeated FileStatus statuses = 1; }
message GetAttributesRequest {
  string file_path = 1;
  int64 snapshot_time = 2;
  repeated string names = 3;
}
message AttributeMap { map<string, string> attributes = 1; }
message ReadStreamRequest {
  string file_path = 1;
  int64 snapshot_time = 2;
  int64 start_position = 3;
  int32 parallel_chunks = 4;
  int32 chunk_size = 5;
}
message ReadStreamChunk { bytes data = 1; }
`;

const root = protobufjs.parse(PROTO_DEF).root;
const typeCache = new Map<string, Type>();
const REQUEST_TIMEOUT_MS = 15_000;
const LIST_DIR_FAST_TIMEOUT_MS = 5_000;

function T(name: string): Type {
  const cached = typeCache.get(name);
  if (cached) return cached;
  const resolved = root.lookupType(`altastata.v1.${name}`);
  typeCache.set(name, resolved);
  return resolved;
}

function baseUrl(): string {
  return CONFIG.grpcBaseUrl.trim().replace(/\/+$/, "");
}

function token(): string {
  const tokenUser = (activeAuthUserName || CONFIG.userName).trim();
  return `local-${tokenUser}`;
}

function frameMessage(bytes: Bytes): Bytes {
  const out = new Uint8Array(5 + bytes.length);
  out[0] = 0x00;
  const len = bytes.length >>> 0;
  out[1] = (len >>> 24) & 0xff;
  out[2] = (len >>> 16) & 0xff;
  out[3] = (len >>> 8) & 0xff;
  out[4] = len & 0xff;
  out.set(bytes, 5);
  return out;
}

function concat(a: Bytes, b: Bytes): Bytes {
  if (a.length === 0) return b;
  if (b.length === 0) return a;
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function extractFrames(buffer: Bytes): { frames: { trailer: boolean; payload: Bytes }[]; rest: Bytes } {
  const frames: { trailer: boolean; payload: Bytes }[] = [];
  let offset = 0;
  while (offset + 5 <= buffer.length) {
    const flags = buffer[offset];
    const len = (buffer[offset + 1] << 24)
      | (buffer[offset + 2] << 16)
      | (buffer[offset + 3] << 8)
      | buffer[offset + 4];
    offset += 5;
    if (len < 0 || offset + len > buffer.length) {
      offset -= 5;
      break;
    }
    frames.push({
      trailer: (flags & 0x80) !== 0,
      payload: buffer.slice(offset, offset + len),
    });
    offset += len;
  }
  return { frames, rest: buffer.slice(offset) };
}

function parseTrailers(payload: Bytes): Map<string, string> {
  const txt = new TextDecoder().decode(payload);
  const map = new Map<string, string>();
  for (const line of txt.split("\r\n")) {
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    map.set(line.slice(0, idx).trim().toLowerCase(), line.slice(idx + 1).trim());
  }
  return map;
}

function grpcHeaders(withAuth: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/grpc-web+proto",
    "x-grpc-web": "1",
    "x-user-agent": "altastata-console-web",
  };
  if (withAuth) headers.authorization = `Bearer ${token()}`;
  return headers;
}

function grpcMessageFromMap(map: Map<string, string>): string {
  const raw = map.get("grpc-message");
  if (!raw) return "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error(`Request timeout after ${timeoutMs} ms`);
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: number | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = window.setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) window.clearTimeout(timeout);
  }
}

function normalizePath(path: string): string {
  const trimmed = path.trim() || "/";
  if (trimmed === "/") return "/";
  const withLeading = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withLeading.replace(/\/+$/, "");
}

function parentPath(path: string): string {
  const normalized = normalizePath(path);
  if (normalized === "/") return "/";
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length <= 1) return "/";
  return `/${parts.slice(0, -1).join("/")}`;
}

function toCloudPath(path: string): string {
  return normalizePath(path).replace(/^\/+/, "");
}

function toApiPath(path: string): string {
  const stripped = path.trim().replace(/^\/+/, "").replace(/\/+$/, "");
  return stripped ? `/${stripped}` : "/";
}

function splitVersionedPath(cloudPath: string): { base: string; version: string | null } {
  const idx = cloudPath.indexOf("✹");
  if (idx < 0) return { base: cloudPath, version: null };
  return { base: cloudPath.slice(0, idx), version: cloudPath.slice(idx + 1) || null };
}

function parseVersionTimestamp(version: string | null): number | null {
  if (!version) return null;
  const parts = version.split("_");
  if (parts.length >= 2) {
    const ts = Number(parts[1]);
    if (!Number.isNaN(ts)) return ts;
  }
  const legacyTs = Number(parts[0]);
  if (!Number.isNaN(legacyTs)) return legacyTs;
  return null;
}

function parseVersionTag(version: string | null): string | null {
  if (!version) return null;
  const parts = version.split("_");
  if (parts.length >= 2 && parts[0]) return parts[0];
  return null;
}

function parseCreated(version: string | null): string | null {
  const ts = parseVersionTimestamp(version);
  if (ts == null) return null;
  const dt = new Date(ts);
  if (Number.isNaN(dt.getTime())) return null;
  const yyyy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const dd = String(dt.getDate()).padStart(2, "0");
  const hh = String(dt.getHours()).padStart(2, "0");
  const min = String(dt.getMinutes()).padStart(2, "0");
  const sec = String(dt.getSeconds()).padStart(2, "0");
  return `${yyyy}/${mm}/${dd} ${hh}:${min}:${sec}`;
}

function guessMime(name: string): string | null {
  const lower = name.toLowerCase();
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".csv")) return "text/csv";
  if (lower.endsWith(".txt") || lower.endsWith(".md") || lower.endsWith(".log")) return "text/plain";
  return null;
}

let authBootstrapDone = false;
let authBootstrapInFlight: Promise<void> | null = null;
let activeAuthUserName = CONFIG.userName;

function alternateAuthUserName(userName: string): string | null {
  const normalized = userName.trim();
  if (!normalized) return null;
  if (normalized.endsWith("_rsa")) {
    const plain = normalized.slice(0, -4);
    return plain || null;
  }
  return `${normalized}_rsa`;
}

async function grpcUnary(
  methodPath: string,
  reqTypeName: string,
  reqObj: object,
  respTypeName: string,
  withAuth: boolean,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<Record<string, unknown>> {
  const reqType = T(reqTypeName);
  const respType = T(respTypeName);
  const payload = reqType.encode(reqType.create(reqObj)).finish() as Bytes;
  const body = frameMessage(payload);
  const response = await fetchWithTimeout(`${baseUrl()}/${methodPath}`, {
    method: "POST",
    headers: grpcHeaders(withAuth),
    body: body as unknown as BodyInit,
  }, timeoutMs);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }
  const bytes = new Uint8Array(
    await withTimeout(
      response.arrayBuffer(),
      timeoutMs,
      `Timed out reading unary response for ${methodPath}`,
    ),
  );
  const parsed = extractFrames(bytes);
  let message: Uint8Array | null = null;
  let trailers = new Map<string, string>();
  for (const frame of parsed.frames) {
    if (frame.trailer) trailers = parseTrailers(frame.payload);
    else message = frame.payload;
  }
  const grpcStatus = trailers.get("grpc-status") ?? "0";
  if (grpcStatus !== "0") {
    throw new Error(`gRPC status=${grpcStatus} message=${grpcMessageFromMap(trailers)}`);
  }
  if (!message) return {};
  const decoded = respType.decode(message);
  return respType.toObject(decoded, {
    longs: Number,
    arrays: true,
    objects: true,
    defaults: false,
  }) as Record<string, unknown>;
}

async function grpcServerStream(
  methodPath: string,
  reqTypeName: string,
  reqObj: object,
  respTypeName: string,
  withAuth: boolean,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<Record<string, unknown>[]> {
  const reqType = T(reqTypeName);
  const respType = T(respTypeName);
  const payload = reqType.encode(reqType.create(reqObj)).finish() as Bytes;
  const body = frameMessage(payload);
  const response = await fetchWithTimeout(`${baseUrl()}/${methodPath}`, {
    method: "POST",
    headers: grpcHeaders(withAuth),
    body: body as unknown as BodyInit,
  }, timeoutMs);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }
  if (!response.body) {
    throw new Error("Missing response body for gRPC stream");
  }

  const reader = response.body.getReader();
  const out: Record<string, unknown>[] = [];
  let stash: Bytes = new Uint8Array(0);
  let trailers = new Map<string, string>();
  let sawTrailerFrame = false;

  let done = false;
  while (!done) {
    const chunk = await withTimeout(
      reader.read(),
      timeoutMs,
      `Timed out reading stream response for ${methodPath}`,
    );
    done = chunk.done;
    const value = chunk.value;
    if (value && value.length > 0) {
        stash = concat(stash, value as Uint8Array);
      const parsed = extractFrames(stash);
      stash = parsed.rest;
      for (const frame of parsed.frames) {
        if (frame.trailer) {
          sawTrailerFrame = true;
          trailers = parseTrailers(frame.payload);
          continue;
        }
        const decoded = respType.decode(frame.payload);
        out.push(
          respType.toObject(decoded, {
            longs: Number,
            arrays: true,
            objects: true,
            defaults: false,
          }) as Record<string, unknown>,
        );
      }
    }
  }

  if (!sawTrailerFrame) {
    const statusHeader = response.headers.get("grpc-status");
    if (statusHeader) {
      trailers = new Map([["grpc-status", statusHeader]]);
      const msg = response.headers.get("grpc-message");
      if (msg) trailers.set("grpc-message", msg);
    } else {
      throw new Error("Missing gRPC trailer frame in stream response");
    }
  }

  const grpcStatus = trailers.get("grpc-status") ?? "0";
  if (grpcStatus !== "0") {
    throw new Error(`gRPC status=${grpcStatus} message=${grpcMessageFromMap(trailers)}`);
  }
  return out;
}

async function ensureAuthBootstrap(): Promise<void> {
  if (authBootstrapDone) return;
  if (authBootstrapInFlight) {
    await authBootstrapInFlight;
    return;
  }
  authBootstrapInFlight = (async () => {
    const bootstrapUser = (activeAuthUserName || CONFIG.userName).trim();
    if (!bootstrapUser) throw new Error("No auth user configured");
    const hasFullBootstrapMaterial = Boolean(CONFIG.userProperties && CONFIG.privateKey);
    const fullBootstrap = (CONFIG.bootstrapMode === "full")
      || (CONFIG.bootstrapMode === "auto" && hasFullBootstrapMaterial);
    if (fullBootstrap) {
      await grpcUnary(
        "altastata.v1.UsersService/SetUserProperties",
        "SetUserPropertiesRequest",
        { userName: bootstrapUser, userProperties: CONFIG.userProperties },
        "SetUserPropertiesResponse",
        false,
      );
      await grpcUnary(
        "altastata.v1.UsersService/SetPrivateKey",
        "SetPrivateKeyRequest",
        { userName: bootstrapUser, privateKeyEncrypted: CONFIG.privateKey },
        "SetPrivateKeyResponse",
        false,
      );
    }
    await grpcUnary(
      "altastata.v1.UsersService/SetPasswordForUser",
      "SetPasswordForUserRequest",
      { userName: bootstrapUser, accountPassword: CONFIG.accountPassword },
      "SetPasswordForUserResponse",
      false,
    );
    authBootstrapDone = true;
  })();
  try {
    await authBootstrapInFlight;
  } finally {
    authBootstrapInFlight = null;
  }
}

async function maybeBootstrap(): Promise<void> {
  if (!CONFIG.autoBootstrap) return;
  await ensureAuthBootstrap();
}

function canBootstrapFromEnv(): boolean {
  return Boolean((activeAuthUserName || CONFIG.userName) && CONFIG.accountPassword);
}

async function withBootstrapRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/status=16|invalid token|timeout|timed out|failed to fetch/i.test(message)) {
      const altUser = alternateAuthUserName(activeAuthUserName);
      if (altUser && altUser !== activeAuthUserName) {
        activeAuthUserName = altUser;
        authBootstrapDone = false;
        return fn();
      }
    }
    const shouldRetry = canBootstrapFromEnv()
      && (/status=16|invalid token|failed to fetch/i.test(message));
    if (!shouldRetry) throw error;
    await ensureAuthBootstrap();
    return fn();
  }
}

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

function authHint(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (/status=16|invalid token/i.test(message)) {
    return new Error(
      `${message}. Provide VITE_ALTASTATA_USER_PROPERTIES and VITE_ALTASTATA_PRIVATE_KEY in frontend/.env.local, or bootstrap user with tests/js-grpc-ui first.`,
    );
  }
  return new Error(message);
}

export async function getAccount(): Promise<AccountInfo> {
  return {
    account_id: CONFIG.accountId,
    display_name: extractMyUserFromProperties(CONFIG.userProperties)
      || CONFIG.accountId.split(".").at(-1)
      || "unknown",
  };
}

export async function listDir(path: string): Promise<ListResponse> {
  try {
    const apiPath = normalizePath(path);
    const cloudPrefix = toCloudPath(apiPath);
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
    const snapshotTime = parseVersionTimestamp(version) ?? 0;
    const attrs = await withBootstrapRetry(() => getAttributes(cloudPath, ["size", "readers"], snapshotTime));
    const normalizedSize = (attrs.size ?? "").replace(/,/g, "").trim();
    const size = normalizedSize && /^\d+$/.test(normalizedSize) ? Number(normalizedSize) : null;
    const sizeRaw = attrs.size?.trim() ? attrs.size.trim() : null;
    const tag = parseVersionTag(version);
    const readersRaw = attrs.readers?.trim() ?? "";
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
    const resp = await withBootstrapRetry(() => grpcUnary(
        "altastata.v1.FileOpsService/CreateFile",
        "CreateFileRequest",
        { filePath: cloudPath, content },
        "CreateFileResponse",
        true,
    ));
    const status = resp.status as { error?: string; operationState?: string } | undefined;
    if (status?.error) {
      throw new Error(status.error);
    }
  } catch (error) {
    throw authHint(error);
  }
}

export async function deletePath(path: string): Promise<void> {
  try {
    await maybeBootstrap();
    const cloudPath = toCloudPath(path);
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

export async function downloadFile(path: string, version: string | null): Promise<Blob> {
  return fetchPreviewBlob(path, version, null);
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
