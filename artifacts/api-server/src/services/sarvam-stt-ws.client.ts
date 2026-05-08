import { EventEmitter } from "events";
import WebSocket from "ws";
import { config } from "../config/index.js";
import { logger } from "../lib/logger.js";
import { writeWavPcm16 } from "../audio/codec.js";

/**
 * Sarvam STT WebSocket client.
 *
 * Discovered protocol (May 2026, via probe):
 *   URL:     wss://api.sarvam.ai/speech-to-text/ws?model=saaras:v3&language-code=<bcp47>
 *            (the `language-code` query param is REQUIRED; without it the
 *             handshake returns 403)
 *   Auth:    api-subscription-key: <SARVAM_API_KEY>
 *   Send:    a SINGLE JSON message per request:
 *              { audio: { data:<base64-WAV>, encoding:"audio/wav",
 *                         sample_rate:<hz> },
 *                language_code?: <bcp47> }
 *   Receive: a single JSON response with the final transcript, then the
 *            server closes the socket.
 *
 * Pydantic responses observed:
 *   - "audio Input should be a valid dictionary or instance of AudioContent"
 *     → audio must be a dict, not a base64 string.
 *   - "audio.data Field required / audio.encoding must be 'audio/wav'"
 *     → fields are `data` (base64-WAV) and `encoding` (must literally be
 *       "audio/wav"; the WS does not accept raw PCM).
 *
 * Sarvam STT WS is therefore **request/response**, not true streaming —
 * partial transcripts are NOT supported by the public endpoint as of this
 * build. We expose a typed event interface anyway so Phase 3 can swap in a
 * real streaming implementation if Sarvam ships one without changing
 * callers. For now `partial` is never emitted; only `final` and `error`.
 *
 * Phase 1 already produces normalised PCM s16le 16 kHz mono — Phase 2 just
 * wraps that in a WAV header before sending (we do NOT convert formats).
 */

const SARVAM_STT_WS_BASE = "wss://api.sarvam.ai/speech-to-text/ws?model=saaras:v3";
const HANDSHAKE_TIMEOUT_MS = 8000;
const RESPONSE_TIMEOUT_MS = 15000;

export interface SarvamSttRequest {
  /** Raw PCM s16le 16 kHz mono audio (no WAV header). */
  pcm16: Buffer;
  /** Sample rate of the PCM. Defaults to 16000. */
  sampleRate?: number;
  /** BCP-47 language code (required by Sarvam). Defaults to en-IN. */
  language?: string;
}

export interface SttPartialEvent {
  text: string;
  timestampMs: number;
}

export interface SttFinalEvent {
  text: string;
  language: string | null;
  requestId: string | null;
  /** Wall-clock ms from open → final received. */
  latencyMs: number;
  /** Raw response payload from Sarvam (for debug). */
  raw: Record<string, unknown>;
}

interface SttClientEvents {
  open: () => void;
  partial: (ev: SttPartialEvent) => void;
  final: (ev: SttFinalEvent) => void;
  error: (err: Error) => void;
  close: (code: number, reason: string) => void;
}

export class SarvamSttClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private startedAt = 0;
  private settled = false;
  private respTimer: NodeJS.Timeout | null = null;
  private language: string = "en-IN";

  override on<K extends keyof SttClientEvents>(event: K, listener: SttClientEvents[K]): this {
    return super.on(event, listener);
  }
  override emit<K extends keyof SttClientEvents>(event: K, ...args: Parameters<SttClientEvents[K]>): boolean {
    return super.emit(event, ...args);
  }

  /** Send a complete utterance for transcription. Resolves via `final` event. */
  transcribe(req: SarvamSttRequest): void {
    if (this.ws) throw new Error("SarvamSttClient already in flight");
    if (!config.sarvam.apiKey) {
      queueMicrotask(() => this.emit("error", new Error("SARVAM_API_KEY not set")));
      return;
    }
    const sampleRate = req.sampleRate ?? 16000;
    this.language = req.language ?? "en-IN";
    const wav = writeWavPcm16(req.pcm16, sampleRate);
    const url = `${SARVAM_STT_WS_BASE}&language-code=${encodeURIComponent(this.language)}`;

    this.startedAt = Date.now();
    const ws = new WebSocket(url, {
      headers: { "api-subscription-key": config.sarvam.apiKey },
      handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
    });
    this.ws = ws;

    ws.on("open", () => {
      this.emit("open");
      const payload = {
        audio: { data: wav.toString("base64"), encoding: "audio/wav", sample_rate: sampleRate },
        language_code: this.language,
      };
      ws.send(JSON.stringify(payload));
      this.respTimer = setTimeout(() => {
        this.fail(new Error("sarvam_stt_ws_timeout: no response within 15s"));
      }, RESPONSE_TIMEOUT_MS);
    });

    ws.on("message", (raw, isBinary) => {
      if (isBinary) return; // STT never sends binary
      this.handleTextFrame(raw.toString());
    });

    ws.on("error", (err) => {
      logger.warn({ err: err.message }, "sarvam_stt_ws error");
      this.fail(err);
    });

    ws.on("close", (code, reason) => {
      if (this.respTimer) { clearTimeout(this.respTimer); this.respTimer = null; }
      const reasonStr = reason?.toString() ?? "";
      this.emit("close", code, reasonStr);
      // If the server closed without sending us anything, surface a generic error
      // so the caller's promise doesn't hang.
      if (!this.settled) {
        this.fail(new Error(`sarvam_stt_ws_closed_without_response code=${code}`));
      }
    });
  }

  cancel(): void {
    if (this.ws && this.ws.readyState === this.ws.OPEN) {
      try { this.ws.close(); } catch { /* ignore */ }
    }
  }

  private handleTextFrame(text: string): void {
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch {
      logger.warn({ preview: text.slice(0, 120) }, "sarvam_stt_ws non-JSON frame");
      return;
    }
    if (typeof parsed !== "object" || parsed === null) return;
    const obj = parsed as { type?: string; data?: Record<string, unknown>; transcript?: string };

    if (obj.type === "error") {
      const msg = (obj.data?.["message"] as string | undefined) ?? "unknown STT error";
      logger.error({ data: obj.data }, "sarvam_stt_ws server error");
      this.fail(new Error(`sarvam_stt_ws_error: ${msg}`));
      return;
    }

    // The Sarvam STT response shape is poorly documented; defensively look in
    // a few likely locations for the transcript text. If/when a `partial` flag
    // appears we'll start emitting `partial` events; today we only see finals.
    const transcript =
      (typeof obj.transcript === "string" && obj.transcript) ||
      (obj.data && typeof obj.data["transcript"] === "string" && (obj.data["transcript"] as string)) ||
      (obj.data && typeof obj.data["text"] === "string" && (obj.data["text"] as string)) ||
      "";

    if (!transcript) {
      // Could be an interim status frame; ignore but log at debug-ish level.
      logger.info({ keys: Object.keys(obj) }, "sarvam_stt_ws frame without transcript");
      return;
    }

    const requestId = (obj.data?.["request_id"] as string | undefined) ?? null;
    const language =
      (obj.data?.["language_code"] as string | undefined) ??
      (obj.data?.["language"] as string | undefined) ??
      this.language;

    if (this.settled) return;
    this.settled = true;
    if (this.respTimer) { clearTimeout(this.respTimer); this.respTimer = null; }
    this.emit("final", {
      text: transcript,
      language,
      requestId,
      latencyMs: Date.now() - this.startedAt,
      raw: obj as Record<string, unknown>,
    });
  }

  private fail(err: Error): void {
    if (this.settled) return;
    this.settled = true;
    if (this.respTimer) { clearTimeout(this.respTimer); this.respTimer = null; }
    this.emit("error", err);
    if (this.ws && this.ws.readyState === this.ws.OPEN) {
      try { this.ws.close(); } catch { /* ignore */ }
    }
  }
}

/** Convenience: send PCM, resolve with the final transcript text. */
export function transcribePcm16(req: SarvamSttRequest): Promise<SttFinalEvent> {
  return new Promise((resolve, reject) => {
    const client = new SarvamSttClient();
    client.on("final", (ev) => resolve(ev));
    client.on("error", (err) => reject(err));
    client.transcribe(req);
  });
}
