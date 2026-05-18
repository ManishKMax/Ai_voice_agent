import { AccessToken, RoomServiceClient } from "livekit-server-sdk";
import { logger } from "../lib/logger.js";

/**
 * LiveKit credential service. Phase 1 reads creds from env vars only
 * (`LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `LIVEKIT_URL`). Phase 2 will
 * surface them on the Settings UI alongside Twilio/Exotel telephony creds —
 * extending this module to read from `platform_settings` is intentionally
 * deferred until the UI exists so we don't ship a half-wired field.
 *
 * No secret ever appears in a log line — `probeLivekit()` logs only success
 * / failure + the configured URL, never the key or signed token.
 */

export interface LiveKitCreds {
  apiKey: string;
  apiSecret: string;
  url: string;
}

export function getLiveKitCreds(): LiveKitCreds | null {
  const apiKey = process.env["LIVEKIT_API_KEY"];
  const apiSecret = process.env["LIVEKIT_API_SECRET"];
  const url = process.env["LIVEKIT_URL"];
  if (!apiKey || !apiSecret || !url) return null;
  return { apiKey, apiSecret, url };
}

export interface MintTokenOptions {
  roomName: string;
  identity: string;
  /** Display name shown to other participants. Defaults to identity. */
  name?: string;
  /** Token lifetime in seconds. Default 1 hour. */
  ttlSeconds?: number;
  /** Whether this participant can publish tracks. Default true. */
  canPublish?: boolean;
  /** Whether this participant can subscribe to remote tracks. Default true. */
  canSubscribe?: boolean;
  /** Optional metadata blob attached to the participant. */
  metadata?: string;
  /** Mark this as an agent participant (used by the in-process worker). */
  isAgent?: boolean;
}

/**
 * Mint a signed LiveKit access token. Throws if creds are not configured —
 * callers (HTTP handlers) should catch and surface a 503 so the operator
 * sees the misconfiguration without a 500.
 */
export async function mintLiveKitToken(opts: MintTokenOptions): Promise<string> {
  const creds = getLiveKitCreds();
  if (!creds) {
    throw new Error(
      "LiveKit not configured. Set LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LIVEKIT_URL.",
    );
  }
  const at = new AccessToken(creds.apiKey, creds.apiSecret, {
    identity: opts.identity,
    name: opts.name ?? opts.identity,
    ttl: opts.ttlSeconds ?? 60 * 60,
    metadata: opts.metadata,
  });
  at.addGrant({
    room: opts.roomName,
    roomJoin: true,
    canPublish: opts.canPublish ?? true,
    canSubscribe: opts.canSubscribe ?? true,
    canPublishData: true,
    // Agents typically join hidden so they don't show up in participant
    // lists in the simulator UI. Browser users join visible by default.
    hidden: opts.isAgent ?? false,
  });
  return at.toJwt();
}

/**
 * Convert a wss:// LiveKit project URL to the matching https:// origin
 * used by the RoomService HTTP API. RoomServiceClient accepts the wss
 * URL too, but normalising once here keeps logs / errors readable.
 */
function toHttpUrl(url: string): string {
  if (url.startsWith("wss://")) return "https://" + url.slice("wss://".length);
  if (url.startsWith("ws://")) return "http://" + url.slice("ws://".length);
  return url;
}

/**
 * Boot-time probe — verifies that the configured LiveKit credentials are
 * actually accepted by the target project URL. Issues a single
 * `RoomService.listRooms()` call (cheap, idempotent, project-scoped) and
 * logs the structured outcome:
 *   - `livekit_probe: OK`     — creds authenticated against `LIVEKIT_URL`
 *   - `livekit_probe: FAILED` — with `reason` (load_failed | sign_failed |
 *                               network_error | auth_rejected | unknown)
 *
 * Fail-soft: never throws, never blocks startup. The probe runs with a hard
 * 4s timeout so a slow/unreachable LiveKit edge can't delay app boot.
 * Missing creds remain info-level (LiveKit is opt-in transport).
 */
export async function probeLiveKit(): Promise<void> {
  const creds = getLiveKitCreds();
  if (!creds) {
    logger.info(
      "livekit_probe_skipped: LIVEKIT_API_KEY / LIVEKIT_API_SECRET / LIVEKIT_URL not set",
    );
    return;
  }

  // Step 1: confirm we can sign locally. A failure here means the SDK
  // load broke or the secret format is invalid — distinct from a network
  // / auth failure against the server, so we surface it separately.
  try {
    await mintLiveKitToken({
      roomName: "_probe",
      identity: "_probe_agent",
      ttlSeconds: 60,
      isAgent: true,
    });
  } catch (err) {
    logger.warn(
      { url: creds.url, reason: "sign_failed", err: (err as Error).message },
      "livekit_probe: FAILED",
    );
    return;
  }

  // Step 2: real authenticated round-trip. listRooms is the lightest
  // RoomService call — returns [] on an empty project, requires
  // `roomList`-or-`roomAdmin` style server creds. A 401/403 here means
  // the key/secret pair doesn't belong to the project at `LIVEKIT_URL`,
  // which is exactly the misconfiguration a local-only sign probe misses.
  const httpUrl = toHttpUrl(creds.url);
  const client = new RoomServiceClient(httpUrl, creds.apiKey, creds.apiSecret);
  const PROBE_TIMEOUT_MS = 4_000;
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`livekit_probe_timeout_${PROBE_TIMEOUT_MS}ms`)),
      PROBE_TIMEOUT_MS,
    );
  });
  try {
    const rooms = await Promise.race([client.listRooms(), timeout]);
    logger.info(
      { url: creds.url, roomCount: Array.isArray(rooms) ? rooms.length : 0 },
      "livekit_probe: OK",
    );
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    // Best-effort classification — RoomService throws plain Errors with
    // the upstream HTTP body in the message, so substring match is the
    // most portable signal.
    let reason = "unknown";
    if (/timeout/i.test(message)) reason = "network_timeout";
    else if (/401|403|unauthorized|forbidden|invalid api key|invalid token/i.test(message))
      reason = "auth_rejected";
    else if (/enotfound|econnrefused|getaddrinfo|network|fetch failed/i.test(message))
      reason = "network_error";
    logger.warn(
      { url: creds.url, reason, err: message },
      "livekit_probe: FAILED",
    );
  } finally {
    if (timer) clearTimeout(timer);
  }
}
