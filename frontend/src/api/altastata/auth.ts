/**
 * Auth bootstrap, LoginV2, logout, and session-facing helpers.
 */
import type { AccountInfo } from "@/types";
import { accountLoginRequiresPassword, parseAccountFolder } from "@/api/accountFolder";
import type { LoginV2UploadMaterial } from "@/api/accountFolder";
import { getRuntimeSettings, updateRuntimeSettings } from "@/config/runtimeSettings";
import {
  getSessionAccountMaterial,
  hasSessionAccountMaterial,
  setSessionAccountMaterial,
} from "@/session/accountMaterial";
import { authSession, clearAuthSession, resetWatchSequence } from "./session";
import { grpcUnary } from "./transport";

/**
 * Build the {@code clientHint} sent on every {@code AuthService/LoginV2} call.
 *
 * <p>The backend enforces a single-session-per-{@code (userName, clientHint)}
 * invariant: a fresh Login from the same hint evicts the prior session and
 * closes its {@code EventsService/Watch} stream. To stop two browser tabs of
 * the same user from killing each other on every Login, we tag the hint with
 * a per-tab UUID stored in {@code sessionStorage} — survives a reload (so the
 * reloaded tab evicts its own zombie Watch from the pre-reload session) but
 * is unique to each tab (so independent tabs run side-by-side). Falls back
 * to a process-wide UUID when {@code sessionStorage} is unavailable (older
 * browsers, file:// origins) so the hint still differs across page loads.
 */
let memoizedClientHint: string | null = null;
function getClientHint(): string {
  if (memoizedClientHint) return memoizedClientHint;
  const PREFIX = "altastata-console-web";
  const STORAGE_KEY = "altastata.tabId";
  let tabId: string | null = null;
  try {
    tabId = window.sessionStorage.getItem(STORAGE_KEY);
    if (!tabId) {
      tabId = generateUuid();
      window.sessionStorage.setItem(STORAGE_KEY, tabId);
    }
  } catch {
    // sessionStorage may be denied by browser policy; fall back to a one-shot
    // module-scoped UUID. Reload then yields a fresh hint, which is fine —
    // it just disables the "evict my own pre-reload zombie" optimisation.
    tabId = generateUuid();
  }
  memoizedClientHint = `${PREFIX}/${tabId}`;
  return memoizedClientHint;
}

function generateUuid(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  // Last-resort RFC4122-ish fallback for environments without crypto.randomUUID.
  const rand = () => Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, "0");
  return `${rand()}-${rand()}-${rand()}-${rand()}`;
}

async function performLoginV2(
  password: string,
  material: LoginV2UploadMaterial,
): Promise<void> {
  let resp: Record<string, unknown>;
  try {
    resp = await grpcUnary(
      "altastata.v1.AuthService/LoginV2",
      "LoginV2Request",
      {
        clientHint: getClientHint(),
        password,
        upload: {
          userProperties: material.userProperties,
          accountFiles: material.accountFiles,
        },
      },
      "LoginV2Response",
      false,
    );
  } catch (error) {
    if (isInvalidCredentialsError(error)) throw new InvalidPasswordError();
    throw error;
  }
  const newToken = typeof resp.sessionToken === "string" ? resp.sessionToken : "";
  if (!newToken) {
    throw new Error("LoginV2 response missing session_token");
  }
  authSession.token = newToken;
  const expiresAt = resp.expiresAt as { seconds?: number } | undefined;
  authSession.expiresAtMs = typeof expiresAt?.seconds === "number" ? expiresAt.seconds * 1000 : null;
  updateRuntimeSettings({
    userName: material.myUser,
    accountId: material.displayName || material.myUser,
  });
}

export async function ensureAuthBootstrap(): Promise<void> {
  if (authSession.bootstrapDone) return;
  if (authSession.bootstrapInFlight) {
    await authSession.bootstrapInFlight;
    return;
  }
  authSession.bootstrapInFlight = (async () => {
    const config = getRuntimeSettings();
    const material = getSessionAccountMaterial();
    if (!material) {
      throw new Error("Choose an account folder in Settings before signing in.");
    }
    const password = config.accountPassword ?? "";
    if (accountLoginRequiresPassword(material.userProperties) && !password) {
      throw new Error("Password is required.");
    }
    const bootstrapUser = material.myUser;
    // eslint-disable-next-line no-console
    console.info("[altastata] LoginV2 start", { user: bootstrapUser });
    await performLoginV2(password, material);
    authSession.bootstrapDone = true;
    // eslint-disable-next-line no-console
    console.info("[altastata] LoginV2 done", {
      user: bootstrapUser,
      hasSessionToken: Boolean(authSession.token),
      expiresAtMs: authSession.expiresAtMs,
    });
  })();
  try {
    await authSession.bootstrapInFlight;
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("[altastata] LoginV2 failed", String(error));
    throw error;
  } finally {
    authSession.bootstrapInFlight = null;
  }
}

export async function maybeBootstrap(): Promise<void> {
  if (!getRuntimeSettings().autoBootstrap) return;
  await ensureAuthBootstrap();
}

function canBootstrapFromEnv(): boolean {
  const config = getRuntimeSettings();
  const material = getSessionAccountMaterial();
  if (!material) return false;
  if (!accountLoginRequiresPassword(material.userProperties)) return true;
  return Boolean(config.accountPassword);
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
 * {@code AuthService/Login} or {@code AuthService/LoginV2}: {@code UNAUTHENTICATED} (status=16) with the
 * fixed description {@code "Invalid credentials"}. We detect this so
 * {@link withBootstrapRetry} can skip its retry loop in this case — running
 * Login twice with the same wrong password is just noise (and an extra
 * audit-log line on the server) when we know it cannot succeed.
 *
 * Accepts both the typed {@link InvalidPasswordError} thrown by
 * {@link performLoginV2} and the raw {@code Error} from {@link grpcUnary}, so
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
 * password → Sign in), so the UI uses this single signal to
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
 * enough material to sign in (account folder loaded in memory + password),
 * force a fresh ensureAuthBootstrap() (LoginV2 upload) and retry the call once.
 *
 * <p>One narrow exception: a wrong password from AuthService/Login surfaces as
 * {@code status=16 / "Invalid credentials"}; retrying that is pointless and
 * just doubles the failure rate the user sees. We bubble it directly. See
 * {@link isInvalidCredentialsError}.
 */
export async function withBootstrapRetry<T>(fn: () => Promise<T>): Promise<T> {
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
    authSession.bootstrapDone = false;
    await ensureAuthBootstrap();
    return fn();
  }
}

export function authHint(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (/status=16|invalid token/i.test(message)) {
    return new Error(
      `${message}. Open Settings, choose your account folder, enter your password, then Sign in.`,
    );
  }
  return new Error(message);
}

/**
 * Load account material from a {@code webkitdirectory} picker into session
 * memory (not persisted). Call before {@link bootstrapCurrentSettings}.
 */
export async function loadAccountFolderFromPicker(files: FileList | readonly File[]): Promise<void> {
  const material = await parseAccountFolder(files);
  setSessionAccountMaterial(material);
  updateRuntimeSettings({
    userName: material.myUser,
    accountId: material.displayName || material.myUser,
  });
}

export { hasSessionAccountMaterial, getSessionAccountMaterial };

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
  clearAuthSession();
  resetWatchSequence();
}

export async function bootstrapCurrentSettings(): Promise<void> {
  applyRuntimeSettings();
  await ensureAuthBootstrap();
}

/**
 * Calls {@code AuthService/LoginV2} with in-memory account folder material
 * and the current password (no re-upload of the folder).
 */
export async function loginWithCurrentSettings(): Promise<void> {
  applyRuntimeSettings();
  const material = getSessionAccountMaterial();
  if (!material) {
    throw new Error("Choose an account folder first, or use Sign in.");
  }
  const accountPassword = getRuntimeSettings().accountPassword ?? "";
  if (accountLoginRequiresPassword(material.userProperties) && !accountPassword) {
    throw new Error("Password is required.");
  }
  await performLoginV2(accountPassword, material);
  authSession.bootstrapDone = true;
}

/**
 * Server-side invalidation of the current session. Best-effort: any RPC error
 * is logged and swallowed because the local state cleanup must always happen
 * (we never want to leave a UI in a "logged-out by network failure but token
 * still cached locally" state). After this call returns, the next authed
 * call will trigger a fresh {@link ensureAuthBootstrap}.
 */
export async function logout(): Promise<void> {
  if (authSession.token) {
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
  clearAuthSession();
}

export async function getAccount(): Promise<AccountInfo> {
  const config = getRuntimeSettings();
  const material = getSessionAccountMaterial();
  return {
    account_id: config.accountId,
    display_name: material?.myUser
      || config.userName
      || config.accountId.split(".").at(-1)
      || "unknown",
  };
}
