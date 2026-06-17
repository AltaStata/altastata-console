export interface RuntimeSettings {
  grpcBaseUrl: string;
  accountId: string;
  userName: string;
  accountPassword: string;
  autoBootstrap: boolean;
}

const STORAGE_KEY = "altastata-console-runtime-settings-v1";

export function extractMyUserFromProperties(text: string): string {
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

function envDefaults(): RuntimeSettings {
  const configuredAccountId = (import.meta.env.VITE_ALTASTATA_ACCOUNT_ID as string | undefined)
    ?? "unknown-account";
  const configuredUserName = import.meta.env.VITE_ALTASTATA_GRPC_USER_NAME as string | undefined;
  return {
    grpcBaseUrl: (import.meta.env.VITE_ALTASTATA_GRPC_BASE_URL as string | undefined)
      ?? "http://127.0.0.1:9877",
    accountId: configuredAccountId,
    userName: configuredUserName
      || configuredAccountId.split(".").at(-1)
      || "",
    // Security default: password is always entered manually per session.
    accountPassword: "",
    autoBootstrap: (import.meta.env.VITE_ALTASTATA_AUTO_BOOTSTRAP as string | undefined) === "true",
  };
}

function normalizeSettings(input: Partial<RuntimeSettings>, fallback: RuntimeSettings): RuntimeSettings {
  const accountId = (input.accountId ?? fallback.accountId ?? "unknown-account").trim() || "unknown-account";
  const userName = (input.userName ?? fallback.userName ?? "").trim()
    || accountId.split(".").at(-1)
    || "";
  return {
    grpcBaseUrl: (input.grpcBaseUrl ?? fallback.grpcBaseUrl ?? "http://127.0.0.1:9877").trim() || "http://127.0.0.1:9877",
    accountId,
    userName,
    accountPassword: input.accountPassword ?? fallback.accountPassword ?? "",
    autoBootstrap: typeof input.autoBootstrap === "boolean" ? input.autoBootstrap : fallback.autoBootstrap,
  };
}

function loadInitialSettings(): RuntimeSettings {
  const defaults = envDefaults();
  if (typeof window === "undefined") return defaults;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaults;
    const parsedRaw = JSON.parse(raw) as Partial<RuntimeSettings> & {
      userProperties?: string;
      privateKey?: string;
      bootstrapMode?: string;
    };
    // Legacy localStorage data may contain accountPassword or paste fields; ignore them.
    const {
      accountPassword: _ignoredPassword,
      userProperties: _ignoredProps,
      privateKey: _ignoredKey,
      bootstrapMode: _ignoredMode,
      ...parsed
    } = parsedRaw;
    return normalizeSettings(parsed, defaults);
  } catch {
    return defaults;
  }
}

let runtimeSettings: RuntimeSettings = loadInitialSettings();

function persistSettings(settings: RuntimeSettings): void {
  if (typeof window === "undefined") return;
  try {
    const { accountPassword: _ignored, ...persisted } = settings;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(persisted));
  } catch {
    // Ignore storage failures (quota/private mode); keep in-memory settings.
  }
}

export function getRuntimeSettings(): RuntimeSettings {
  return runtimeSettings;
}

export function updateRuntimeSettings(next: Partial<RuntimeSettings>): RuntimeSettings {
  runtimeSettings = normalizeSettings(next, runtimeSettings);
  persistSettings(runtimeSettings);
  return runtimeSettings;
}
