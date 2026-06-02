/**
 * In-app log buffer that mirrors the browser's console output into a fixed-size
 * ring so the UI can surface a "View log" panel without forcing the user to
 * open DevTools. We install once at module load (idempotent) and keep the
 * original console behaviour intact, so anything the rest of the app prints
 * still shows up in the real DevTools console as well.
 *
 * The buffer is intentionally tiny (500 entries) — this is for debugging /
 * support, not analytics, and we want to keep memory predictable.
 */
export type LogLevel = "log" | "info" | "warn" | "error" | "debug";

export interface LogEntry {
  id: number;
  timestamp: number;
  level: LogLevel;
  text: string;
}

const MAX_ENTRIES = 500;
let nextId = 1;
const entries: LogEntry[] = [];
const listeners = new Set<(snapshot: LogEntry[]) => void>();

function notify() {
  const snapshot = entries.slice();
  for (const fn of listeners) fn(snapshot);
}

function formatArg(arg: unknown): string {
  if (arg instanceof Error) return arg.stack ?? `${arg.name}: ${arg.message}`;
  if (typeof arg === "string") return arg;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

function push(level: LogLevel, args: unknown[]) {
  const text = args.map(formatArg).join(" ");
  const entry: LogEntry = {
    id: nextId++,
    timestamp: Date.now(),
    level,
    text,
  };
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
  notify();
}

let installed = false;
export function installLogBuffer() {
  if (installed) return;
  installed = true;
  const orig = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    debug: console.debug.bind(console),
  };
  console.log = (...args) => { push("log", args); orig.log(...args); };
  console.info = (...args) => { push("info", args); orig.info(...args); };
  console.warn = (...args) => { push("warn", args); orig.warn(...args); };
  console.error = (...args) => { push("error", args); orig.error(...args); };
  console.debug = (...args) => { push("debug", args); orig.debug(...args); };
  // Synthetic seed entry so a freshly opened log panel never looks empty even
  // before any other code has had a chance to log. It also doubles as proof
  // that the wrapper is wired in.
  push("info", ["[ui] log buffer installed"]);
}

export function getLogEntries(): LogEntry[] {
  return entries.slice();
}

export function clearLogEntries() {
  entries.length = 0;
  notify();
}

export function subscribeLogEntries(fn: (snapshot: LogEntry[]) => void): () => void {
  listeners.add(fn);
  fn(entries.slice());
  return () => { listeners.delete(fn); };
}
