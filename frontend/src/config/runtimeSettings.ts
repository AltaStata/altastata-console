export interface RuntimeSettings {
  grpcBaseUrl: string;
  accountId: string;
  userName: string;
  accountPassword: string;
  userProperties: string;
  privateKey: string;
  autoBootstrap: boolean;
  bootstrapMode: string;
}

type StoredRuntimeSettings = Omit<RuntimeSettings, "accountPassword">;

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
  const configuredUserProperties = ((import.meta.env.VITE_ALTASTATA_USER_PROPERTIES as string | undefined) ?? "")
    .replace(/\\n/g, "\n");
  const configuredUserName = import.meta.env.VITE_ALTASTATA_GRPC_USER_NAME as string | undefined;
  const derivedMyUserName = extractMyUserFromProperties(configuredUserProperties);
  return {
    grpcBaseUrl: (import.meta.env.VITE_ALTASTATA_GRPC_BASE_URL as string | undefined)
      ?? "http://127.0.0.1:9877",
    accountId: configuredAccountId,
    userName: derivedMyUserName
      || configuredUserName
      || configuredAccountId.split(".").at(-1)
      || "",
    // Security default: password is always entered manually per session.
    accountPassword: "",
    userProperties: configuredUserProperties,
    privateKey: ((import.meta.env.VITE_ALTASTATA_PRIVATE_KEY as string | undefined) ?? "")
      .replace(/\\n/g, "\n"),
    autoBootstrap: (import.meta.env.VITE_ALTASTATA_AUTO_BOOTSTRAP as string | undefined) === "true",
    bootstrapMode: (import.meta.env.VITE_ALTASTATA_BOOTSTRAP_MODE as string | undefined) ?? "auto",
  };
}

function normalizeSettings(input: Partial<RuntimeSettings>, fallback: RuntimeSettings): RuntimeSettings {
  const userProperties = (input.userProperties ?? fallback.userProperties ?? "").replace(/\r\n/g, "\n");
  const accountId = (input.accountId ?? fallback.accountId ?? "unknown-account").trim() || "unknown-account";
  const userName = (input.userName ?? fallback.userName ?? "").trim()
    || extractMyUserFromProperties(userProperties)
    || accountId.split(".").at(-1)
    || "";
  return {
    grpcBaseUrl: (input.grpcBaseUrl ?? fallback.grpcBaseUrl ?? "http://127.0.0.1:9877").trim() || "http://127.0.0.1:9877",
    accountId,
    userName,
    accountPassword: input.accountPassword ?? fallback.accountPassword ?? "",
    userProperties,
    privateKey: (input.privateKey ?? fallback.privateKey ?? "").replace(/\r\n/g, "\n"),
    autoBootstrap: typeof input.autoBootstrap === "boolean" ? input.autoBootstrap : fallback.autoBootstrap,
    bootstrapMode: (input.bootstrapMode ?? fallback.bootstrapMode ?? "auto").trim() || "auto",
  };
}

function loadInitialSettings(): RuntimeSettings {
  const defaults = envDefaults();
  if (typeof window === "undefined") return defaults;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaults;
    const parsedRaw = JSON.parse(raw) as Partial<RuntimeSettings>;
    // Legacy localStorage data may contain accountPassword; ignore it on load.
    const { accountPassword: _ignored, ...parsed } = parsedRaw;
    return normalizeSettings(parsed as Partial<StoredRuntimeSettings>, defaults);
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
