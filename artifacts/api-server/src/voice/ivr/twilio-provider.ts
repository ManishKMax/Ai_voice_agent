import {
  muLawToPcm16,
  pcm16ToMuLaw,
} from "../../audio/codec.js";
import { generateMediaStreamTwiML } from "../../services/twilio.service.js";
import { logger } from "../../lib/logger.js";
import type { IvrEnvelope, IvrProvider } from "./types.js";

/**
 * Twilio Media Streams adapter.
 *
 * Wire format (inbound & outbound):
 *   - encoding:    G.711 μ-law (`audio/x-mulaw`)
 *   - sample rate: 8 kHz mono
 *   - frame size:  160 bytes μ-law = 20 ms = 160 PCM samples = 320 PCM bytes
 *
 * WS envelope (Twilio docs):
 *   { event: "connected", protocol, version }
 *   { event: "start", start: { streamSid, callSid, customParameters,
 *                              mediaFormat: { encoding, sampleRate, channels } } }
 *   { event: "media", media: { payload (b64), timestamp, track } }
 *   { event: "mark", mark: { name } }
 *   { event: "stop", stop: { ... } }
 *
 * Webhook envelope: TwiML <Connect><Stream/></Connect> with leadId as a
 * custom <Parameter/>.
 *
 * Output bytes are byte-identical to the Phase-3 inline implementation.
 */
export class TwilioMediaStreamsProvider implements IvrProvider {
  readonly id = "twilio" as const;
  readonly name = "Twilio Media Streams";

  // ── Codec ────────────────────────────────────────────────────────────────

  decodeInboundFrame(payload: Buffer): Buffer {
    return muLawToPcm16(payload);
  }

  encodeOutboundFrame(pcm8k: Buffer): Buffer {
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
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      logger.warn({ err, providerId: this.id }, "twilio_envelope_non_json");
      return null;
    }
    if (!isRecord(parsed)) return null;
    const event = parsed["event"];
    switch (event) {
      case "connected": {
        return {
          kind: "connected",
          protocol: typeof parsed["protocol"] === "string" ? parsed["protocol"] : undefined,
          version: typeof parsed["version"] === "string" ? parsed["version"] : undefined,
        };
      }
      case "start": {
        const start = parsed["start"];
        if (!isRecord(start)) return null;
        const streamSid = typeof start["streamSid"] === "string" ? start["streamSid"] : "";
        const callSid = typeof start["callSid"] === "string" ? start["callSid"] : "";
        if (!streamSid || !callSid) return null;
        const cpRaw = start["customParameters"];
        const customParameters: Record<string, string> = {};
        if (isRecord(cpRaw)) {
          for (const [k, v] of Object.entries(cpRaw)) {
            if (typeof v === "string") customParameters[k] = v;
            else if (typeof v === "number") customParameters[k] = String(v);
          }
        }
        const mfRaw = isRecord(start["mediaFormat"]) ? start["mediaFormat"] : {};
        return {
          kind: "start",
          streamSid,
          callSid,
          customParameters,
          mediaFormat: {
            encoding: typeof mfRaw["encoding"] === "string" ? mfRaw["encoding"] : "audio/x-mulaw",
            sampleRate: typeof mfRaw["sampleRate"] === "number" ? mfRaw["sampleRate"] : 8000,
            channels: typeof mfRaw["channels"] === "number" ? mfRaw["channels"] : 1,
          },
        };
      }
      case "media": {
        const media = parsed["media"];
        if (!isRecord(media)) return null;
        const payloadB64 = media["payload"];
        if (typeof payloadB64 !== "string" || !payloadB64) return null;
        const tsRaw = media["timestamp"];
        const timestampMs =
          typeof tsRaw === "number" ? tsRaw : typeof tsRaw === "string" ? Number(tsRaw) || 0 : 0;
        return {
          kind: "media",
          payload: Buffer.from(payloadB64, "base64"),
          timestampMs,
        };
      }
      case "mark": {
        const mark = parsed["mark"];
        if (!isRecord(mark)) return null;
        const name = typeof mark["name"] === "string" ? mark["name"] : "";
        return { kind: "mark", name };
      }
      case "stop": {
        return { kind: "stop" };
      }
      default:
        return null;
    }
  }

  serializeAudioMessage(streamSid: string, wireFrame: Buffer): string {
    return JSON.stringify({
      event: "media",
      streamSid,
      media: { payload: wireFrame.toString("base64") },
    });
  }

  serializeMarkMessage(streamSid: string, name: string): string {
    return JSON.stringify({ event: "mark", streamSid, mark: { name } });
  }

  serializeClearMessage(streamSid: string): string {
    return JSON.stringify({ event: "clear", streamSid });
  }

  // ── Webhook ──────────────────────────────────────────────────────────────

  generateConnectResponse(
    leadId: number | undefined,
    extraParameters?: Record<string, string>,
  ): { contentType: string; body: string } {
    return {
      contentType: "text/xml",
      body: generateMediaStreamTwiML(leadId, extraParameters),
    };
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
