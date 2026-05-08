import type { Request, Response } from "express";
import { SarvamTtsClient, type TtsAudioChunk } from "../../services/sarvam-tts-ws.client.js";
import { logger } from "../../lib/logger.js";

/**
 * POST /api/debug/tts-stream
 *
 * Body: { text: string, voice?: string, language?: string, sampleRateHz?: number }
 *
 * Streams the synthesized audio bytes back to the caller as they arrive from
 * Sarvam's TTS WebSocket. Sarvam currently only supports MP3 over its WS
 * (probed exhaustively May 2026 — `output_audio_codec` / `audio_encoding` /
 * `output_format` are silently ignored), so the response is `audio/mpeg`,
 * not WAV.
 *
 * Latency stats are surfaced two ways:
 *   1. As HTTP trailers (`Trailer:` header advertised before the body) so
 *      streaming-aware clients can read them after the body completes:
 *        X-Tts-First-Byte-Ms, X-Tts-Total-Ms, X-Tts-Chunks, X-Tts-Bytes,
 *        X-Tts-Request-Id
 *   2. Replicated as request log fields (`tts_first_byte_ms`,
 *      `tts_total_ms`) for server-side observability.
 */
export async function ttsStream(req: Request, res: Response): Promise<void> {
  const body = (req.body ?? {}) as {
    text?: string;
    voice?: string;
    language?: string;
    sampleRateHz?: number;
  };
  const text = (body.text ?? "").trim();
  if (!text) {
    res.status(400).json({ error: "Missing required field: text" });
    return;
  }
  if (text.length > 480) {
    res.status(400).json({ error: "text exceeds 480 chars (Sarvam TTS limit)" });
    return;
  }

  const client = new SarvamTtsClient();
  let headersSent = false;
  let settled = false; // single terminal-response guard
  let firstByteAtMs: number | null = null;
  let totalBytes = 0;
  let chunkCount = 0;
  const startedAt = Date.now();

  const ensureHeaders = (): void => {
    if (headersSent) return;
    headersSent = true;
    res.status(200);
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Transfer-Encoding", "chunked");
    res.setHeader("X-Sarvam-Codec", "audio/mpeg");
    res.setHeader("Cache-Control", "no-store");
    // Advertise the trailer fields we'll send after the body completes so that
    // streaming-aware clients know to read them.
    res.setHeader(
      "Trailer",
      "X-Tts-First-Byte-Ms, X-Tts-Total-Ms, X-Tts-Chunks, X-Tts-Bytes, X-Tts-Request-Id",
    );
  };

  client.on("open", () => {
    req.log.info({ text: text.slice(0, 60) }, "tts_stream open");
  });

  client.on("audio", (chunk: TtsAudioChunk) => {
    if (firstByteAtMs === null) {
      firstByteAtMs = chunk.arrivedAtMs;
      req.log.info({ tts_first_byte_ms: firstByteAtMs }, "tts_first_byte");
    }
    chunkCount++;
    totalBytes += chunk.mp3.length;
    ensureHeaders();
    res.write(chunk.mp3);
  });

  // Single terminal handler — `done` or `error` may both fire from the WS
  // layer in some race orderings (e.g. error → close → finish would emit a
  // second terminal). The `settled` guard ensures exactly one HTTP response
  // termination happens regardless of upstream event ordering, eliminating
  // ERR_HTTP_HEADERS_SENT and write-after-end crashes.
  client.on("error", (err) => {
    if (settled) return;
    settled = true;
    req.log.warn({ err: err.message, sarvam_ws_errors: err.message }, "tts_stream error");
    if (!headersSent) {
      res.status(502).json({ error: "Sarvam TTS WS error", detail: err.message });
      return;
    }
    // Already streaming — emit error trailers then end the body. Client will
    // see a truncated MP3 with the error reason in trailers.
    try {
      res.addTrailers({
        "X-Tts-First-Byte-Ms": String(firstByteAtMs ?? ""),
        "X-Tts-Total-Ms": String(Date.now() - startedAt),
        "X-Tts-Chunks": String(chunkCount),
        "X-Tts-Bytes": String(totalBytes),
        "X-Tts-Request-Id": "",
        "X-Tts-Error": err.message.slice(0, 200),
      });
      res.end();
    } catch { /* ignore writes-after-end */ }
  });

  client.on("done", (result) => {
    if (settled) return;
    settled = true;
    const totalMs = Date.now() - startedAt;
    req.log.info(
      {
        tts_first_byte_ms: result.firstByteMs,
        tts_total_ms: totalMs,
        chunks: result.chunks.length,
        bytes: totalBytes,
        requestId: result.requestId,
      },
      "tts_total_ms",
    );
    if (!headersSent) {
      res.status(502).json({
        error: "Sarvam TTS returned no audio",
        stats: { firstByteMs: null, totalMs, chunks: 0, bytes: 0, requestId: result.requestId },
      });
      return;
    }
    try {
      res.addTrailers({
        "X-Tts-First-Byte-Ms": String(result.firstByteMs ?? ""),
        "X-Tts-Total-Ms": String(totalMs),
        "X-Tts-Chunks": String(result.chunks.length),
        "X-Tts-Bytes": String(totalBytes),
        "X-Tts-Request-Id": result.requestId ?? "",
      });
      res.end();
    } catch { /* ignore writes-after-end */ }
  });

  // If the HTTP client disconnects, cancel the upstream WS so we don't keep
  // the socket open or get billed for unused frames.
  req.on("close", () => {
    if (!res.writableEnded) client.cancel();
  });

  try {
    client.start({
      text,
      speaker: body.voice ?? "priya",
      language: body.language ?? "en-IN",
      sampleRateHz: body.sampleRateHz ?? 16000,
    });
  } catch (err) {
    const e = err as Error;
    logger.error({ err: e }, "tts_stream start failed");
    if (!headersSent) {
      res.status(500).json({ error: "Failed to start TTS WS", detail: e.message });
    }
  }

  // Belt-and-suspenders timeout — Sarvam TTS WS should never run > 30s.
  setTimeout(() => {
    if (settled || res.writableEnded) return;
    settled = true;
    req.log.warn({ chunkCount, totalBytes }, "tts_stream hard timeout");
    client.cancel();
    try { res.end(); } catch { /* ignore */ }
  }, 30_000);
}
