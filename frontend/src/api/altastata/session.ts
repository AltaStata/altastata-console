/**
 * In-memory auth / Watch session state. Never persisted across reloads.
 */

export const authSession = {
  token: "",
  expiresAtMs: null as number | null,
  bootstrapDone: false,
  bootstrapInFlight: null as Promise<void> | null,
  lastWatchSequence: 0,
};

/** Clears token + bootstrap flags (settings change or logout). */
export function clearAuthSession(): void {
  authSession.token = "";
  authSession.expiresAtMs = null;
  authSession.bootstrapDone = false;
  authSession.bootstrapInFlight = null;
}

/** Resets Watch resume cursor (different user / settings). */
export function resetWatchSequence(): void {
  authSession.lastWatchSequence = 0;
}
