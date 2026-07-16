/**
 * Account key generation (RSA / PQC / HPCS).
 */
import { grpcUnary } from "./transport";

export const ALL_ACCOUNT_KEY_TYPES: AccountKeyType[] = ["RSA", "PQC", "HPCS"];

/** Account keygen types for {@link generateAccountKeys}. */
export type AccountKeyType = "RSA" | "PQC" | "HPCS";

const ACCOUNT_TYPE_FROM_PROTO: Record<number, AccountKeyType> = {
  1: "RSA",
  2: "PQC",
  3: "HPCS",
};

const ACCOUNT_TYPE_TO_PROTO: Record<AccountKeyType, number> = {
  RSA: 1,
  PQC: 2,
  HPCS: 3,
};

export interface GenerateKeysResult {
  displayName: string;
  accountFiles: Record<string, Uint8Array>;
}

const GENERATE_KEYS_TIMEOUT_MS = 120_000;

function normalizeAccountFiles(raw: unknown): Record<string, Uint8Array> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, Uint8Array> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value instanceof Uint8Array) {
      out[key] = value;
    } else if (ArrayBuffer.isView(value)) {
      out[key] = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }
  }
  return out;
}

/**
 * Lists key types for Generate keys (RSA, PQC, HPCS). HPCS requires the
 * gateway to have GREP11 configured ({@code GREP11_YAML} / populated yaml).
 */
export async function getSupportedAccountTypes(): Promise<AccountKeyType[]> {
  try {
    const resp = await grpcUnary(
      "altastata.v1.AccountSetupService/GetSupportedAccountTypes",
      "GetSupportedAccountTypesRequest",
      {},
      "GetSupportedAccountTypesResponse",
      false,
    );
    const rawTypes = resp.accountTypes;
    if (!Array.isArray(rawTypes)) return [...ALL_ACCOUNT_KEY_TYPES];
    const types: AccountKeyType[] = [];
    for (const value of rawTypes) {
      const mapped = typeof value === "number" ? ACCOUNT_TYPE_FROM_PROTO[value] : undefined;
      if (mapped) types.push(mapped);
    }
    for (const fallback of ALL_ACCOUNT_KEY_TYPES) {
      if (!types.includes(fallback)) types.push(fallback);
    }
    return types;
  } catch {
    return [...ALL_ACCOUNT_KEY_TYPES];
  }
}

/**
 * Runs {@code AccountSetupService.GenerateKeys} and returns key files for zip
 * download (no {@code *user.properties} — admin step comes later).
 */
export async function generateAccountKeys(input: {
  accountType: AccountKeyType;
  password: string;
  suggestedDisplayName?: string;
}): Promise<GenerateKeysResult> {
  const resp = await grpcUnary(
    "altastata.v1.AccountSetupService/GenerateKeys",
    "GenerateKeysRequest",
    {
      accountType: ACCOUNT_TYPE_TO_PROTO[input.accountType],
      password: input.password,
      suggestedDisplayName: input.suggestedDisplayName?.trim() || "",
    },
    "GenerateKeysResponse",
    false,
    GENERATE_KEYS_TIMEOUT_MS,
  );
  const accountFiles = normalizeAccountFiles(resp.accountFiles);
  if (Object.keys(accountFiles).length === 0) {
    throw new Error("GenerateKeys returned no account files.");
  }
  const displayName = typeof resp.suggestedDisplayName === "string" && resp.suggestedDisplayName
    ? resp.suggestedDisplayName
    : input.suggestedDisplayName?.trim() || "altastata-account";
  return { displayName, accountFiles };
}

export function accountTypeRequiresPassword(type: AccountKeyType): boolean {
  return type === "RSA" || type === "PQC";
}
