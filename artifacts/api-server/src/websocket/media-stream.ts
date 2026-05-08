import type { Server as HttpServer, IncomingMessage } from "http";
import { WebSocketServer, type WebSocket } from "ws";
import { logger } from "../lib/logger.js";
import { muLawToPcm16, rmsPcm16 } from "../audio/codec.js";

/**
 * Twilio Media Streams WebSocket server.
 *
 * Twilio establishes a bidirectional WS connection (TwiML <Connect><Stream/>)
 * and sends JSON envelopes:
 *   { event: "connected", protocol, version }
 *   { event: "start", start: { streamSid, callSid, mediaFormat: { encoding, sampleRate, channels }, ... } }
 *   { event: "media", media: { track, chunk, timestamp, payload (base64 μ-law 8kHz) } }
 *   { event: "stop", stop: { ... } }
 *
 * This server:
 *   - mounts on the existing HTTP server at /api/voice/stream
 *   - parses envelopes, decodes media payloads to raw μ-law buffers
 *   - exposes a per-call subscriber API so other modules (debug capture in
 *     Phase 1, Sarvam STT bridge in Phase 2+) can attach to a session
 *   - logs structured metadata on session open/close
 */

export const MEDIA_STREAM_PATH = "/api/voice/stream";

export interface MediaStreamFormat {
  encoding: string;        // typically "audio/x-mulaw"
  sampleRate: number;      // typically 8000
  channels: number;        // typically 1
}

export interface MediaStreamSession {
  streamSid: string;
  callSid: string;
  customParameters: Record<string, string>;
  format: MediaStreamFormat;
  startedAt: number;
  chunkCount: number;
  totalAudioBytes: number;
  /** Running sum of per-chunk RMS values (μ-law tracks only). */
  rmsSum: number;
  /** Number of chunks whose RMS was sampled (used to compute average). */
  rmsCount: number;
  /** Send an outbound μ-law-encoded audio payload back to Twilio. */
  sendAudio(muLawPayload: Buffer): void;
  /** Send a Twilio "mark" event (echoed back when playback completes). */
  sendMark(name: string): void;
  /** Tell Twilio to discard any buffered outbound audio. */
  clear(): void;
  /** Close the underlying WebSocket. */
  close(): void;
}

export interface MediaStreamHandler {
  onStart?(session: MediaStreamSession): void;
  onMedia?(session: MediaStreamSession, payload: Buffer, timestampMs: number): void;
  onMark?(session: MediaStreamSession, name: string): void;
  onStop?(session: MediaStreamSession): void;
}

/**
 * Subscribers are matched by Twilio CallSid. The first subscriber whose
 * `match(callSid)` returns true wins for that call. This keeps the server
 * generic; Phase 1 uses it for debug capture, Phase 2+ for the live STT/TTS
 * bridge.
 */
export interface MediaStreamSubscriber {
  match(callSid: string, customParameters: Record<string, string>): boolean;
  handler: MediaStreamHandler;
}

const subscribers: MediaStreamSubscriber[] = [];

/** Register a subscriber. Returns an unsubscribe function. */
export function subscribeMediaStream(sub: MediaStreamSubscriber): () => void {
  subscribers.push(sub);
  return () => {
    const i = subscribers.indexOf(sub);
    if (i >= 0) subscribers.splice(i, 1);
  };
}

function pickSubscriber(callSid: string, params: Record<string, string>): MediaStreamSubscriber | null {
  for (const s of subscribers) {
    try {
      if (s.match(callSid, params)) return s;
    } catch (err) {
      logger.warn({ err, callSid }, "MediaStream subscriber match() threw");
    }
  }
  return null;
}

function buildSession(ws: WebSocket, start: {
  streamSid: string;
  callSid: string;
  customParameters?: Record<string, string>;
  mediaFormat?: Partial<MediaStreamFormat>;
}): MediaStreamSession {
  const format: MediaStreamFormat = {
    encoding: start.mediaFormat?.encoding ?? "audio/x-mulaw",
    sampleRate: start.mediaFormat?.sampleRate ?? 8000,
    channels: start.mediaFormat?.channels ?? 1,
  };
  const session: MediaStreamSession = {
    streamSid: start.streamSid,
    callSid: start.callSid,
    customParameters: start.customParameters ?? {},
    format,
    startedAt: Date.now(),
    chunkCount: 0,
    totalAudioBytes: 0,
    rmsSum: 0,
    rmsCount: 0,
    sendAudio(payload: Buffer) {
      if (ws.readyState !== ws.OPEN) return;
      ws.send(JSON.stringify({
        event: "media",
        streamSid: session.streamSid,
        media: { payload: payload.toString("base64") },
      }));
    },
    sendMark(name: string) {
      if (ws.readyState !== ws.OPEN) return;
      ws.send(JSON.stringify({
        event: "mark",
        streamSid: session.streamSid,
        mark: { name },
      }));
    },
    clear() {
      if (ws.readyState !== ws.OPEN) return;
      ws.send(JSON.stringify({ event: "clear", streamSid: session.streamSid }));
    },
    close() {
      try { ws.close(); } catch { /* ignore */ }
    },
  };
  return session;
}

export function attachMediaStreamServer(httpServer: HttpServer): void {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (req: IncomingMessage, socket, head) => {
    const url = req.url ?? "";
    // Strip query string; Twilio appends none, but be defensive.
    const path = url.split("?")[0];
    if (path !== MEDIA_STREAM_PATH) return;
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    let session: MediaStreamSession | null = null;
    let subscriber: MediaStreamSubscriber | null = null;
    const remote = req.socket.remoteAddress;
    logger.info({ remote }, "MediaStream WS connection opened");

    ws.on("message", (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch (err) {
        logger.warn({ err }, "MediaStream non-JSON frame ignored");
        return;
      }
      const event = msg.event as string | undefined;
      if (!event) return;

      switch (event) {
        case "connected":
          logger.info({ protocol: msg.protocol, version: msg.version }, "MediaStream connected");
          break;

        case "start": {
          const start = msg.start ?? {};
          session = buildSession(ws, start);
          subscriber = pickSubscriber(session.callSid, session.customParameters);
          logger.info(
            {
              callSid: session.callSid,
              streamSid: session.streamSid,
              inboundCodec: session.format.encoding,
              inboundSampleRate: session.format.sampleRate,
              inboundChannels: session.format.channels,
              hasSubscriber: !!subscriber,
              customParameters: session.customParameters,
            },
            "MediaStream session started",
          );
          subscriber?.handler.onStart?.(session);
          break;
        }

        case "media": {
          if (!session) return;
          const media = msg.media ?? {};
          const payloadB64 = media.payload as string | undefined;
          if (!payloadB64) return;
          const payload = Buffer.from(payloadB64, "base64");
          const ts = Number(media.timestamp ?? 0);
          session.chunkCount++;
          session.totalAudioBytes += payload.length;
          // Cheap per-chunk audio-health metric (~few µs / 160-byte frame) so
          // every call gets a canonical rmsAvg in its stop log without needing
          // a subscriber to compute it.
          if (session.format.encoding === "audio/x-mulaw") {
            session.rmsSum += rmsPcm16(muLawToPcm16(payload));
            session.rmsCount++;
          }
          subscriber?.handler.onMedia?.(session, payload, ts);
          break;
        }

        case "mark": {
          if (!session) return;
          const name = (msg.mark?.name as string) ?? "";
          subscriber?.handler.onMark?.(session, name);
          break;
        }

        case "stop": {
          if (session) {
            const elapsedMs = Date.now() - session.startedAt;
            // For μ-law @ 8 kHz, 1 byte = 1 sample = 0.125 ms → totalMs = bytes * 0.125
            const totalAudioMs =
              session.format.encoding === "audio/x-mulaw"
                ? session.totalAudioBytes / (session.format.sampleRate / 1000)
                : 0;
            const rmsAvg = session.rmsCount > 0
              ? Math.round(session.rmsSum / session.rmsCount)
              : 0;
            logger.info(
              {
                callSid: session.callSid,
                streamSid: session.streamSid,
                inboundCodec: session.format.encoding,
                inboundSampleRate: session.format.sampleRate,
                inboundChannels: session.format.channels,
                chunkCount: session.chunkCount,
                totalAudioBytes: session.totalAudioBytes,
                totalAudioMs: Math.round(totalAudioMs),
                rmsAvg,
                wallClockMs: elapsedMs,
              },
              "MediaStream session stopped",
            );
            subscriber?.handler.onStop?.(session);
          }
          break;
        }

        default:
          // ignore unknown events
          break;
      }
    });

    ws.on("close", (code, reason) => {
      if (session) {
        // If Twilio drops the connection without a "stop" event, still notify.
        subscriber?.handler.onStop?.(session);
      }
      logger.info(
        { code, reason: reason?.toString() ?? "", callSid: session?.callSid ?? null },
        "MediaStream WS closed",
      );
    });

    ws.on("error", (err) => {
      logger.warn({ err, callSid: session?.callSid ?? null }, "MediaStream WS error");
    });
  });

  logger.info({ path: MEDIA_STREAM_PATH }, "MediaStream WebSocket server attached");
}
