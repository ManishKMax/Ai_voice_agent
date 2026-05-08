import { logger } from "../../lib/logger.js";
import { muLawToPcm16, pcm16ToMuLaw } from "../../audio/codec.js";
import type { IvrProvider } from "./types.js";

/**
 * Exotel Voicebot Streaming adapter — SCAFFOLD ONLY.
 *
 * Wire format reference (Exotel Voicebot Applet docs):
 *   - JSON envelope similar to Twilio but with different field names:
 *       { event: "start",  stream_sid, call_sid, ... }
 *       { event: "media",  media: { payload (base64), chunk, timestamp } }
 *       { event: "stop",   ... }
 *     Note the snake_case keys. media-stream.ts currently parses Twilio's
 *     camelCase envelope only; full Exotel support requires either:
 *       (a) a separate WS endpoint with its own parser, or
 *       (b) lifting envelope parsing into the IvrProvider.
 *     We've chosen (b) for the long term but the refactor is out of scope
 *     for Phase 4 — see TODO(exotel) below.
 *
 *   - Default codec: 8 kHz mono 16-bit signed-PCM (NOT μ-law!) per Exotel's
 *     Voicebot Applet defaults. Some Exotel accounts can be configured to
 *     stream μ-law instead; the provider should detect this from the
 *     `start` envelope's media format and adapt. For the scaffold we
 *     assume μ-law to mirror Twilio so the codec helpers exercise the
 *     same code paths during typecheck.
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
 *   - Lets `dispatchIvrProvider("exotel")` succeed in dev, surfacing
 *     wiring bugs early instead of at integration time.
 */
export class ExotelMediaStreamsProvider implements IvrProvider {
  readonly id = "exotel" as const;
  readonly name = "Exotel Voicebot Streaming (scaffold)";

  decodeInboundFrame(payload: Buffer): Buffer {
    // TODO(exotel): Detect the actual encoding from the carrier `start`
    // envelope's mediaFormat. Exotel defaults to PCM s16le but is
    // commonly configured to μ-law for parity with Twilio. For the
    // scaffold we assume μ-law so the type-check exercises the codec
    // path; real production wiring MUST branch on the negotiated
    // format and bypass the codec when payload is already PCM.
    logger.debug({ providerId: this.id }, "exotel_decode_inbound (scaffold)");
    return muLawToPcm16(payload);
  }

  encodeOutboundFrame(pcm8k: Buffer): Buffer {
    // TODO(exotel): As above — when the carrier negotiated PCM, return
    // pcm8k unchanged. When μ-law, encode. Until that branch is wired
    // we always μ-law-encode so an Exotel-flagged tenant produces
    // sensible bytes if the provider somehow reaches production by
    // accident.
    return pcm16ToMuLaw(pcm8k);
  }

  outboundFrameBytesPcm(): number {
    // Exotel Voicebot also uses 20 ms frames @ 8 kHz. Same maths as Twilio.
    return 320;
  }

  outboundFrameIntervalMs(): number {
    return 20;
  }

  generateConnectResponse(leadId: number | undefined): { contentType: string; body: string } {
    // TODO(exotel): The exact tag name and attributes are determined by
    // the customer's Exotel App SID flow. The shape below is a
    // best-effort placeholder pieced together from the Exotel
    // Voicebot Streaming docs (https://developer.exotel.com/api/voicebot-streaming).
    // Live testing MUST replace this with the verified format from a
    // real Exotel account before Exotel calls are dispatched.
    const wsBase = (process.env["BASE_URL"] ?? "")
      .replace(/^https:/i, "wss:")
      .replace(/^http:/i, "ws:");
    const streamUrl = `${wsBase}/api/voice/stream`;
    const leadParam = leadId ? `<Parameter name="leadId" value="${leadId}"/>` : "";
    const body = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <!-- TODO(exotel): replace <Voicebot> with the verified Exotel applet tag -->
  <Voicebot url="${streamUrl}">${leadParam}</Voicebot>
</Response>`;
    logger.warn(
      { leadId, providerId: this.id },
      "exotel_connect_response_scaffold — NOT verified against a live Exotel account",
    );
    return { contentType: "application/xml", body };
  }
}
