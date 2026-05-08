import { EventEmitter } from "events";
import WebSocket from "ws";
import { config } from "../config/index.js";
import { logger } from "../lib/logger.js";

/**
 * Sarvam TTS WebSocket client (streaming synthesis).
 *
 * Discovered protocol (May 2026):
 *   URL:     wss://api.sarvam.ai/text-to-speech/ws?model=bulbul:v3
 *   Auth:    api-subscription-key: <SARVAM_API_KEY>
 *   Send #1: { type: "config", data: { target_language_code, speaker, model,
 *                                       target_sample_rate_hz } }
 *   Send #2: { type: "text",   data: { text } }
 *   Receive: { type: "audio",  data: { audio: <base64-MP3>,
 *                                       content_type: "audio/mpeg",
 *                                       request_id } }   (many of these)
 *
 * IMPORTANT: Sarvam streams **MP3** chunks via TEXT frames, not PCM/WAV. There
 * is no documented option to switch the WS output to linear PCM (probed
 * `output_audio_codec`, `audio_encoding`, `encoding`, `output_format` — all
 * silently ignored or rejected). Phase 3 will need an MP3 decoder if it wants
 * to mix this audio back into the call leg as μ-law; for Phase 2 we expose
 * the raw MP3 stream via an async iterator and a "collect to single MP3
 * buffer" convenience.
 *
 * Sending text before the server has acknowledged config returns
 *   { type:"error", data:{ message:"config required before text", code:422 } }
 * — so we wait briefly between config and text. Sarvam does not emit a
 * positive `config_ack` frame; absence of an error within ~200ms means OK.
 */

const SARVAM_TTS_WS_URL = "wss://api.sarvam.ai/text-to-speech/ws?model=bulbul:v3";
const CONFIG_GRACE_MS = 200;
const HANDSHAKE_TIMEOUT_MS = 8000;
const STREAM_IDLE_TIMEOUT_MS = 30000;
// Belt-and-suspenders: even if the WS handshakeTimeout misfires, never let a
// SarvamTtsClient hang for more than this long without emitting done/error.
const OVERALL_TIMEOUT_MS = 35000;

export interface SarvamTtsConfig {
  text: string;
  speaker?: string;
  language?: string;
  sampleRateHz?: number;
}

export interface TtsAudioChunk {
  /** Raw MP3 bytes (decoded from base64). */
  mp3: Buffer;
  /** Wall-clock ms since the WS opened. */
  arrivedAtMs: number;
  /** Sequence number (1-based). */
  index: number;
}

export interface TtsStreamResult {
  chunks: TtsAudioChunk[];
  /** Single concatenated MP3 buffer of all chunks. */
  mp3Buffer: Buffer;
  firstByteMs: number | null;
  totalStreamMs: number;
  requestId: string | null;
}

interface TtsClientEvents {
  open: () => void;
  audio: (chunk: TtsAudioChunk) => void;
  done: (result: TtsStreamResult) => void;
  error: (err: Error) => void;
  close: (code: number, reason: string) => void;
}

export class SarvamTtsClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private chunks: TtsAudioChunk[] = [];
  private startedAt = 0;
  private firstByteAt: number | null = null;
  private requestId: string | null = null;
  private done = false;
  private terminated = false;
  private idleTimer: NodeJS.Timeout | null = null;
  private overallTimer: NodeJS.Timeout | null = null;

  override on<K extends keyof TtsClientEvents>(event: K, listener: TtsClientEvents[K]): this {
    return super.on(event, listener);
  }
  override emit<K extends keyof TtsClientEvents>(event: K, ...args: Parameters<TtsClientEvents[K]>): boolean {
    return super.emit(event, ...args);
  }

  /** Open the WS, send config + text, and stream audio chunks until idle. */
  start(opts: SarvamTtsConfig): void {
    if (this.ws) throw new Error("SarvamTtsClient already started");
    if (!config.sarvam.apiKey) {
      queueMicrotask(() => this.emit("error", new Error("SARVAM_API_KEY not set")));
      return;
    }

    this.startedAt = Date.now();
    const ws = new WebSocket(SARVAM_TTS_WS_URL, {
      headers: { "api-subscription-key": config.sarvam.apiKey },
      handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
    });
    this.ws = ws;
    this.overallTimer = setTimeout(() => {
      if (!this.terminated) {
        logger.warn({ chunks: this.chunks.length }, "sarvam_tts_ws overall timeout");
        this.fail(new Error("sarvam_tts_ws_overall_timeout"));
      }
    }, OVERALL_TIMEOUT_MS);

    ws.on("open", () => {
      this.emit("open");
      ws.send(JSON.stringify({
        type: "config",
        data: {
          target_language_code: opts.language ?? "en-IN",
          speaker: opts.speaker ?? "priya",
          model: "bulbul:v3",
          target_sample_rate_hz: opts.sampleRateHz ?? 16000,
        },
      }));
      // Sarvam needs a brief grace period before accepting the text payload.
      setTimeout(() => {
        if (ws.readyState !== ws.OPEN) return;
        ws.send(JSON.stringify({ type: "text", data: { text: opts.text } }));
        this.armIdleTimer();
      }, CONFIG_GRACE_MS);
    });

    ws.on("message", (raw, isBinary) => {
      if (isBinary) {
        // Not expected for TTS WS, but tolerate: treat as raw audio chunk.
        this.handleAudioBuffer(raw as Buffer);
        return;
      }
      this.handleTextFrame(raw.toString());
    });

    ws.on("error", (err) => {
      logger.warn({ err: err.message }, "sarvam_tts_ws error");
      this.fail(err);
    });

    ws.on("close", (code, reason) => {
      this.clearIdleTimer();
      const reasonStr = reason?.toString() ?? "";
      logger.info(
        { code, reason: reasonStr, chunks: this.chunks.length, firstByteMs: this.firstByteAt },
        "sarvam_tts_ws closed",
      );
      // Only emit terminal `done` if we haven't already terminated via error.
      if (!this.terminated) this.finish();
      this.emit("close", code, reasonStr);
    });
  }

  /** Cancel the stream; safe to call multiple times. */
  cancel(): void {
    this.clearIdleTimer();
    if (this.ws && this.ws.readyState === this.ws.OPEN) {
      try { this.ws.close(); } catch { /* ignore */ }
    }
  }

  private handleTextFrame(text: string): void {
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch {
      logger.warn({ preview: text.slice(0, 120) }, "sarvam_tts_ws non-JSON frame");
      return;
    }
    if (typeof parsed !== "object" || parsed === null) return;
    const obj = parsed as { type?: string; data?: Record<string, unknown> };
    if (obj.type === "audio" && obj.data && typeof obj.data["audio"] === "string") {
      const b64 = obj.data["audio"] as string;
      this.requestId = (obj.data["request_id"] as string | undefined) ?? this.requestId;
      this.handleAudioBuffer(Buffer.from(b64, "base64"));
      return;
    }
    if (obj.type === "error") {
      const msg = (obj.data?.["message"] as string | undefined) ?? "unknown TTS error";
      const err = new Error(`sarvam_tts_ws_error: ${msg}`);
      logger.error({ data: obj.data }, "sarvam_tts_ws server error");
      this.fail(err);
      return;
    }
    // ignore unknown control frames (e.g. potential future "done" markers)
  }

  private handleAudioBuffer(mp3: Buffer): void {
    if (mp3.length === 0) return;
    const arrivedAtMs = Date.now() - this.startedAt;
    if (this.firstByteAt === null) this.firstByteAt = arrivedAtMs;
    const chunk: TtsAudioChunk = { mp3, arrivedAtMs, index: this.chunks.length + 1 };
    this.chunks.push(chunk);
    this.emit("audio", chunk);
    this.armIdleTimer();
  }

  private armIdleTimer(): void {
    this.clearIdleTimer();
    // Sarvam doesn't send an explicit end-of-stream marker. We treat ~500ms
    // of silence after first audio as the end of the synthesis (covers the
    // ~30ms inter-chunk cadence observed in probes). Before any audio
    // arrives, fall back to the much larger idle timeout.
    const ms = this.firstByteAt !== null ? 500 : STREAM_IDLE_TIMEOUT_MS;
    this.idleTimer = setTimeout(() => this.finish(), ms);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
  }

  /**
   * Terminal: emit a single `done` event. No-op once any terminal event has
   * been emitted (via either `done` or `error`). Guarantees the consumer sees
   * exactly one of done/error per session.
   */
  private finish(): void {
    if (this.terminated) return;
    this.terminated = true;
    this.done = true;
    this.clearIdleTimer();
    if (this.overallTimer) { clearTimeout(this.overallTimer); this.overallTimer = null; }
    const result: TtsStreamResult = {
      chunks: this.chunks,
      mp3Buffer: Buffer.concat(this.chunks.map((c) => c.mp3)),
      firstByteMs: this.firstByteAt,
      totalStreamMs: Date.now() - this.startedAt,
      requestId: this.requestId,
    };
    this.emit("done", result);
    if (this.ws && this.ws.readyState === this.ws.OPEN) {
      try { this.ws.close(); } catch { /* ignore */ }
    }
  }

  /**
   * Terminal: emit a single `error` event. No-op once any terminal event has
   * been emitted. Cancels the underlying socket so no further frames arrive.
   */
  private fail(err: Error): void {
    if (this.terminated) return;
    this.terminated = true;
    this.clearIdleTimer();
    if (this.overallTimer) { clearTimeout(this.overallTimer); this.overallTimer = null; }
    this.emit("error", err);
    if (this.ws && this.ws.readyState === this.ws.OPEN) {
      try { this.ws.close(); } catch { /* ignore */ }
    }
  }
}

/**
 * Convenience: synthesize text and resolve once the stream has ended,
 * returning the concatenated MP3 buffer plus per-chunk timings.
 */
export function synthesizeToBuffer(opts: SarvamTtsConfig): Promise<TtsStreamResult> {
  return new Promise((resolve, reject) => {
    const client = new SarvamTtsClient();
    let settled = false;
    client.on("done", (r) => { if (!settled) { settled = true; resolve(r); } });
    client.on("error", (err) => { if (!settled) { settled = true; reject(err); client.cancel(); } });
    client.start(opts);
  });
}
