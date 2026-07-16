/**
 * gRPC-Web transport: framing, unary / server-stream calls, timeouts.
 */
import { getRuntimeSettings } from "@/config/runtimeSettings";
import { T, type Bytes } from "./proto";
import { authSession } from "./session";

export const REQUEST_TIMEOUT_MS = 15_000;
/** CreateFile waits on encrypted cloud I/O; under bulk folder upload (×4 concurrency) 15s is too short. */
export const UPLOAD_REQUEST_TIMEOUT_MS = 120_000;
export const STREAM_UPLOAD_THRESHOLD_BYTES = 8 * 1024 * 1024;
export const STREAM_UPLOAD_CHUNK_FALLBACK_BYTES = 8 * 1024 * 1024;
/** Delete with includingSubdirectories walks encrypted metadata; large trees need minutes, not seconds. */
export const DELETE_REQUEST_TIMEOUT_MS = 300_000;
export const LIST_DIR_FAST_TIMEOUT_MS = 5_000;

export function baseUrl(): string {
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
export function token(): string {
  return authSession.token;
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

export function grpcHeaders(withAuth: boolean): Record<string, string> {
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

export async function grpcUnary(
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

export async function grpcServerStreamWithCallback(
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

export async function grpcServerStream(
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
