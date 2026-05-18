/**
 * Provider-agnostic IVR adapter contract.
 *
 * Phase 4 goal: keep the voice/brain state machine (`CallSession`) and the
 * `media-stream` WebSocket subscriber free of any Twilio-specific
 * assumptions so a future Exotel / Plivo / SignalWire / etc. adapter can
 * be added by writing one file.
 *
 * The provider owns:
 *   - codec translation (inbound wire bytes ↔ PCM s16le 8 kHz)
 *   - WS envelope parsing (carrier JSON → normalised IvrEnvelope union)
 *   - WS outbound serialization (audio / mark / clear → carrier JSON)
 *   - the webhook response that hooks the carrier into our Media Streams WS
 *   - lifecycle metadata (id, name)
 *
 * CallSession and media-stream consume only the normalised types below;
 * neither imports a Twilio (or any other carrier) module directly.
 *
 * Design notes:
 *   - We standardise on PCM s16le mono @ 8 kHz internally because every
 *     telephony carrier sends 8 kHz audio downstream. CallSession upsamples
 *     to 16 kHz centrally for STT.
 *   - Outbound frame size is provider-controlled (Twilio = 320 bytes PCM @
 *     8 kHz = 160 bytes μ-law = 20 ms; other carriers may differ).
 */

export type IvrProviderId = "twilio" | "exotel" | "livekit";

/**
 * Normalised inbound envelope union. Every carrier's WS protocol must map
 * onto one of these shapes — anything richer (e.g. Twilio's `track`, Exotel's
 * `account_sid`) is provider-internal and stripped at parse time.
 */
export type IvrEnvelope =
  | { kind: "connected"; protocol?: string; version?: string }
  | {
      kind: "start";
      streamSid: string;
      callSid: string;
      customParameters: Record<string, string>;
      mediaFormat: { encoding: string; sampleRate: number; channels: number };
    }
  | { kind: "media"; payload: Buffer; timestampMs: number }
  | { kind: "mark"; name: string }
  | { kind: "stop" };

export interface IvrProvider {
  /** Stable id, must match `tenants.telephony_provider` values. */
  readonly id: IvrProviderId;

  /** Human-readable name for logs/dashboards. */
  readonly name: string;

  // ── Codec ─────────────────────────────────────────────────────────────────

  /**
   * Decode a single inbound media payload (as delivered over the carrier WS
   * `media` envelope) into PCM s16le mono @ 8 kHz. Pure function; safe to
   * call from hot paths.
   */
  decodeInboundFrame(payload: Buffer): Buffer;

  /**
   * Encode a PCM s16le mono @ 8 kHz buffer into the carrier's outbound wire
   * format. Caller chunks to `outboundFrameBytesPcm()` boundaries first.
   */
  encodeOutboundFrame(pcm8k: Buffer): Buffer;

  /**
   * Number of PCM s16le bytes per outbound frame the provider expects.
   */
  outboundFrameBytesPcm(): number;

  /** Pace (ms) at which outbound frames should be sent in real time. */
  outboundFrameIntervalMs(): number;

  // ── WS envelope ──────────────────────────────────────────────────────────

  /**
   * Parse a single raw text frame received on the carrier WS into the
   * normalised IvrEnvelope. Returns null for unknown / malformed frames so
   * the WS server can ignore them safely.
   *
   * Implementations must NOT throw on bad input; logging is fine.
   */
  parseInboundEnvelope(raw: string): IvrEnvelope | null;

  /**
   * Serialise an outbound audio frame (the wire-encoded bytes from
   * encodeOutboundFrame) into the carrier's "media" message. The result is
   * sent as-is over the WS.
   */
  serializeAudioMessage(streamSid: string, wireFrame: Buffer): string;

  /**
   * Serialise a "mark" / sync message. Twilio echoes marks back when the
   * preceding audio finishes playing — providers without an equivalent
   * concept may return an empty string and CallSession will skip the send.
   */
  serializeMarkMessage(streamSid: string, name: string): string;

  /**
   * Serialise a "discard buffered outbound audio" message. Providers without
   * an equivalent may return an empty string.
   */
  serializeClearMessage(streamSid: string): string;

  // ── Webhook ──────────────────────────────────────────────────────────────

  /**
   * Generate the carrier-specific webhook response that connects the live
   * call to our Media Streams WebSocket. Receives the leadId so it can be
   * forwarded as a custom parameter on the stream.
   */
  generateConnectResponse(
    leadId: number | undefined,
    extraParameters?: Record<string, string>,
  ): Promise<{ contentType: string; body: string }> | { contentType: string; body: string };
}
