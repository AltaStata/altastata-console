/**
 * Path / MIME / concurrency helpers used by file operations.
 */

export function normalizePath(path: string): string {
  const trimmed = path.trim() || "/";
  if (trimmed === "/") return "/";
  const withLeading = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withLeading.replace(/\/+$/, "");
}

export function parentPath(path: string): string {
  const normalized = normalizePath(path);
  if (normalized === "/") return "/";
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length <= 1) return "/";
  return `/${parts.slice(0, -1).join("/")}`;
}

export function toCloudPath(path: string): string {
  return normalizePath(path).replace(/^\/+/, "");
}

export function toApiPath(path: string): string {
  const stripped = path.trim().replace(/^\/+/, "").replace(/\/+$/, "");
  return stripped ? `/${stripped}` : "/";
}

export function splitVersionedPath(cloudPath: string): { base: string; version: string | null } {
  const idx = cloudPath.indexOf("✹");
  if (idx < 0) return { base: cloudPath, version: null };
  return { base: cloudPath.slice(0, idx), version: cloudPath.slice(idx + 1) || null };
}

export function parseVersionTimestamp(version: string | null): number | null {
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

export function parseVersionTag(version: string | null): string | null {
  if (!version) return null;
  const parts = version.split("_");
  if (parts.length >= 2 && parts[0]) return parts[0];
  return null;
}

export function parseCreated(version: string | null): string | null {
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

export function guessMime(name: string): string | null {
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
