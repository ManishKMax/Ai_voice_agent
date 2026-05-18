import { logger } from "../../lib/logger.js";
import { muLawToPcm16, pcm16ToMuLaw } from "../../audio/codec.js";
import type { IvrEnvelope, IvrProvider } from "./types.js";

/**
 * Exotel Voicebot Streaming adapter — SCAFFOLD ONLY.
 *
 * Wire format reference (Exotel Voicebot Applet docs):
 *   - JSON envelope similar to Twilio but with snake_case keys:
 *       { event: "start",  stream_sid, call_sid,
 *         start: { custom_parameters, media_format: {...} } }
 *       { event: "media",  media: { payload (b64), chunk, timestamp } }
 *       { event: "mark",   mark: { name } }
 *       { event: "stop" }
 *
 *   - Default codec: 8 kHz mono 16-bit signed-PCM (NOT μ-law!) per Exotel's
 *     Voicebot Applet defaults. Some Exotel accounts can be configured to
 *     stream μ-law instead; the provider should detect this from the
 *     `start` envelope's media format and adapt. For the scaffold we
 *     assume μ-law to mirror Twilio so the codec helpers exercise the
 *     same code paths during typecheck — see TODO(exotel) in
 *     decode/encode.
 *
 *   - Webhook envelope: app-bazaar / passthru XML, NOT TwiML. Looks like:
 *       <Response><Voicebot url="wss://..." /></Response>
 *     The exact tag name depends on the Exotel app flow chosen by the
 *     customer. Final wiring requires the customer's Exotel App SID.
 *
 * Why include this scaffold today even though we cannot live-test it?
 *   - Forces the IvrProvider interface to be honest (a non-Twilio impl
 *     compiling against the same contract proves the abstraction works).
 *   - Gives a future task a concrete file to edit instead of a blank page.
 *
 * IMPORTANT: every method below is marked TODO(exotel) where it diverges
 * from the live spec. None of this code has been verified against a real
 * Exotel account.
 */
export class ExotelMediaStreamsProvider implements IvrProvider {
  readonly id = "exotel" as const;
  readonly name = "Exotel Voicebot Streaming (scaffold)";

  // ── Codec ────────────────────────────────────────────────────────────────

  decodeInboundFrame(payload: Buffer): Buffer {
    // TODO(exotel): branch on the negotiated mediaFormat.encoding from the
    // `start` envelope. For PCM, return payload unchanged. For μ-law,
    // decode. Until verified we assume μ-law for parity with Twilio.
    return muLawToPcm16(payload);
  }

  encodeOutboundFrame(pcm8k: Buffer): Buffer {
    // TODO(exotel): if the carrier negotiated PCM, return pcm8k unchanged.
    return pcm16ToMuLaw(pcm8k);
  }

  outboundFrameBytesPcm(): number {
    return 320;
  }

  outboundFrameIntervalMs(): number {
    return 20;
  }

  // ── WS envelope ──────────────────────────────────────────────────────────

  parseInboundEnvelope(raw: string): IvrEnvelope | null {
    // TODO(exotel): verify exact field names against a real Exotel session.
    // The Voicebot docs use snake_case; we accept both snake_case and the
    // Twilio-style camelCase as a defensive convenience while the spec
    // is unverified.
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      logger.warn({ err, providerId: this.id }, "exotel_envelope_non_json");
      return null;
    }
    if (!isRecord(parsed)) return null;
    const event = parsed["event"];
    switch (event) {
      case "connected":
        return { kind: "connected" };
      case "start": {
        const start = isRecord(parsed["start"]) ? parsed["start"] : parsed;
        const streamSid = pickString(start, ["stream_sid", "streamSid"]) ?? "";
        const callSid = pickString(start, ["call_sid", "callSid"]) ?? "";
        if (!streamSid || !callSid) return null;
        const cpRaw =
          (isRecord(start["custom_parameters"]) ? start["custom_parameters"] : null) ??
          (isRecord(start["customParameters"]) ? start["customParameters"] : null);
        const customParameters: Record<string, string> = {};
        if (cpRaw) {
          for (const [k, v] of Object.entries(cpRaw)) {
            if (typeof v === "string") customParameters[k] = v;
            else if (typeof v === "number") customParameters[k] = String(v);
          }
        }
        const mfRaw =
          (isRecord(start["media_format"]) ? start["media_format"] : null) ??
          (isRecord(start["mediaFormat"]) ? start["mediaFormat"] : null) ??
          {};
        const sampleRate =
          typeof mfRaw["sample_rate"] === "number"
            ? mfRaw["sample_rate"]
            : typeof mfRaw["sampleRate"] === "number"
              ? mfRaw["sampleRate"]
              : 8000;
        return {
          kind: "start",
          streamSid,
          callSid,
          customParameters,
          mediaFormat: {
            // TODO(exotel): default is "audio/L16" (PCM) per Exotel docs;
            // the scaffold reports μ-law to match the codec helpers we
            // currently call.
            encoding: typeof mfRaw["encoding"] === "string" ? mfRaw["encoding"] : "audio/x-mulaw",
            sampleRate,
            channels: typeof mfRaw["channels"] === "number" ? mfRaw["channels"] : 1,
          },
        };
      }
      case "media": {
        const media = isRecord(parsed["media"]) ? parsed["media"] : null;
        if (!media) return null;
        const payloadB64 = media["payload"];
        if (typeof payloadB64 !== "string" || !payloadB64) return null;
        const tsRaw = media["timestamp"];
        const timestampMs =
          typeof tsRaw === "number" ? tsRaw : typeof tsRaw === "string" ? Number(tsRaw) || 0 : 0;
        return { kind: "media", payload: Buffer.from(payloadB64, "base64"), timestampMs };
      }
      case "mark": {
        const mark = isRecord(parsed["mark"]) ? parsed["mark"] : null;
        const name = mark && typeof mark["name"] === "string" ? mark["name"] : "";
        return { kind: "mark", name };
      }
      case "stop":
        return { kind: "stop" };
      default:
        return null;
    }
  }

  serializeAudioMessage(streamSid: string, wireFrame: Buffer): string {
    // TODO(exotel): verify Exotel's exact outbound envelope. Voicebot uses
    // snake_case stream_sid; some apps prefer a top-level base64 payload.
    return JSON.stringify({
      event: "media",
      stream_sid: streamSid,
      media: { payload: wireFrame.toString("base64") },
    });
  }

  serializeMarkMessage(streamSid: string, name: string): string {
    // TODO(exotel): mark/sync semantics differ across Exotel apps. Some do
    // not echo marks back. Caller treats "" as "skip send".
    return JSON.stringify({ event: "mark", stream_sid: streamSid, mark: { name } });
  }

  serializeClearMessage(streamSid: string): string {
    // TODO(exotel): no documented "clear buffered audio" message exists for
    // Voicebot Streaming; closing the WS is the only verified way. Return
    // an empty string so the caller skips the send.
    void streamSid;
    return "";
  }

  // ── Webhook ──────────────────────────────────────────────────────────────

  generateConnectResponse(
    leadId: number | undefined,
    extraParameters?: Record<string, string>,
  ): { contentType: string; body: string } {
    // TODO(exotel): the exact tag name and attributes are determined by the
    // customer's Exotel App SID flow. Live testing MUST replace this with
    // the verified format from a real Exotel account before Exotel calls
    // are dispatched.
    const wsBase = (process.env["BASE_URL"] ?? "")
      .replace(/^https:/i, "wss:")
      .replace(/^http:/i, "ws:");
    const streamUrl = `${wsBase}/api/voice/stream`;
    const params: string[] = [];
    if (leadId) params.push(`<Parameter name="leadId" value="${leadId}"/>`);
    if (extraParameters) {
      for (const [k, v] of Object.entries(extraParameters)) {
        if (v) params.push(`<Parameter name="${escapeXml(k)}" value="${escapeXml(v)}"/>`);
      }
    }
    const body = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <!-- TODO(exotel): replace <Voicebot> with the verified Exotel applet tag -->
  <Voicebot url="${streamUrl}">${params.join("")}</Voicebot>
</Response>`;
    logger.warn(
      { leadId, providerId: this.id },
      "exotel_connect_response_scaffold — NOT verified against a live Exotel account",
    );
    return { contentType: "application/xml", body };
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function pickString(rec: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === "string" && v) return v;
  }
  return null;
}
