import type { Request, Response } from "express";
import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import twilio from "twilio";
import { config } from "../../config/index.js";
import { logger } from "../../lib/logger.js";
import {
  subscribeMediaStream,
  type MediaStreamSession,
} from "../../websocket/media-stream.js";
import {
  muLawToPcm16,
  upsample8kTo16k,
  rmsPcm16,
  peakPcm16,
  writeWavPcm16,
} from "../../audio/codec.js";

const CAPTURE_ROOT = "/tmp/audio-captures";

interface CaptureSummary {
  id: string;
  callSid: string | null;
  to: string;
  detectedCodec: string;
  detectedSampleRate: number;
  detectedChannels: number;
  chunkCount: number;
  totalAudioMs: number;
  rms: { min: number; avg: number; max: number };
  peak: number;
  silenceMsEstimate: number;
  files: { rawUlaw: string; normalizedWav: string; summaryJson: string };
  startedAt: number;
  completedAt: number | null;
  status: "in_progress" | "complete" | "failed";
  error?: string;
}

interface PendingCapture {
  id: string;
  to: string;
  durationMs: number;
  callSid: string | null;
  startedAt: number;
  rawChunks: Buffer[];
  normalizedChunks: Buffer[];
  rmsValues: number[];
  silentChunkCount: number;
  format: { encoding: string; sampleRate: number; channels: number };
  resolve: (summary: CaptureSummary) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout | null;
}

const pendingByCorrelation = new Map<string, PendingCapture>();
const summariesById = new Map<string, CaptureSummary>();
// Bound in-memory growth; oldest summary is evicted when the cap is exceeded.
// Files on disk live under /tmp and are cleaned by the OS, so this only caps
// the lookup table for GET /audio-capture/:id.
const MAX_RETAINED_SUMMARIES = 25;

// Subscribe once at module load: any MediaStream session whose customParameters
// include a `captureId` we are waiting for is routed to that capture.
subscribeMediaStream({
  match(_callSid, params) {
    const id = params["captureId"];
    return !!id && pendingByCorrelation.has(id);
  },
  handler: {
    onStart(session) {
      const id = session.customParameters["captureId"]!;
      const cap = pendingByCorrelation.get(id);
      if (!cap) return;
      cap.callSid = session.callSid;
      cap.format = {
        encoding: session.format.encoding,
        sampleRate: session.format.sampleRate,
        channels: session.format.channels,
      };
      logger.info(
        { captureId: id, callSid: session.callSid, format: cap.format },
        "Audio capture: stream started",
      );
      // Schedule a hard cutoff so we always finalise even if the call hangs.
      cap.timer = setTimeout(() => {
        finaliseCapture(id, "complete").catch((err) => {
          logger.error({ err, captureId: id }, "Audio capture: finalise failed");
        });
      }, cap.durationMs + 2000);
    },
    onMedia(session, payload) {
      const id = session.customParameters["captureId"]!;
      const cap = pendingByCorrelation.get(id);
      if (!cap) return;
      cap.rawChunks.push(payload);
      // For μ-law @ 8 kHz: decode → upsample to 16 kHz PCM s16le for Sarvam-shape.
      const pcm8 = muLawToPcm16(payload);
      const pcm16 = upsample8kTo16k(pcm8);
      cap.normalizedChunks.push(pcm16);
      const rms = rmsPcm16(pcm8);
      cap.rmsValues.push(rms);
      // Per Twilio frame is 20ms; "silence" ≈ RMS < ~150 on a 16-bit scale.
      if (rms < 150) cap.silentChunkCount++;
    },
    onStop(session) {
      const id = session.customParameters["captureId"];
      if (!id) return;
      finaliseCapture(id, "complete").catch((err) => {
        logger.error({ err, captureId: id, callSid: session.callSid }, "Audio capture: finalise on stop failed");
      });
    },
  },
});

async function finaliseCapture(id: string, status: "complete" | "failed", errorMsg?: string): Promise<void> {
  const cap = pendingByCorrelation.get(id);
  if (!cap) return;
  pendingByCorrelation.delete(id);
  if (cap.timer) clearTimeout(cap.timer);

  try {
    const dir = path.join(CAPTURE_ROOT, id);
    await fs.mkdir(dir, { recursive: true });

    const rawBuf = Buffer.concat(cap.rawChunks);
    const normBuf = Buffer.concat(cap.normalizedChunks);
    const wavBuf = writeWavPcm16(normBuf, 16000);

    const rawPath = path.join(dir, "raw.ulaw");
    const wavPath = path.join(dir, "normalized.wav");
    const summaryPath = path.join(dir, "summary.json");

    await fs.writeFile(rawPath, rawBuf);
    await fs.writeFile(wavPath, wavBuf);

    const rmsArr = cap.rmsValues;
    const rmsMin = rmsArr.length ? Math.min(...rmsArr) : 0;
    const rmsMax = rmsArr.length ? Math.max(...rmsArr) : 0;
    const rmsAvg = rmsArr.length ? rmsArr.reduce((a, b) => a + b, 0) / rmsArr.length : 0;
    const peak = peakPcm16(normBuf);
    // Each μ-law frame is 20 ms (160 bytes) at 8 kHz; use raw byte count for ms.
    const totalAudioMs =
      cap.format.encoding === "audio/x-mulaw"
        ? rawBuf.length / (cap.format.sampleRate / 1000)
        : 0;

    const summary: CaptureSummary = {
      id,
      callSid: cap.callSid,
      to: cap.to,
      detectedCodec: cap.format.encoding,
      detectedSampleRate: cap.format.sampleRate,
      detectedChannels: cap.format.channels,
      chunkCount: cap.rawChunks.length,
      totalAudioMs: Math.round(totalAudioMs),
      rms: { min: Math.round(rmsMin), avg: Math.round(rmsAvg), max: Math.round(rmsMax) },
      peak,
      silenceMsEstimate: cap.silentChunkCount * 20,
      files: { rawUlaw: rawPath, normalizedWav: wavPath, summaryJson: summaryPath },
      startedAt: cap.startedAt,
      completedAt: Date.now(),
      status,
      ...(errorMsg ? { error: errorMsg } : {}),
    };

    await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2));
    summariesById.set(id, summary);
    while (summariesById.size > MAX_RETAINED_SUMMARIES) {
      const oldestKey = summariesById.keys().next().value;
      if (oldestKey === undefined) break;
      summariesById.delete(oldestKey);
    }

    logger.info(
      {
        captureId: id,
        callSid: cap.callSid,
        chunkCount: summary.chunkCount,
        totalAudioMs: summary.totalAudioMs,
        rmsAvg: summary.rms.avg,
        peak: summary.peak,
      },
      "Audio capture: finalised",
    );

    cap.resolve(summary);
  } catch (err) {
    const e = err as Error;
    logger.error({ err: e, captureId: id }, "Audio capture: finalise threw");
    cap.reject(e);
  }
}

/** POST /api/debug/audio-capture/start */
export async function startAudioCapture(req: Request, res: Response): Promise<void> {
  const body = (req.body ?? {}) as { to?: string; durationMs?: number };
  const to = (body.to ?? "").trim();
  const durationMs = Math.min(60_000, Math.max(2_000, Number(body.durationMs ?? 10_000)));

  if (!to) {
    res.status(400).json({ error: "Missing required field: to (E.164 phone)" });
    return;
  }
  if (!config.twilio.accountSid || !config.twilio.authToken || !config.twilio.phoneNumber) {
    res.status(500).json({ error: "Twilio platform credentials are not configured" });
    return;
  }

  const id = randomUUID();
  const twimlUrl = `${config.baseUrl}/api/debug/audio-capture/twiml/${id}?durationMs=${durationMs}`;

  // Pre-register the pending capture so the WS subscriber can pick it up.
  const settle = new Promise<CaptureSummary>((resolve, reject) => {
    const cap: PendingCapture = {
      id,
      to,
      durationMs,
      callSid: null,
      startedAt: Date.now(),
      rawChunks: [],
      normalizedChunks: [],
      rmsValues: [],
      silentChunkCount: 0,
      format: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 },
      resolve,
      reject,
      timer: null,
    };
    pendingByCorrelation.set(id, cap);
  });

  let callSid: string;
  try {
    const client = twilio(config.twilio.accountSid, config.twilio.authToken);
    const call = await client.calls.create({
      to,
      from: config.twilio.phoneNumber,
      url: twimlUrl,
      method: "POST",
    });
    callSid = call.sid;
    req.log.info({ captureId: id, callSid, to, durationMs }, "Audio capture: outbound call initiated");
  } catch (err) {
    pendingByCorrelation.delete(id);
    req.log.error({ err, captureId: id, to }, "Audio capture: failed to initiate Twilio call");
    res.status(502).json({ error: "Failed to initiate Twilio call", detail: (err as Error).message });
    return;
  }

  // Hard wall-clock cap: durationMs + 60s for ringing/connection + finalise.
  const safetyTimer = setTimeout(() => {
    if (pendingByCorrelation.has(id)) {
      finaliseCapture(id, "failed", "Capture timed out — call may not have been answered").catch(() => {});
    }
  }, durationMs + 60_000);

  try {
    const summary = await settle;
    clearTimeout(safetyTimer);
    res.status(200).json(summary);
  } catch (err) {
    clearTimeout(safetyTimer);
    res.status(500).json({ error: "Capture failed", detail: (err as Error).message, id, callSid });
  }
}

/** POST /api/debug/audio-capture/twiml/:id — Twilio fetches this. */
export function audioCaptureTwiml(req: Request, res: Response): void {
  const id = String(req.params["id"] ?? "");
  if (!id) {
    res.status(400).type("text/plain").send("Missing capture id");
    return;
  }
  // Twilio expects wss:// for <Stream url="..."/>. Rewrite https → wss.
  const wsBase = config.baseUrl.replace(/^https:/i, "wss:").replace(/^http:/i, "ws:");
  const streamUrl = `${wsBase}/api/voice/stream`;
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${streamUrl}">
      <Parameter name="captureId" value="${id}"/>
    </Stream>
  </Connect>
</Response>`;
  res.setHeader("Content-Type", "text/xml");
  res.send(twiml);
}

/**
 * GET /api/debug/audio-capture/:id — content-negotiated retrieval.
 *
 * Per the task spec, this route returns the saved WAV file for download by
 * default. Pass `?format=summary` (or send `Accept: application/json`) to get
 * the JSON audio-health summary instead, and `?format=ulaw` for the raw μ-law
 * payload.
 */
export async function getAudioCapture(req: Request, res: Response): Promise<void> {
  const id = String(req.params["id"] ?? "");
  const summary = summariesById.get(id);
  if (!summary) {
    res.status(404).json({ error: "Capture not found" });
    return;
  }
  const queryFormat = String(req.query["format"] ?? "").toLowerCase();
  const wantsJson =
    queryFormat === "summary" ||
    queryFormat === "json" ||
    (req.headers["accept"]?.includes("application/json") && !queryFormat);

  if (wantsJson) {
    res.json(summary);
    return;
  }

  const wantsRaw = queryFormat === "ulaw" || queryFormat === "raw";
  const filePath = wantsRaw ? summary.files.rawUlaw : summary.files.normalizedWav;
  const contentType = wantsRaw ? "audio/basic" : "audio/wav";
  const ext = wantsRaw ? "ulaw" : "wav";
  try {
    const buf = await fs.readFile(filePath);
    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${id}.${ext}"`);
    res.send(buf);
  } catch (err) {
    req.log.warn({ err, id, format: queryFormat }, "Audio capture: file read failed");
    res.status(404).json({ error: "File not found on disk" });
  }
}

/** GET /api/debug/audio-capture/:id/file/:kind — explicit kind = wav | ulaw */
export async function getAudioCaptureFile(req: Request, res: Response): Promise<void> {
  const id = String(req.params["id"] ?? "");
  const kind = String(req.params["kind"] ?? "");
  const summary = summariesById.get(id);
  if (!summary) {
    res.status(404).json({ error: "Capture not found" });
    return;
  }
  const filePath =
    kind === "wav" ? summary.files.normalizedWav :
    kind === "ulaw" ? summary.files.rawUlaw :
    null;
  if (!filePath) {
    res.status(400).json({ error: "kind must be 'wav' or 'ulaw'" });
    return;
  }
  try {
    const buf = await fs.readFile(filePath);
    res.setHeader("Content-Type", kind === "wav" ? "audio/wav" : "audio/basic");
    res.setHeader("Content-Disposition", `attachment; filename="${id}.${kind}"`);
    res.send(buf);
  } catch (err) {
    req.log.warn({ err, id, kind }, "Audio capture: file read failed");
    res.status(404).json({ error: "File not found on disk" });
  }
}
