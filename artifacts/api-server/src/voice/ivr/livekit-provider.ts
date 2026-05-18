import { randomUUID } from "crypto";
import { logger } from "../../lib/logger.js";
import {
  mintLiveKitToken,
  getLiveKitCreds,
  getLiveKitSipDefaults,
  getAllowedSipTrunks,
  dialSipParticipant,
} from "../../services/livekit.service.js";
import { startLiveKitAgent } from "../livekit/agent-worker.js";
import type {
  IvrEnvelope,
  IvrProvider,
  TenantTelephonyContext,
  InitiateCallOptions,
} from "./types.js";

/**
 * LiveKit transport adapter — Phase 1 (browser-mic Call Simulator).
 *
 * LiveKit is *not* a WebSocket text-envelope carrier like Twilio or Exotel —
 * it's a WebRTC SFU. Audio flows over peer-published Opus tracks, not over
 * the `/api/voice/stream` WS endpoint. So this provider:
 *
 *   - Reports a PCM s16le @ 8 kHz mono codec for both inbound and outbound,
 *     and uses *identity* (passthrough) codec functions. The actual codec
 *     translation (Opus 48k stereo ↔ PCM s16le 8k mono) happens inside the
 *     LiveKit agent worker via `@livekit/rtc-node`'s `AudioStream` and
 *     `AudioSource`, which both accept a target sample rate / channel count.
 *
 *   - Returns `null` from `parseInboundEnvelope` and `""` from the serialize
 *     methods, because the WebRTC track path bypasses the Media Streams WS
 *     server entirely. `media-stream.ts` will never call these for LiveKit
 *     calls — the agent worker constructs a synthetic `MediaStreamSession`
 *     directly and pumps frames into `CallSession.onMedia()`.
 *
 *   - `generateConnectResponse` returns an `application/json` body with the
 *     room name, join token, and signalling URL — used by Phase-2 SIP
 *     bridge / inbound-call webhooks. For Phase-1 (Call Simulator), the
 *     browser obtains the token via `POST /api/voice/livekit/token` instead.
 *
 * Frame size choices below mirror Twilio (20 ms @ 8 kHz mono s16le = 320 B):
 * keeping the same pacing across providers means `CallSession.streamTtsToTwilio`
 * doesn't need a special branch for LiveKit, and downstream metrics
 * (per-frame RMS, barge-in timing) stay numerically comparable across
 * carriers.
 */
export class LiveKitProvider implements IvrProvider {
  readonly id = "livekit" as const;
  readonly name = "LiveKit WebRTC";

  // ── Codec ────────────────────────────────────────────────────────────────
  //
  // Inbound payloads delivered to CallSession.onMedia() are already PCM
  // s16le @ 8 kHz mono — the LiveKit agent worker resamples Opus 48 kHz
  // stereo down to 8 kHz mono via AudioStream(track, {sampleRate:8000,
  // numChannels:1}) before pushing each frame into the synthetic session.
  // Outbound encode is symmetric: CallSession hands us PCM s16le @ 8 kHz
  // mono and the agent worker wraps it in an AudioFrame for AudioSource.

  decodeInboundFrame(payload: Buffer): Buffer {
    return payload;
  }

  encodeOutboundFrame(pcm8k: Buffer): Buffer {
    return pcm8k;
  }

  outboundFrameBytesPcm(): number {
    return 320;
  }

  outboundFrameIntervalMs(): number {
    return 20;
  }

  // ── WS envelope ──────────────────────────────────────────────────────────
  //
  // LiveKit calls bypass the Media Streams WS path. These methods exist only
  // to satisfy the IvrProvider interface; the runtime never invokes them for
  // LiveKit-routed sessions. Defensive logs would be spammy noise here, so
  // we silently return null/"" and let the calling code handle absence.

  parseInboundEnvelope(_raw: string): IvrEnvelope | null {
    return null;
  }

  serializeAudioMessage(_streamSid: string, _wireFrame: Buffer): string {
    return "";
  }

  serializeMarkMessage(_streamSid: string, _name: string): string {
    return "";
  }

  serializeClearMessage(_streamSid: string): string {
    return "";
  }

  // ── Webhook ──────────────────────────────────────────────────────────────

  async generateConnectResponse(
    leadId: number | undefined,
    extraParameters?: Record<string, string>,
  ): Promise<{ contentType: string; body: string }> {
    // For LiveKit the carrier-equivalent "connect response" is a freshly
    // minted participant join token plus the SFU signalling URL — the
    // caller (Phase-2 SIP bridge / inbound webhook) hands these directly
    // to its LiveKit client to enter the room. Phase-1 simulators still
    // use POST /api/voice/livekit/token instead and ignore this body.
    const creds = getLiveKitCreds();
    const roomName = leadId ? `lead-${leadId}` : `lk-${Date.now()}`;
    if (!creds) {
      logger.warn(
        { leadId: leadId ?? null, providerId: this.id, roomName },
        "livekit_connect_response_no_creds",
      );
      return {
        contentType: "application/json",
        body: JSON.stringify({
          provider: "livekit",
          roomName,
          url: "",
          token: null,
          leadId: leadId ?? null,
          extraParameters: extraParameters ?? {},
          error:
            "LiveKit not configured (LIVEKIT_API_KEY / LIVEKIT_API_SECRET / LIVEKIT_URL).",
        }),
      };
    }
    const identity = `caller-${leadId ?? "anon"}-${Date.now()}`;
    const token = await mintLiveKitToken({
      roomName,
      identity,
      name: leadId ? `lead-${leadId}` : identity,
      ttlSeconds: 60 * 60,
    });
    logger.info(
      { leadId: leadId ?? null, providerId: this.id, roomName, identity },
      "livekit_connect_response_minted",
    );
    return {
      contentType: "application/json",
      body: JSON.stringify({
        provider: "livekit",
        roomName,
        url: creds.url,
        token,
        identity,
        leadId: leadId ?? null,
        extraParameters: extraParameters ?? {},
      }),
    };
  }

  // ── Outbound dispatch (Phase 2) ──────────────────────────────────────────
  //
  // Place an outbound PSTN call by:
  //   1. Choosing a per-call room name (lead-<id>-<short uuid>).
  //   2. Spawning the in-process agent worker into that room (it joins
  //      hidden, subscribes to remote audio, runs CallSession).
  //   3. Creating a SIP participant via LiveKit Cloud's SIP API. The trunk
  //      dials the destination and joins the answering party into the same
  //      room. From there, audio flows agent ↔ lead through the SFU.
  //
  // Returned identifier is the SIP participant identity, which LiveKit
  // webhooks echo back as `participant.identity` on participant_joined /
  // participant_left events. This is stored on `calls.twilio_call_sid`
  // (legacy column name) so the webhook handler can locate the call row.
  //
  // Per-tenant trunk + outbound number override platform env-var defaults.
  // If neither is set, throws a configuration error rather than silently
  // routing through Twilio — operators who flip a tenant to LiveKit must
  // also provision their trunk.
  async initiateCall(
    toPhone: string,
    leadId: number,
    tenant: TenantTelephonyContext | null,
    options: InitiateCallOptions = {},
  ): Promise<string> {
    const creds = getLiveKitCreds();
    if (!creds) {
      throw new Error(
        "LiveKit not configured (LIVEKIT_API_KEY / LIVEKIT_API_SECRET / LIVEKIT_URL).",
      );
    }
    const defaults = getLiveKitSipDefaults();
    const trunkId = tenant?.livekitSipTrunkId || defaults.trunkId;
    const fromNumber = tenant?.livekitSipOutboundNumber || defaults.outboundNumber;
    if (!trunkId) {
      throw new Error(
        "LiveKit SIP trunk not configured. Set LIVEKIT_SIP_TRUNK_ID (platform) " +
        "or tenants.livekit_sip_trunk_id (per-tenant, admin-only).",
      );
    }

    // Hard tenant isolation: if the tenant row carries a non-default trunk
    // ID, it MUST be on the platform allowlist. This prevents a compromised
    // tenant row (or future bug in an admin write path) from routing dials
    // through a trunk owned by another customer / privileged ops trunk.
    // The platform default trunk is always allowed.
    if (tenant?.livekitSipTrunkId && tenant.livekitSipTrunkId !== defaults.trunkId) {
      const allowed = getAllowedSipTrunks();
      if (!allowed.has(tenant.livekitSipTrunkId)) {
        logger.error(
          {
            leadId,
            tenantId: tenant?.tenantId ?? null,
            requestedTrunk: tenant.livekitSipTrunkId,
            allowedCount: allowed.size,
          },
          "livekit_outbound_trunk_not_allowlisted",
        );
        throw new Error(
          `LiveKit SIP trunk '${tenant.livekitSipTrunkId}' is not on the platform allowlist. ` +
          "Add it to LIVEKIT_SIP_TRUNK_ALLOWLIST or clear the tenant's livekit_sip_trunk_id.",
        );
      }
    }

    const roomName = `lead-${leadId}-${randomUUID().slice(0, 8)}`;
    // Identity must be unique per call; webhooks correlate on this string.
    const participantIdentity = `sip-lead-${leadId}-${randomUUID().slice(0, 8)}`;

    // Spawn the agent FIRST so it's listening when the SIP participant
    // joins. agent-worker is idempotent on room name — a re-dial on the
    // same lead replaces a stale worker rather than producing two.
    const agentHandle = await startLiveKitAgent({
      roomName,
      leadId,
      llmProvider: options.llmProviderOverride,
      source: "production",
      callSid: participantIdentity,
    });

    let result;
    try {
      result = await dialSipParticipant({
        roomName,
        toPhone,
        sipTrunkId: trunkId,
        fromNumber,
        participantIdentity,
        participantName: `lead-${leadId}`,
        participantMetadata: JSON.stringify({ leadId, tenantId: tenant?.tenantId ?? null }),
      });
    } catch (err) {
      // SIP dispatch failed (trunk misconfigured, carrier reject, etc.).
      // Tear down the agent worker we just spawned so it doesn't sit in an
      // empty room until LiveKit's 1-hour idle TTL. Best-effort — log and
      // re-throw the original error so dispatch caller marks the lead failed.
      try { await agentHandle?.disconnect?.(); } catch (teardownErr) {
        logger.warn(
          { leadId, roomName, err: (teardownErr as Error).message },
          "livekit_outbound_agent_teardown_failed",
        );
      }
      throw err;
    }
    logger.info(
      {
        leadId,
        tenantId: tenant?.tenantId ?? null,
        roomName,
        participantIdentity: result.participantIdentity,
        sipCallId: result.sipCallId ?? null,
        trunkId,
        hasFromOverride: !!fromNumber,
      },
      "livekit_outbound_dispatch",
    );
    return result.participantIdentity;
  }
}
