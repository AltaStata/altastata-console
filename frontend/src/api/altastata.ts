import protobufjs, { type Type } from "protobufjs/dist/protobuf";
import type { AccountInfo, FileEntry, ListResponse, VersionEntry } from "@/types";
import { extractMyUserFromProperties, getRuntimeSettings } from "@/config/runtimeSettings";

type Bytes = Uint8Array;

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
// Wire-compatible with google.protobuf.Timestamp (same field numbers); we
// inline it because protobufjs.parse() of a single-string proto definition
// cannot resolve cross-package imports.
message Timestamp {
  int64 seconds = 1;
  int32 nanos   = 2;
}
message LoginRequest {
  string user_name        = 1;
  string account_password = 2;
  string client_hint      = 3;
}
message LoginResponse {
  string    session_token = 1;
  Timestamp expires_at    = 2;
  string    access_key    = 3;
}
message LogoutRequest {}
message LogoutResponse {}
message RefreshRequest {}
message RefreshResponse {
  Timestamp expires_at = 1;
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
message RevokeRequest {
  repeated string file_paths = 1;
  repeated string readers = 2;
}
message RevokeResult { repeated FileStatus statuses = 1; }
message UserSummary {
  string user_name = 1;
  bool initialized = 2;
}
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
message DownloadDirectoryAsZipRequest {
  string cloud_path_prefix = 1;
}
message DownloadDirectoryAsZipChunk { bytes data = 1; }
message SubscribeRequest {}
message EventMessage {
  string event_name = 1;
  string data = 2;
}
message WatchRequest {
  uint64 since_sequence = 1;
}
message FileSharedEvent {
  string file_id   = 1;
  string file_path = 2;
  string shared_by = 3;
}
message FileUnsharedEvent {
  string file_id     = 1;
  string unshared_by = 2;
}
message SessionRevokedEvent {
  enum Reason {
    LOGOUT  = 0;
    EXPIRED = 1;
    ADMIN   = 2;
  }
  Reason reason = 1;
}
message EventGapEvent {
  uint64 server_oldest_sequence = 1;
}
message Event {
  uint64    sequence            = 1;
  Timestamp occurred_at         = 2;
  string    origin_session_hash = 3;
  oneof payload {
    FileSharedEvent     file_shared     = 10;
    FileUnsharedEvent   file_unshared   = 11;
    SessionRevokedEvent session_revoked = 99;
    EventGapEvent       event_gap       = 100;
  }
}
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
  const config = getRuntimeSettings();
  return config.grpcBaseUrl.trim().replace(/\/+$/, "");
}

/**
 * Returns the Bearer-eligible session token, or {@code ""} when no Login has
 * succeeded yet for the current settings. {@link grpcHeaders} omits the
 * Authorization header on empty token; the gateway then returns
 * {@code UNAUTHENTICATED} and {@link withBootstrapRetry} kicks in to run a
 * fresh {@link ensureAuthBootstrap}.
 *
 * <p>The previous implementation returned {@code "local-<userName>"} — a
 * trivially-forgeable identity that any client on the same network could
 * impersonate. That format is still accepted by the gateway for one
 * deprecation cycle (it logs a one-shot WARN; see
 * {@code SESSION_AND_EVENTS_DESIGN.md §11.1}), but the frontend has now
 * migrated to {@code sess-<random>} server-issued tokens.
 */
function token(): string {
  return sessionToken;
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
  if (withAuth) {
    const t = token();
    if (t) headers.authorization = `Bearer ${t}`;
    // Empty token => no Authorization header. Gateway returns
    // UNAUTHENTICATED (status=16) and withBootstrapRetry will trigger a fresh
    // Login. We deliberately do not send "Bearer " (empty) — the
    // GrpcGatewayAuthInterceptor would treat it as a malformed token and the
    // log line would be confusing.
  }
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
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (lower.endsWith(".mp4") || lower.endsWith(".m4v")) return "video/mp4";
  if (lower.endsWith(".mov")) return "video/quicktime";
  if (lower.endsWith(".webm")) return "video/webm";
  if (lower.endsWith(".ogv")) return "video/ogg";
  if (lower.endsWith(".mp3")) return "audio/mpeg";
  if (lower.endsWith(".wav")) return "audio/wav";
  if (lower.endsWith(".ogg") || lower.endsWith(".oga")) return "audio/ogg";
  if (lower.endsWith(".m4a")) return "audio/mp4";
  if (lower.endsWith(".csv")) return "text/csv";
  if (lower.endsWith(".txt") || lower.endsWith(".md") || lower.endsWith(".log")) return "text/plain";
  return null;
}

/**
 * Run async `worker` over `items` with bounded concurrency. The first failure
 * cancels future task starts, in-flight workers continue but no new ones are
 * spawned, and the original error is rethrown after all started workers have
 * settled. Used by the folder upload flow to overlap CreateFile RPCs while
 * preserving the existing "stop on first error" semantics.
 */
export async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  const cap = Math.max(1, Math.min(limit, items.length));
  let nextIndex = 0;
  let aborted = false;
  let firstError: unknown = null;
  const runners: Promise<void>[] = [];
  for (let i = 0; i < cap; i += 1) {
    runners.push((async () => {
      while (!aborted) {
        const idx = nextIndex;
        nextIndex += 1;
        if (idx >= items.length) return;
        try {
          await worker(items[idx], idx);
        } catch (error) {
          if (!aborted) {
            aborted = true;
            firstError = error;
          }
          return;
        }
      }
    })());
  }
  await Promise.all(runners);
  if (firstError) throw firstError;
}

let authBootstrapDone = false;
let authBootstrapInFlight: Promise<void> | null = null;

/**
 * Authenticated session state. Populated by {@link ensureAuthBootstrap} on a
 * successful {@code AuthService/Login} and cleared by
 * {@link applyRuntimeSettings} (settings changed) or {@link logout} (explicit).
 *
 * Lives in module scope, never persisted: a page reload returns to the
 * "no session" state and the user has to re-enter their password — same
 * security posture as the legacy {@code local-<userName>} flow had with
 * {@code accountPassword} (which has always been in-memory only).
 */
let sessionToken = "";
let sessionUserName = getRuntimeSettings().userName;
let sessionExpiresAtMs: number | null = null;

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
  let sawTrailerFrame = false;
  for (const frame of parsed.frames) {
    if (frame.trailer) {
      sawTrailerFrame = true;
      trailers = parseTrailers(frame.payload);
    } else {
      message = frame.payload;
    }
  }
  if (!sawTrailerFrame) {
    // Armeria writes grpc-status into HTTP headers (instead of a trailer
    // frame) when responseObserver.onError fires before any onNext, which
    // is what AuthService.Login does for wrong-password / missing-args.
    // Without this fallback the unary path silently treats those as
    // status=0 with an empty body, which then surfaces as a confusing
    // "Login response missing session_token" further up the stack.
    const statusHeader = response.headers.get("grpc-status");
    if (statusHeader) {
      trailers = new Map([["grpc-status", statusHeader]]);
      const msg = response.headers.get("grpc-message");
      if (msg) trailers.set("grpc-message", msg);
    }
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

async function grpcServerStreamWithCallback(
  methodPath: string,
  reqTypeName: string,
  reqObj: object,
  respTypeName: string,
  withAuth: boolean,
  onMessage: (msg: Record<string, unknown>) => void | Promise<void>,
  options: { idleTimeoutMs?: number; signal?: AbortSignal } = {},
): Promise<void> {
  const idleTimeoutMs = options.idleTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const reqType = T(reqTypeName);
  const respType = T(respTypeName);
  const payload = reqType.encode(reqType.create(reqObj)).finish() as Bytes;
  const body = frameMessage(payload);
  const controller = new AbortController();
  const onParentAbort = () => controller.abort();
  if (options.signal) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener("abort", onParentAbort, { once: true });
  }
  let response: Response;
  try {
    response = await fetch(`${baseUrl()}/${methodPath}`, {
      method: "POST",
      headers: grpcHeaders(withAuth),
      body: body as unknown as BodyInit,
      signal: controller.signal,
    });
  } finally {
    if (options.signal) options.signal.removeEventListener("abort", onParentAbort);
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }
  if (!response.body) {
    throw new Error("Missing response body for gRPC stream");
  }

  const reader = response.body.getReader();
  let stash: Bytes = new Uint8Array(0);
  let trailers = new Map<string, string>();
  let sawTrailerFrame = false;

  let done = false;
  while (!done) {
    const chunk = await withTimeout(
      reader.read(),
      idleTimeoutMs,
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
        const obj = respType.toObject(decoded, {
          longs: Number,
          arrays: true,
          objects: true,
          defaults: false,
        }) as Record<string, unknown>;
        await onMessage(obj);
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

/**
 * Issues an {@code AuthService/Login} RPC with the supplied credentials and
 * stores the returned {@code sess-<random>} token in module state. Throws if
 * the response is missing {@code session_token} or if the gateway rejected the
 * call (typically {@code UNAUTHENTICATED} with {@code "Invalid credentials"}
 * for a wrong password, {@code FAILED_PRECONDITION} when SetUserProperties /
 * SetPrivateKey have not been called yet for this user).
 */
async function performLogin(userName: string, accountPassword: string): Promise<void> {
  let resp: Record<string, unknown>;
  try {
    resp = await grpcUnary(
      "altastata.v1.AuthService/Login",
      "LoginRequest",
      {
        userName,
        accountPassword,
        clientHint: "altastata-console-web",
      },
      "LoginResponse",
      false,
    );
  } catch (error) {
    // Translate the transport-level "gRPC status=16 message=Invalid
    // credentials" into a user-facing "Invalid password" while still
    // letting withBootstrapRetry / isInvalidCredentialsError detect it via
    // the InvalidPasswordError class.
    if (isInvalidCredentialsError(error)) throw new InvalidPasswordError();
    throw error;
  }
  const newToken = typeof resp.sessionToken === "string" ? resp.sessionToken : "";
  if (!newToken) {
    throw new Error("Login response missing session_token");
  }
  sessionToken = newToken;
  sessionUserName = userName;
  const expiresAt = resp.expiresAt as { seconds?: number } | undefined;
  sessionExpiresAtMs = typeof expiresAt?.seconds === "number" ? expiresAt.seconds * 1000 : null;
}

async function ensureAuthBootstrap(): Promise<void> {
  if (authBootstrapDone) return;
  if (authBootstrapInFlight) {
    await authBootstrapInFlight;
    return;
  }
  authBootstrapInFlight = (async () => {
    const config = getRuntimeSettings();
    const bootstrapUser = (sessionUserName || config.userName).trim();
    if (!bootstrapUser) throw new Error("No auth user configured");
    const hasFullBootstrapMaterial = Boolean(config.userProperties && config.privateKey);
    const fullBootstrap = (config.bootstrapMode === "full")
      || (config.bootstrapMode === "auto" && hasFullBootstrapMaterial);
    // eslint-disable-next-line no-console
    console.info("[altastata] bootstrap start", { user: bootstrapUser, fullBootstrap });
    if (fullBootstrap) {
      await grpcUnary(
        "altastata.v1.UsersService/SetUserProperties",
        "SetUserPropertiesRequest",
        { userName: bootstrapUser, userProperties: config.userProperties },
        "SetUserPropertiesResponse",
        false,
      );
      await grpcUnary(
        "altastata.v1.UsersService/SetPrivateKey",
        "SetPrivateKeyRequest",
        { userName: bootstrapUser, privateKeyEncrypted: config.privateKey },
        "SetPrivateKeyResponse",
        false,
      );
    }
    // Replaces the legacy SetPasswordForUser RPC. The gateway issues a fresh
    // sess-<random> token via SessionRegistry; the previous local-<userName>
    // formula is gone (see SESSION_AND_EVENTS_DESIGN.md §5).
    await performLogin(bootstrapUser, config.accountPassword);
    authBootstrapDone = true;
    // eslint-disable-next-line no-console
    console.info("[altastata] bootstrap done", {
      user: bootstrapUser,
      hasSessionToken: Boolean(sessionToken),
      expiresAtMs: sessionExpiresAtMs,
    });
  })();
  try {
    await authBootstrapInFlight;
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("[altastata] bootstrap failed", String(error));
    throw error;
  } finally {
    authBootstrapInFlight = null;
  }
}

async function maybeBootstrap(): Promise<void> {
  if (!getRuntimeSettings().autoBootstrap) return;
  await ensureAuthBootstrap();
}

function canBootstrapFromEnv(): boolean {
  const config = getRuntimeSettings();
  return Boolean((sessionUserName || config.userName) && config.accountPassword);
}

function isPasswordBootstrapError(message: string): boolean {
  return /password is null|call setpassword first|set password for user failed|account_password cannot be empty|user_name and account_password are required/i.test(message);
}

/**
 * Thrown by {@link performLogin} when {@code AuthService/Login} comes back
 * {@code UNAUTHENTICATED} with description {@code "Invalid credentials"}
 * (i.e. wrong password). We expose this as a typed error so the UI can show
 * a clean "Invalid password" message instead of the raw transport-level
 * {@code "gRPC status=16 message=Invalid credentials"}, while
 * {@link withBootstrapRetry} can still detect and short-circuit on it via
 * {@link isInvalidCredentialsError}.
 */
export class InvalidPasswordError extends Error {
  constructor(message = "Invalid password") {
    super(message);
    this.name = "InvalidPasswordError";
  }
}

/**
 * Recognises the gateway's response to a wrong password on
 * {@code AuthService/Login}: {@code UNAUTHENTICATED} (status=16) with the
 * fixed description {@code "Invalid credentials"}. We detect this so
 * {@link withBootstrapRetry} can skip its retry loop in this case — running
 * Login twice with the same wrong password is just noise (and an extra
 * audit-log line on the server) when we know it cannot succeed.
 *
 * Accepts both the typed {@link InvalidPasswordError} thrown by
 * {@link performLogin} and the raw {@code Error} from {@link grpcUnary}, so
 * callers don't have to know which layer the error came from.
 */
function isInvalidCredentialsError(error: unknown): boolean {
  if (error instanceof InvalidPasswordError) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /\bstatus=16\b.*invalid credentials/i.test(message);
}

/**
 * Returns true when a gRPC error indicates the user has not finished setting
 * up authentication for this AltaStata account in the current session — most
 * commonly because the password is missing in Settings, the supplied password
 * is wrong, or a stale token has been rejected by the gateway. In all of
 * these cases the remediation is the same (open Settings → fill / verify
 * password → Save & Run Bootstrap), so the UI uses this single signal to
 * decide whether to show the "set your password" empty state instead of a
 * generic error.
 *
 * Matches:
 *   - `gRPC status=9 ...` (FAILED_PRECONDITION; AltaStata raises this from
 *     listDir / read / etc. when the password has never been set, and from
 *     AuthService/Login when SetUserProperties / SetPrivateKey have not run
 *     yet for this user)
 *   - `gRPC status=16 ...` / "Invalid token" / "Invalid credentials"
 *     (UNAUTHENTICATED; raised when no token is presented, the token has
 *     expired/changed, or the password supplied to Login was wrong)
 *   - "User is not initialized" / "User has not been initialized"
 *   - The same patterns recognised by withBootstrapRetry's password fallback
 *     (Password is null, call setPassword first, account_password cannot be
 *     empty, user_name and account_password are required).
 */
export function isUserNotInitializedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /\bstatus=9\b/i.test(message)
    || /\bstatus=16\b/i.test(message)
    || /invalid token/i.test(message)
    || /user (?:is|has) not (?:been )?initialized/i.test(message)
    || isPasswordBootstrapError(message)
  );
}

/**
 * Wraps a single gRPC call with one transparent (re-)bootstrap retry. Used to
 * make the UI self-healing across:
 *   - Java backend restarts (in-memory user registry is empty, so the first
 *     call after restart is rejected with status=16 / "Invalid token").
 *   - status=9 / "User is not initialized" (user is in the registry but
 *     AuthService/Login has not been called yet, so AltaStataFileSystem is
 *     null).
 *   - Various "password is null" / "call setPassword first" variants that the
 *     gateway raises when state is partial.
 *
 * The retry strategy is deliberately simple: if the current Settings provide
 * enough material to bootstrap, force a fresh ensureAuthBootstrap() (which
 * re-runs SetUserProperties + SetPrivateKey + AuthService/Login for the
 * configured user) and retry the call once. We do not silently switch to an
 * "alternate" user name — that previous heuristic ended up registering
 * bob123_rsa and friends with half-initialised state and confused everyone.
 *
 * <p>One narrow exception: a wrong password from AuthService/Login surfaces as
 * {@code status=16 / "Invalid credentials"}; retrying that is pointless and
 * just doubles the failure rate the user sees. We bubble it directly. See
 * {@link isInvalidCredentialsError}.
 */
async function withBootstrapRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (isInvalidCredentialsError(error)) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    const shouldRetry = canBootstrapFromEnv()
      && (
        /\bstatus=16\b/i.test(message)
        || /\bstatus=9\b/i.test(message)
        || /invalid token/i.test(message)
        || /failed to fetch/i.test(message)
        || /user (?:is|has) not (?:been )?initialized/i.test(message)
        || isPasswordBootstrapError(message)
      );
    if (!shouldRetry) throw error;
    // eslint-disable-next-line no-console
    console.warn("[altastata] bootstrap retry triggered by:", message);
    authBootstrapDone = false;
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
      `${message}. Open Settings and provide user properties/private key/password, then run bootstrap.`,
    );
  }
  return new Error(message);
}

/**
 * Resets transient session state (token + bootstrap flags) so the next
 * authed RPC re-runs the bootstrap chain against whatever
 * {@link getRuntimeSettings} now reports. Called by the Settings dialog
 * after persisting changes.
 *
 * Does <strong>not</strong> talk to the network — a stale {@code sess-...}
 * token may linger on the server until its sliding TTL expires. Use
 * {@link logout} when you want a synchronous server-side invalidate.
 */
export function applyRuntimeSettings(): void {
  const config = getRuntimeSettings();
  sessionUserName = config.userName;
  sessionToken = "";
  sessionExpiresAtMs = null;
  authBootstrapDone = false;
  authBootstrapInFlight = null;
  lastWatchSequence = 0;
}

export async function bootstrapCurrentSettings(): Promise<void> {
  applyRuntimeSettings();
  await ensureAuthBootstrap();
}

/**
 * Calls {@code AuthService/Login} for the current settings without re-running
 * the SetUserProperties / SetPrivateKey bootstrap RPCs. Use when the user has
 * only changed their password (UserProperties + PrivateKey are already on the
 * server) and wants to re-authenticate without re-uploading material.
 *
 * <p>Renamed from the previous {@code setPasswordForCurrentSettings} along
 * with the underlying RPC swap (SetPasswordForUser → AuthService.Login). The
 * external behaviour stays the same: throws on bad credentials, leaves the
 * caller authenticated on success.
 */
export async function loginWithCurrentSettings(): Promise<void> {
  applyRuntimeSettings();
  const config = getRuntimeSettings();
  const userName = (config.userName || "").trim();
  const accountPassword = config.accountPassword ?? "";
  if (!userName) {
    throw new Error("User name is required.");
  }
  if (!accountPassword) {
    throw new Error("Password is required.");
  }
  await performLogin(userName, accountPassword);
  // A successful Login is, from auth's point of view, a successful bootstrap:
  // subsequent withBootstrapRetry-wrapped RPCs should not redundantly re-run
  // SetUserProperties / SetPrivateKey just because authBootstrapDone was
  // false coming out of applyRuntimeSettings.
  authBootstrapDone = true;
}

/**
 * Server-side invalidation of the current session. Best-effort: any RPC error
 * is logged and swallowed because the local state cleanup must always happen
 * (we never want to leave a UI in a "logged-out by network failure but token
 * still cached locally" state). After this call returns, the next authed
 * call will trigger a fresh {@link ensureAuthBootstrap}.
 */
export async function logout(): Promise<void> {
  if (sessionToken) {
    try {
      await grpcUnary(
        "altastata.v1.AuthService/Logout",
        "LogoutRequest",
        {},
        "LogoutResponse",
        true,
      );
    } catch (error) {
      console.warn("[altastata] Logout RPC failed; clearing local state anyway:", String(error));
    }
  }
  sessionToken = "";
  sessionExpiresAtMs = null;
  authBootstrapDone = false;
  authBootstrapInFlight = null;
}

export async function getAccount(): Promise<AccountInfo> {
  const config = getRuntimeSettings();
  return {
    account_id: config.accountId,
    display_name: extractMyUserFromProperties(config.userProperties)
      || config.accountId.split(".").at(-1)
      || "unknown",
  };
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

export interface AltaStataEvent {
  eventName: string;
  data: string;
}

/**
 * Highest event sequence ever delivered to the caller of
 * {@link subscribeToAltaStataEvents}. Persisted in this module across the
 * inevitable Watch-stream reconnects (TCP/HTTP-2 idle close, app sleep,
 * server restart) so we can ask the backend to replay anything we missed
 * via {@code WatchRequest.since_sequence}, instead of silently losing
 * SHARE/DELETE events that fired during the reconnect gap (the legacy
 * {@code EventsService/Subscribe} path was at-most-once and dropped them).
 *
 * <p>Reset to {@code 0} from {@link applyRuntimeSettings}: a settings
 * change implies a different user, and resuming from another user's
 * sequence space would just trigger {@code EventGapEvent} from the
 * gateway anyway.
 */
let lastWatchSequence = 0;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function readSequenceField(msg: Record<string, unknown>): number {
  const raw = msg.sequence;
  if (typeof raw === "number") return raw;
  if (typeof raw === "string") {
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/**
 * Subscribe to AltaStata events delivered through the long-running
 * {@code EventsService/Watch} server stream. The backend fires
 * {@link FileSharedEvent} when another user shares a file with the
 * current user, {@link FileUnsharedEvent} when access is revoked,
 * {@code EventGapEvent} when our {@code since_sequence} is older than
 * the server's ring buffer (we lost events; refresh from scratch), and
 * {@code SessionRevokedEvent} when the session has been forcibly closed.
 *
 * <p>{@link AltaStataEvent} is a flattened, untyped projection of the
 * typed {@code Event}. The caller in {@code App.tsx} only needs
 * "something happened, refresh the view" semantics, so we map the typed
 * payload to the legacy {@code (eventName, data)} pair without leaking
 * proto details upward.
 *
 * <p>{@code since_sequence} is the only behavioural difference from the
 * deprecated {@code Subscribe} RPC: on reconnect we ask for everything
 * past {@link lastWatchSequence}, so events fired during a reconnect
 * window are replayed once we are back online (see
 * {@code SESSION_AND_EVENTS_DESIGN.md} §7.5 / §7.6).
 *
 * <p>The promise resolves when the stream ends cleanly (typically only
 * on cancellation via {@code signal.abort()}) and rejects with the
 * underlying error if the connection is lost. Callers reconnect with
 * backoff; {@link lastWatchSequence} survives the reconnect.
 *
 * <p>Idle timeout is set far above any realistic quiet period so that
 * long stretches without events do not abort the stream from the client
 * side; we still rely on TCP / HTTP-2 keepalives at the transport layer.
 */
export async function subscribeToAltaStataEvents(
  onEvent: (event: AltaStataEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  await maybeBootstrap();
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;
  await withBootstrapRetry(() => grpcServerStreamWithCallback(
    "altastata.v1.EventsService/Watch",
    "WatchRequest",
    { sinceSequence: lastWatchSequence },
    "Event",
    true,
    (msg) => {
      const sequence = readSequenceField(msg);
      if (sequence > lastWatchSequence) lastWatchSequence = sequence;

      const fileShared = isPlainObject(msg.fileShared) ? msg.fileShared : null;
      const fileUnshared = isPlainObject(msg.fileUnshared) ? msg.fileUnshared : null;
      const eventGap = isPlainObject(msg.eventGap) ? msg.eventGap : null;
      const sessionRevoked = isPlainObject(msg.sessionRevoked) ? msg.sessionRevoked : null;

      let eventName = "";
      let data = "";
      if (fileShared) {
        eventName = "SHARE";
        data = typeof fileShared.filePath === "string" && fileShared.filePath
          ? fileShared.filePath
          : (typeof fileShared.fileId === "string" ? fileShared.fileId : "");
      } else if (fileUnshared) {
        eventName = "DELETE";
        data = typeof fileUnshared.fileId === "string" ? fileUnshared.fileId : "";
      } else if (eventGap) {
        // Server's ring buffer overran us; emit a synthetic GAP that App
        // treats as "refresh everything".
        const oldest = readSequenceField(eventGap as Record<string, unknown>);
        // eslint-disable-next-line no-console
        console.warn("[altastata] event gap (server_oldest_sequence=" + oldest
          + ", lastWatchSequence reset to " + sequence + ")");
        eventName = "GAP";
        data = String(oldest);
      } else if (sessionRevoked) {
        // eslint-disable-next-line no-console
        console.warn("[altastata] session revoked", sessionRevoked);
        eventName = "SESSION_REVOKED";
        data = String((sessionRevoked as Record<string, unknown>).reason ?? "");
      } else {
        // Unknown payload variant — newer server, older client. Fall through
        // and trigger a refresh anyway: at-worst-once is the right default.
        // eslint-disable-next-line no-console
        console.info("[altastata] event message (unknown payload)", msg);
      }

      // eslint-disable-next-line no-console
      console.info("[altastata] event message", { sequence, eventName, data });
      onEvent({ eventName, data });
    },
    { signal, idleTimeoutMs: ONE_DAY_MS },
  ));
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
