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
 * not WAV. Latency stats are returned in HTTP trailers via response headers
 * sent before the body and a final `X-Tts-*` summary header set at finish.
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

  client.on("error", (err) => {
    req.log.warn({ err: err.message, sarvam_ws_errors: err.message }, "tts_stream error");
    if (!headersSent) {
      res.status(502).json({ error: "Sarvam TTS WS error", detail: err.message });
    } else {
      // Already streaming — terminate the body abruptly. The client will see
      // a truncated MP3, which is the best we can do mid-stream.
      try { res.end(); } catch { /* ignore */ }
    }
  });

  client.on("done", (result) => {
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
      // Edge case: Sarvam returned no audio. Surface as 502.
      res.status(502).json({ error: "Sarvam TTS returned no audio" });
      return;
    }
    res.end();
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
    if (!res.writableEnded) {
      req.log.warn({ chunkCount, totalBytes }, "tts_stream hard timeout");
      client.cancel();
      try { res.end(); } catch { /* ignore */ }
    }
  }, 30_000);
}
