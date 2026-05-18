import { AccessToken, RoomServiceClient, SipClient } from "livekit-server-sdk";
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

/**
 * Phase-2 SIP defaults. Operators provision the SIP trunk + outbound DID in
 * the LiveKit Cloud dashboard (or via `lk sip outbound`) and surface the
 * resulting IDs via env vars. Per-tenant overrides on `tenants` table take
 * precedence when set.
 *
 * `LIVEKIT_WEBHOOK_API_KEY` is optional — if unset, the webhook handler
 * falls back to the main `LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET` pair, which
 * is what LiveKit Cloud signs webhooks with by default.
 */
export interface LiveKitSipDefaults {
  trunkId: string | null;
  outboundNumber: string | null;
}

export function getLiveKitSipDefaults(): LiveKitSipDefaults {
  return {
    trunkId: process.env["LIVEKIT_SIP_TRUNK_ID"] ?? null,
    outboundNumber: process.env["LIVEKIT_SIP_OUTBOUND_NUMBER"] ?? null,
  };
}

/**
 * Allowlist of SIP trunk IDs that a per-tenant `livekit_sip_trunk_id`
 * value is permitted to take. Enforced at dispatch time so that even if
 * a row in `tenants` somehow ends up with a forged trunk ID (direct DB
 * access, future bug in admin route, etc.), we refuse to dial through
 * any trunk not on this allowlist.
 *
 * The allowlist always implicitly includes the platform default
 * (`LIVEKIT_SIP_TRUNK_ID`). Additional trunk IDs may be configured via
 * `LIVEKIT_SIP_TRUNK_ALLOWLIST` (comma-separated).
 */
export function getAllowedSipTrunks(): Set<string> {
  const set = new Set<string>();
  const def = process.env["LIVEKIT_SIP_TRUNK_ID"];
  if (def) set.add(def);
  const extra = process.env["LIVEKIT_SIP_TRUNK_ALLOWLIST"];
  if (extra) {
    for (const id of extra.split(",").map((s) => s.trim()).filter(Boolean)) {
      set.add(id);
    }
  }
  return set;
}

/** Webhook signing key pair — defaults to the main API creds. */
export function getLiveKitWebhookCreds(): { apiKey: string; apiSecret: string } | null {
  const apiKey = process.env["LIVEKIT_WEBHOOK_API_KEY"] ?? process.env["LIVEKIT_API_KEY"];
  const apiSecret = process.env["LIVEKIT_WEBHOOK_API_SECRET"] ?? process.env["LIVEKIT_API_SECRET"];
  if (!apiKey || !apiSecret) return null;
  return { apiKey, apiSecret };
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

// ── SIP outbound dispatch (Phase 2) ─────────────────────────────────────────
//
// `createSipParticipant` is the LiveKit Cloud API that places an outbound
// PSTN call through a provisioned SIP trunk and joins the answering party
// into a room as a participant. The agent worker is already in the room (or
// joins concurrently), so once the SIP participant connects, audio flows
// peer-to-peer through the SFU. No TwiML, no carrier webhook for connect.
//
// We pin `waitUntilAnswered: false` so the call returns immediately with a
// participant identity — status transitions (ringing → answered → ended)
// arrive over the LiveKit webhook, which maps onto our existing
// /api/call-status flow.

export interface DialSipParticipantOptions {
  /** Pre-existing room name. Created on first participant join if absent. */
  roomName: string;
  /** E.164 destination phone number. */
  toPhone: string;
  /** SIP trunk to dial out from. Tenant-scoped, falls back to env default. */
  sipTrunkId: string;
  /** Optional "From" number override. Falls back to trunk default. */
  fromNumber?: string | null;
  /** Stable identity for the SIP participant. Used to correlate webhooks. */
  participantIdentity: string;
  /** Display name shown to the agent participant. */
  participantName?: string;
  /** Free-form metadata blob — we stash leadId here. */
  participantMetadata?: string;
  /** Hard cap on call duration (seconds). Defaults to 30 min. */
  maxCallDurationSeconds?: number;
  /** Ringing timeout (seconds). Defaults to 30s before LiveKit gives up. */
  ringingTimeoutSeconds?: number;
}

export interface DialSipParticipantResult {
  participantIdentity: string;
  /** LiveKit's own SIP call ID — useful for cross-referencing in their dashboard. */
  sipCallId?: string;
  roomName: string;
}

/**
 * Boot-time probe: list outbound SIP trunks against LiveKit Cloud. This is
 * a free read-only call (no DID minutes consumed) that verifies (a) the
 * project credentials are valid, (b) the SIP add-on is enabled on the
 * project, and (c) — if `LIVEKIT_SIP_TRUNK_ID` is set — that the configured
 * trunk actually exists in the account. Failures are warnings, not fatal,
 * so a misconfigured project doesn't block API server boot.
 */
export async function probeSipOutboundTrunks(): Promise<void> {
  const creds = getLiveKitCreds();
  if (!creds) {
    logger.info("livekit_sip_probe_skipped reason=no_creds");
    return;
  }
  const defaults = getLiveKitSipDefaults();
  if (!defaults.trunkId && !process.env["LIVEKIT_SIP_TRUNK_ALLOWLIST"]) {
    logger.info("livekit_sip_probe_skipped reason=no_trunk_configured");
    return;
  }
  try {
    const httpUrl = toHttpUrl(creds.url);
    const client = new SipClient(httpUrl, creds.apiKey, creds.apiSecret);
    const trunks = await client.listSipOutboundTrunk();
    const ids = trunks
      .map((t) => (t as { sipTrunkId?: string; sip_trunk_id?: string }).sipTrunkId
                  ?? (t as { sip_trunk_id?: string }).sip_trunk_id
                  ?? null)
      .filter((x): x is string => !!x);
    const allowed = getAllowedSipTrunks();
    const missing = [...allowed].filter((id) => !ids.includes(id));
    if (missing.length > 0) {
      logger.warn(
        { configured: [...allowed], found: ids, missing },
        "livekit_sip_probe_trunk_missing",
      );
    } else {
      logger.info(
        { trunkCount: ids.length, allowedCount: allowed.size },
        "livekit_sip_probe_ok",
      );
    }
  } catch (err) {
    logger.warn(
      { err: (err as Error).message },
      "livekit_sip_probe_failed",
    );
  }
}

export async function dialSipParticipant(
  opts: DialSipParticipantOptions,
): Promise<DialSipParticipantResult> {
  const creds = getLiveKitCreds();
  if (!creds) {
    throw new Error(
      "LiveKit not configured (LIVEKIT_API_KEY / LIVEKIT_API_SECRET / LIVEKIT_URL).",
    );
  }
  const httpUrl = toHttpUrl(creds.url);
  const client = new SipClient(httpUrl, creds.apiKey, creds.apiSecret);
  const sipOpts: Parameters<SipClient["createSipParticipant"]>[3] = {
    participantIdentity: opts.participantIdentity,
    participantName: opts.participantName ?? opts.participantIdentity,
    participantMetadata: opts.participantMetadata,
    ringingTimeout: opts.ringingTimeoutSeconds ?? 30,
    maxCallDuration: opts.maxCallDurationSeconds ?? 30 * 60,
    waitUntilAnswered: false,
    playDialtone: false,
  };
  if (opts.fromNumber) sipOpts.fromNumber = opts.fromNumber;
  const info = await client.createSipParticipant(
    opts.sipTrunkId,
    opts.toPhone,
    opts.roomName,
    sipOpts,
  );
  // SIPParticipantInfo fields vary across SDK versions; the identity is
  // canonical and what webhook events echo back.
  const identity =
    (info as { participantIdentity?: string; participant_identity?: string }).participantIdentity
    ?? (info as { participant_identity?: string }).participant_identity
    ?? opts.participantIdentity;
  const sipCallId =
    (info as { sipCallId?: string; sip_call_id?: string }).sipCallId
    ?? (info as { sip_call_id?: string }).sip_call_id;
  logger.info(
    {
      roomName: opts.roomName,
      participantIdentity: identity,
      sipCallId: sipCallId ?? null,
      trunkId: opts.sipTrunkId,
      hasFromOverride: !!opts.fromNumber,
    },
    "livekit_sip_participant_created",
  );
  return { participantIdentity: identity, sipCallId, roomName: opts.roomName };
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
