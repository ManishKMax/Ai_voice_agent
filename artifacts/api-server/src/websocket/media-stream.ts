import type { Server as HttpServer, IncomingMessage } from "http";
import { WebSocketServer, type WebSocket } from "ws";
import { logger } from "../lib/logger.js";
import { rmsPcm16 } from "../audio/codec.js";
import {
  getDefaultIvrProvider,
  resolveProviderForLead,
  type IvrProvider,
} from "../voice/ivr/index.js";

/**
 * Carrier-agnostic Media Streams WebSocket server.
 *
 * Phase 4: this server no longer parses Twilio envelopes inline. It instead
 * delegates inbound envelope decoding and outbound message serialization to
 * an `IvrProvider`. The default provider (Twilio) handles the WS handshake
 * and the initial `start` envelope; once we extract the leadId from the
 * start's customParameters we re-resolve the per-tenant provider, so the
 * WS server's behavior matches the carrier the call was actually placed
 * through.
 *
 * The WS path is shared across carriers — different providers may produce
 * different connect XML, but they all point back at /api/voice/stream.
 */

export const MEDIA_STREAM_PATH = "/api/voice/stream";

export interface MediaStreamFormat {
  encoding: string;
  /** Inbound (mic → brain) wire-format sample rate. STT and VAD work at
   *  this rate. Always 8 kHz today (telephony native, and even the LiveKit
   *  simulator downsamples inbound to 8 kHz so the brain stays carrier-
   *  agnostic). */
  sampleRate: number;
  channels: number;
  /** Optional outbound (brain → caller) PCM sample rate. When unset,
   *  outbound uses `sampleRate` (8 kHz, telephony). The LiveKit simulator
   *  sets this to 24 kHz so TTS audio reaches the browser at Sarvam's
   *  native bandwidth — no resample, no telephony low-pass, dramatically
   *  more natural voice. Twilio/Exotel/SIP paths leave this unset because
   *  PSTN carriers physically can't carry >8 kHz audio. */
  outboundSampleRate?: number;
}

export interface MediaStreamSession {
  streamSid: string;
  callSid: string;
  customParameters: Record<string, string>;
  format: MediaStreamFormat;
  startedAt: number;
  chunkCount: number;
  totalAudioBytes: number;
  rmsSum: number;
  rmsCount: number;
  stopped: boolean;
  /** The IvrProvider currently driving this session. May be re-resolved
   * once the start envelope's customParameters reveal the leadId. */
  provider: IvrProvider;
  /** Send an outbound audio frame (carrier-encoded wire bytes). */
  sendAudio(wirePayload: Buffer): void;
  /** Send a "mark" / sync event. No-op if the provider has no equivalent. */
  sendMark(name: string): void;
  /** Tell the carrier to discard buffered outbound audio. No-op if the
   * provider has no equivalent. */
  clear(): void;
  close(): void;
}

export interface MediaStreamHandler {
  onStart?(session: MediaStreamSession): void;
  onMedia?(session: MediaStreamSession, payload: Buffer, timestampMs: number): void;
  onMark?(session: MediaStreamSession, name: string): void;
  onStop?(session: MediaStreamSession): void;
}

export interface MediaStreamSubscriber {
  match(callSid: string, customParameters: Record<string, string>): boolean;
  handler: MediaStreamHandler;
}

const subscribers: MediaStreamSubscriber[] = [];

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

interface StartArgs {
  streamSid: string;
  callSid: string;
  customParameters: Record<string, string>;
  mediaFormat: MediaStreamFormat;
  provider: IvrProvider;
}

function buildSession(ws: WebSocket, args: StartArgs): MediaStreamSession {
  const session: MediaStreamSession = {
    streamSid: args.streamSid,
    callSid: args.callSid,
    customParameters: args.customParameters,
    format: args.mediaFormat,
    startedAt: Date.now(),
    chunkCount: 0,
    totalAudioBytes: 0,
    rmsSum: 0,
    rmsCount: 0,
    stopped: false,
    provider: args.provider,
    sendAudio(payload: Buffer) {
      if (ws.readyState !== ws.OPEN) return;
      const msg = session.provider.serializeAudioMessage(session.streamSid, payload);
      if (msg) ws.send(msg);
    },
    sendMark(name: string) {
      if (ws.readyState !== ws.OPEN) return;
      const msg = session.provider.serializeMarkMessage(session.streamSid, name);
      if (msg) ws.send(msg);
    },
    clear() {
      if (ws.readyState !== ws.OPEN) return;
      const msg = session.provider.serializeClearMessage(session.streamSid);
      if (msg) ws.send(msg);
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
    const path = url.split("?")[0];
    if (path !== MEDIA_STREAM_PATH) return;
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    let session: MediaStreamSession | null = null;
    let subscriber: MediaStreamSubscriber | null = null;
    // Use the default provider (Twilio) until the start envelope tells us
    // which tenant the call belongs to. Switched in `start` below.
    let provider: IvrProvider = getDefaultIvrProvider();
    const remote = req.socket.remoteAddress;
    logger.info({ remote, providerId: provider.id }, "MediaStream WS connection opened");

    const notifyStop = (): void => {
      if (!session || session.stopped) return;
      session.stopped = true;
      subscriber?.handler.onStop?.(session);
    };

    ws.on("message", (raw) => {
      const env = provider.parseInboundEnvelope(raw.toString());
      if (!env) return;

      switch (env.kind) {
        case "connected":
          logger.info(
            { protocol: env.protocol ?? null, version: env.version ?? null, providerId: provider.id },
            "MediaStream connected",
          );
          break;

        case "start": {
          // Build the session immediately with the default provider so we
          // don't drop inbound frames during the DB lookup. Then resolve
          // the per-tenant provider from the leadId via the same
          // `resolveProviderForLead` CallSession uses, and swap on the
          // session in-place. Media-stream's only use of `provider` after
          // start is the cheap RMS metric (which is wrapped in try/catch);
          // the brief default-provider window is therefore safe.
          const leadIdRaw = env.customParameters["leadId"];
          const leadIdNum = leadIdRaw ? parseInt(leadIdRaw, 10) || 0 : 0;
          session = buildSession(ws, {
            streamSid: env.streamSid,
            callSid: env.callSid,
            customParameters: env.customParameters,
            mediaFormat: env.mediaFormat,
            provider,
          });
          subscriber = pickSubscriber(session.callSid, session.customParameters);
          if (leadIdNum > 0) {
            const sessionAtStart = session;
            void resolveProviderForLead(leadIdNum)
              .then((resolved) => {
                if (sessionAtStart.stopped) return;
                if (resolved.id !== sessionAtStart.provider.id) {
                  logger.info(
                    { from: sessionAtStart.provider.id, to: resolved.id, leadId: leadIdNum },
                    "MediaStream provider swapped after DB lookup",
                  );
                  sessionAtStart.provider = resolved;
                  provider = resolved;
                }
              })
              .catch((err) => {
                logger.warn(
                  { err, leadId: leadIdNum, callSid: sessionAtStart.callSid },
                  "MediaStream provider DB resolution failed — keeping default",
                );
              });
          }
          logger.info(
            {
              callSid: session.callSid,
              streamSid: session.streamSid,
              providerId: provider.id,
              leadId: leadIdRaw ?? null,
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
          session.chunkCount++;
          session.totalAudioBytes += env.payload.length;
          // Cheap per-chunk audio-health metric. We decode through the
          // provider so this works for any carrier (Twilio μ-law, Exotel
          // PCM, etc.) — failures (e.g. wrong codec) are logged but
          // non-fatal so the call continues.
          try {
            const pcm = session.provider.decodeInboundFrame(env.payload);
            session.rmsSum += rmsPcm16(pcm);
            session.rmsCount++;
          } catch (err) {
            logger.warn(
              { err, providerId: session.provider.id, callSid: session.callSid },
              "media_stream_rms_decode_failed",
            );
          }
          subscriber?.handler.onMedia?.(session, env.payload, env.timestampMs);
          break;
        }

        case "mark": {
          if (!session) return;
          subscriber?.handler.onMark?.(session, env.name);
          break;
        }

        case "stop": {
          if (session) {
            const elapsedMs = Date.now() - session.startedAt;
            // bytes → ms is codec-dependent. For 8 kHz PCM s16le it's
            // bytes / (sampleRate*2/1000); for μ-law it's bytes / (sampleRate/1000).
            // We keep the legacy μ-law math here because every existing carrier
            // emits μ-law @ 8 kHz; adding a per-codec helper is a TODO.
            const totalAudioMs = session.totalAudioBytes / (session.format.sampleRate / 1000);
            const rmsAvg = session.rmsCount > 0
              ? Math.round(session.rmsSum / session.rmsCount)
              : 0;
            logger.info(
              {
                callSid: session.callSid,
                streamSid: session.streamSid,
                providerId: session.provider.id,
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
            notifyStop();
          }
          break;
        }
      }
    });

    ws.on("close", (code, reason) => {
      notifyStop();
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
