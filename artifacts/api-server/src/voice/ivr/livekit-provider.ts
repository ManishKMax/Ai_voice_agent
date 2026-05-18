import { logger } from "../../lib/logger.js";
import type { IvrEnvelope, IvrProvider } from "./types.js";

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

  generateConnectResponse(
    leadId: number | undefined,
    extraParameters?: Record<string, string>,
  ): { contentType: string; body: string } {
    // Phase-1 (Call Simulator) doesn't use this — the browser fetches the
    // token via POST /api/voice/livekit/token directly. Phase-2 SIP bridge
    // and inbound-call webhooks will invoke this from the /api/voice route.
    // The payload is intentionally informational; the real join handshake
    // happens via the LiveKit signalling URL once the client has a token.
    const url = process.env["LIVEKIT_URL"] ?? "";
    const roomName = leadId ? `lead-${leadId}` : `lk-${Date.now()}`;
    logger.info(
      { leadId: leadId ?? null, providerId: this.id, roomName },
      "livekit_connect_response_placeholder",
    );
    return {
      contentType: "application/json",
      body: JSON.stringify({
        provider: "livekit",
        roomName,
        url,
        leadId: leadId ?? null,
        extraParameters: extraParameters ?? {},
        note: "Phase 1: call POST /api/voice/livekit/token to mint a join token.",
      }),
    };
  }
}
