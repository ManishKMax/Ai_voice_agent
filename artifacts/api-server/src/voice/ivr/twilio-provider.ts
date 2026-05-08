import {
  muLawToPcm16,
  pcm16ToMuLaw,
} from "../../audio/codec.js";
import { generateMediaStreamTwiML } from "../../services/twilio.service.js";
import type { IvrProvider } from "./types.js";

/**
 * Twilio Media Streams adapter.
 *
 * Wire format (inbound & outbound):
 *   - encoding:    G.711 μ-law (`audio/x-mulaw`)
 *   - sample rate: 8 kHz mono
 *   - frame size:  160 bytes μ-law = 20 ms = 160 PCM samples = 320 PCM bytes
 *
 * Webhook envelope: TwiML <Connect><Stream/></Connect> pointing at our WS,
 * with the leadId forwarded as a custom <Parameter/> so CallSession can
 * correlate the stream to the lead.
 *
 * This adapter is intentionally a thin shell — every byte produced for
 * Twilio is byte-identical to what CallSession used to emit inline before
 * the Phase-4 refactor. That preserves the Phase-3 happy path.
 */
export class TwilioMediaStreamsProvider implements IvrProvider {
  readonly id = "twilio" as const;
  readonly name = "Twilio Media Streams";

  decodeInboundFrame(payload: Buffer): Buffer {
    return muLawToPcm16(payload);
  }

  encodeOutboundFrame(pcm8k: Buffer): Buffer {
    return pcm16ToMuLaw(pcm8k);
  }

  outboundFrameBytesPcm(): number {
    // 20 ms @ 8 kHz s16le = 160 samples * 2 bytes = 320 bytes PCM
    // (which encodes to 160 bytes μ-law — Twilio's frame size).
    return 320;
  }

  outboundFrameIntervalMs(): number {
    return 20;
  }

  generateConnectResponse(leadId: number | undefined): { contentType: string; body: string } {
    return {
      contentType: "text/xml",
      body: generateMediaStreamTwiML(leadId),
    };
  }
}
