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
const HANDSHAKE_TIMEOUT_MS = 4000;
// Response timeout for the STT WS: must comfortably exceed MAX_LISTEN_MS
// (8s in call-session.ts) plus Sarvam's processing time on the audio.
// Previously was 6s which is STRUCTURALLY broken — Sarvam can't return a
// final for an 8s utterance in less than 8s of upload + processing time,
// guaranteeing timeouts on long replies (observed: turn 2 of CA d8d4 at
// 10:26 timed out). 12s gives ~4s of Sarvam-side headroom while still
// re-prompting the caller before they hang up.
// Override via SARVAM_STT_RESPONSE_TIMEOUT_MS.
export const STT_RESPONSE_TIMEOUT_MS = (() => {
  const raw = Number(process.env.SARVAM_STT_RESPONSE_TIMEOUT_MS);
  if (Number.isFinite(raw) && raw >= 1000 && raw <= 30000) return raw;
  return 12000;
})();
const RESPONSE_TIMEOUT_MS = STT_RESPONSE_TIMEOUT_MS;

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
  private wsOpened = false;
  private wsOpenedAt = 0;
  private startedAt = 0;
  private payloadSentAt = 0;
  private pendingRequest: SarvamSttRequest | null = null;
  private settled = false;
  private cancelled = false;
  private respTimer: NodeJS.Timeout | null = null;
  private language: string = "en-IN";

  override on<K extends keyof SttClientEvents>(event: K, listener: SttClientEvents[K]): this {
    return super.on(event, listener);
  }
  override emit<K extends keyof SttClientEvents>(event: K, ...args: Parameters<SttClientEvents[K]>): boolean {
    return super.emit(event, ...args);
  }

  /**
   * Pre-warm the WS connection without sending audio. Lets `CallSession` open
   * a socket during BOT_SPEAKING so the handshake cost (~300-800ms in
   * practice, but observed up to 12s on cold turn-1 cases) is paid before the
   * user finishes their reply rather than after. Resolves once the server's
   * `open` event fires; rejects on handshake error.
   *
   * The response timer is NOT started here — it only starts when `transcribe`
   * actually sends the payload. Idle warm sockets that the server closes are
   * surfaced via `wsOpened=false` so the next `transcribe()` falls back to a
   * cold open.
   */
  async prewarm(language?: string): Promise<void> {
    if (this.ws) return;
    if (!config.sarvam.apiKey) throw new Error("SARVAM_API_KEY not set");
    if (language) this.language = language;
    await new Promise<void>((resolve, reject) => {
      this.openSocket((err) => err ? reject(err) : resolve());
    });
  }

  /**
   * True when the WS handshake has completed, the socket is still OPEN, and
   * less than `maxIdleMs` have passed since open. Callers should fall back to
   * a cold open if this returns false.
   */
  isWarm(maxIdleMs = 30000): boolean {
    return (
      this.wsOpened &&
      !!this.ws &&
      this.ws.readyState === WebSocket.OPEN &&
      Date.now() - this.wsOpenedAt < maxIdleMs
    );
  }

  /** Send a complete utterance for transcription. Resolves via `final` event. */
  transcribe(req: SarvamSttRequest): void {
    if (this.payloadSentAt) throw new Error("SarvamSttClient already in flight");
    if (!config.sarvam.apiKey) {
      queueMicrotask(() => this.emit("error", new Error("SARVAM_API_KEY not set")));
      return;
    }
    if (req.language) this.language = req.language;
    this.pendingRequest = req;
    this.startedAt = Date.now();

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.sendPayload();
      return;
    }
    if (this.ws && this.ws.readyState === WebSocket.CONNECTING) {
      // prewarm in progress — sendPayload will fire on open
      return;
    }
    // Cold path: open the socket and let the open handler send.
    this.openSocket();
  }

  private openSocket(onHandshake?: (err: Error | null) => void): void {
    const url = `${SARVAM_STT_WS_BASE}&language-code=${encodeURIComponent(this.language)}`;
    const ws = new WebSocket(url, {
      headers: { "api-subscription-key": config.sarvam.apiKey! },
      handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
    });
    this.ws = ws;
    let handshakeSettled = false;
    const settleHandshake = (err: Error | null): void => {
      if (handshakeSettled) return;
      handshakeSettled = true;
      onHandshake?.(err);
    };

    ws.on("open", () => {
      if (this.cancelled) {
        try { ws.terminate(); } catch { /* ignore */ }
        settleHandshake(new Error("cancelled"));
        return;
      }
      this.wsOpened = true;
      this.wsOpenedAt = Date.now();
      this.emit("open");
      settleHandshake(null);
      if (this.pendingRequest) this.sendPayload();
    });

    ws.on("message", (raw, isBinary) => {
      if (isBinary) return; // STT never sends binary
      this.handleTextFrame(raw.toString());
    });

    ws.on("error", (err) => {
      logger.warn({ err: err.message }, "sarvam_stt_ws error");
      settleHandshake(err);
      this.fail(err);
    });

    ws.on("close", (code, reason) => {
      if (this.respTimer) { clearTimeout(this.respTimer); this.respTimer = null; }
      const reasonStr = reason?.toString() ?? "";
      this.emit("close", code, reasonStr);
      // Idle close on a warm socket (no payload sent yet) is not an error —
      // mark the client unusable so the next transcribe() falls back to cold.
      if (!this.payloadSentAt && !this.pendingRequest) {
        this.wsOpened = false;
        this.ws = null;
        settleHandshake(new Error(`sarvam_stt_ws_idle_close code=${code}`));
        return;
      }
      // If the server closed without sending us anything, surface a generic error
      // so the caller's promise doesn't hang.
      if (!this.settled) {
        this.fail(new Error(`sarvam_stt_ws_closed_without_response code=${code}`));
      }
    });
  }

  private sendPayload(): void {
    if (this.cancelled || !this.pendingRequest || !this.ws) return;
    const req = this.pendingRequest;
    const sampleRate = req.sampleRate ?? 16000;
    const wav = writeWavPcm16(req.pcm16, sampleRate);
    const payload = {
      audio: { data: wav.toString("base64"), encoding: "audio/wav", sample_rate: sampleRate },
      language_code: this.language,
    };
    try {
      this.ws.send(JSON.stringify(payload));
    } catch (err) {
      this.fail(err as Error);
      return;
    }
    this.payloadSentAt = Date.now();
    this.respTimer = setTimeout(() => {
      this.fail(new Error(`sarvam_stt_ws_timeout: no response within ${RESPONSE_TIMEOUT_MS}ms`));
    }, RESPONSE_TIMEOUT_MS);
  }

  /**
   * Cancel the in-flight request; safe to call multiple times and from any
   * socket state (CONNECTING, OPEN, CLOSING). Sets `cancelled` so that a late
   * `open` event cannot still ship the payload, marks the client settled to
   * suppress further terminal events, and forcibly tears down the socket via
   * `terminate()` (TCP RST). `close()` is a no-op while CONNECTING and would
   * leak the socket until handshake timeout, so we use `terminate()` instead.
   */
  cancel(): void {
    this.cancelled = true;
    this.settled = true;
    if (this.respTimer) { clearTimeout(this.respTimer); this.respTimer = null; }
    const ws = this.ws;
    if (!ws) return;
    try {
      if (ws.readyState === ws.CONNECTING || ws.readyState === ws.OPEN) {
        ws.terminate();
      }
    } catch { /* ignore */ }
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
    const ws = this.ws;
    if (ws) {
      try {
        if (ws.readyState === ws.CONNECTING || ws.readyState === ws.OPEN) {
          ws.terminate();
        }
      } catch { /* ignore */ }
    }
  }
}

/**
 * Errors that are worth retrying. We treat WS timeouts, abnormal closes and
 * generic network failures as transient; Pydantic validation / auth errors
 * coming back as `sarvam_stt_ws_error` are NOT retried because re-sending the
 * same payload will fail identically.
 */
function isTransientSttError(err: Error): boolean {
  const m = err.message;
  if (m.startsWith("sarvam_stt_ws_error:")) return false;
  if (m.includes("SARVAM_API_KEY")) return false;
  return (
    m.includes("timeout") ||
    m.includes("closed_without_response") ||
    m.includes("ECONNRESET") ||
    m.includes("ETIMEDOUT") ||
    m.includes("ENOTFOUND") ||
    m.includes("EAI_AGAIN") ||
    m.includes("socket hang up") ||
    m.includes("network")
  );
}

/** Single-attempt convenience — used internally by `transcribePcm16`. */
function transcribeOnce(req: SarvamSttRequest): Promise<SttFinalEvent> {
  return new Promise((resolve, reject) => {
    const client = new SarvamSttClient();
    client.on("final", (ev) => resolve(ev));
    client.on("error", (err) => reject(err));
    client.transcribe(req);
  });
}

export interface TranscribeOptions {
  /** Max additional retry attempts on transient errors (default 2 → 3 total). */
  maxRetries?: number;
  /** Initial backoff in ms; doubles each retry, capped at 4000ms. */
  initialBackoffMs?: number;
}

/**
 * Convenience: send PCM, resolve with the final transcript.
 *
 * Implements bounded exponential backoff for transient WS errors (timeouts,
 * abnormal closes, network blips). Server-side validation errors and missing
 * credentials are NOT retried because re-sending the same payload would fail
 * identically. After `maxRetries` exhausted attempts, the last error is
 * propagated wrapped with attempt count for observability.
 */
export async function transcribePcm16(
  req: SarvamSttRequest,
  opts: TranscribeOptions = {},
): Promise<SttFinalEvent> {
  const maxRetries = Math.max(0, opts.maxRetries ?? 2);
  const initial = Math.max(50, opts.initialBackoffMs ?? 250);
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const out = await transcribeOnce(req);
      if (attempt > 0) {
        logger.info({ attempt: attempt + 1 }, "sarvam_stt_ws succeeded after retry");
      }
      return out;
    } catch (err) {
      lastErr = err as Error;
      if (attempt === maxRetries || !isTransientSttError(lastErr)) break;
      const backoff = Math.min(4000, initial * 2 ** attempt);
      logger.warn(
        { attempt: attempt + 1, maxAttempts: maxRetries + 1, backoffMs: backoff, err: lastErr.message },
        "sarvam_stt_ws transient error — retrying",
      );
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  const e = new Error(
    `sarvam_stt_ws_failed_after_${maxRetries + 1}_attempts: ${lastErr?.message ?? "unknown"}`,
  );
  throw e;
}
