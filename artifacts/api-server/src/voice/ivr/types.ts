/**
 * Provider-agnostic IVR adapter contract.
 *
 * Phase 4 goal: keep the voice/brain state machine (`CallSession`) free of any
 * Twilio-specific assumptions so a future Exotel / Plivo / SignalWire / etc.
 * adapter can be added by writing one file. CallSession consumes a normalised
 * PCM s16le mono stream at 8 kHz and emits PCM s16le mono frames at 8 kHz.
 * Each `IvrProvider` implementation is responsible for:
 *
 *   - inbound:  provider wire format → 8 kHz PCM s16le frames
 *   - outbound: 8 kHz PCM s16le frames → provider wire format
 *   - the webhook response that hooks the carrier into our Media Streams WS
 *     (TwiML for Twilio, app-bazaar XML for Exotel, etc.)
 *   - lifecycle metadata (name, telephony id used by `tenants.telephony_provider`)
 *
 * Design notes:
 *   - We standardise on 8 kHz s16le because every telephony carrier sends
 *     8 kHz audio downstream, and Sarvam STT handles 16 kHz upsampling
 *     centrally inside CallSession (so providers never need to know).
 *   - Outbound frame size is provider-controlled (Twilio = 160 bytes μ-law =
 *     320 bytes PCM @ 8 kHz; Exotel may differ). CallSession asks the
 *     provider for the right per-frame PCM length.
 */

export type IvrProviderId = "twilio" | "exotel";

export interface IvrProvider {
  /** Stable id, must match `tenants.telephony_provider` values. */
  readonly id: IvrProviderId;

  /** Human-readable name for logs/dashboards. */
  readonly name: string;

  /**
   * Decode a single inbound media payload (as delivered over the carrier WS)
   * into PCM s16le mono @ 8 kHz. Pure function; safe to call from hot paths.
   */
  decodeInboundFrame(payload: Buffer): Buffer;

  /**
   * Encode a PCM s16le mono @ 8 kHz buffer into the carrier's outbound wire
   * format. Caller chunks to `outboundFrameBytesPcm()` boundaries first.
   */
  encodeOutboundFrame(pcm8k: Buffer): Buffer;

  /**
   * Number of PCM s16le bytes per outbound frame the provider expects. For
   * Twilio (μ-law @ 8 kHz, 20 ms frames) this is 320 bytes (= 160 samples).
   */
  outboundFrameBytesPcm(): number;

  /** Pace (ms) at which outbound frames should be sent in real time. */
  outboundFrameIntervalMs(): number;

  /**
   * Generate the carrier-specific webhook response that connects the live
   * call to our Media Streams WebSocket. Receives the leadId so it can be
   * forwarded as a custom parameter on the stream.
   */
  generateConnectResponse(leadId: number | undefined): { contentType: string; body: string };
}
