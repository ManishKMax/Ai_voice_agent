import { AccessToken } from "livekit-server-sdk";
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
 * Boot-time probe — verifies a token can be signed locally with the
 * configured creds. Does NOT make a network call (we want zero startup
 * latency / fail-soft behaviour); a successful sign proves the SDK loaded
 * and the key/secret are present, which is the actual failure mode we've
 * seen in dev. Fully missing creds are reported at info-level, not warn,
 * because LiveKit is opt-in transport — the system runs fine without it.
 */
export async function probeLiveKit(): Promise<void> {
  const creds = getLiveKitCreds();
  if (!creds) {
    logger.info(
      "livekit_probe_skipped: LIVEKIT_API_KEY / LIVEKIT_API_SECRET / LIVEKIT_URL not set",
    );
    return;
  }
  try {
    const token = await mintLiveKitToken({
      roomName: "_probe",
      identity: "_probe_agent",
      ttlSeconds: 60,
      isAgent: true,
    });
    logger.info(
      { url: creds.url, tokenLength: token.length },
      "livekit_probe: OK (token signed successfully)",
    );
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "livekit_probe: FAILED");
  }
}
