/**
 * EventsService/Watch subscription and event projection.
 */
import { maybeBootstrap, withBootstrapRetry } from "./auth";
import { authSession } from "./session";
import { grpcServerStreamWithCallback } from "./transport";

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
 * SHARE/DELETE events that fired during the reconnect gap (the pre-Watch
 * untyped path was at-most-once and dropped them; that RPC has since been
 * removed from the gateway).
 *
 * <p>Reset to {@code 0} from {@link applyRuntimeSettings}: a settings
 * change implies a different user, and resuming from another user's
 * sequence space would just trigger {@code EventGapEvent} from the
 * gateway anyway.
 */
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
 * past {@link authSession.lastWatchSequence}, so events fired during a reconnect
 * window are replayed once we are back online (see
 * {@code SESSION_AND_EVENTS_DESIGN.md} §7.5 / §7.6).
 *
 * <p>The promise resolves when the stream ends cleanly (typically only
 * on cancellation via {@code signal.abort()}) and rejects with the
 * underlying error if the connection is lost. Callers reconnect with
 * backoff; {@link authSession.lastWatchSequence} survives the reconnect.
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
    { sinceSequence: authSession.lastWatchSequence },
    "Event",
    true,
    (msg) => {
      const sequence = readSequenceField(msg);
      if (sequence > authSession.lastWatchSequence) authSession.lastWatchSequence = sequence;

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
          + ", authSession.lastWatchSequence reset to " + sequence + ")");
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
