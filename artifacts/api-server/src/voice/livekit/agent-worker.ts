import { randomUUID } from "crypto";
// IMPORTANT: do NOT statically import @livekit/rtc-node here. The package
// loads native bindings (FFI to a Rust SDK) at import time, which can fail
// on Twilio-only deployments where the prebuilt binary isn't compatible
// with the host (musl vs glibc, ARM vs x64, etc.). Pulling it in lazily
// inside `doStartLiveKitAgent` means: (a) `livekit.routes.ts` mounting
// causes zero native-load risk at boot, and (b) operators who set
// `LIVEKIT_AGENT_INPROCESS=false` (the default when LIVEKIT_URL is unset)
// never touch the binding at all. `import type` is erased by the compiler
// and does NOT trigger a runtime load.
import type {
  AudioFrame as AudioFrameT,
  RemoteTrack,
  RemoteTrackPublication,
  RemoteParticipant,
} from "@livekit/rtc-node";
import { logger } from "../../lib/logger.js";
import { CallSession } from "../../websocket/call-session.js";
import type {
  MediaStreamSession,
  MediaStreamFormat,
} from "../../websocket/media-stream.js";
import { getIvrProvider } from "../ivr/index.js";
import { mintLiveKitToken, getLiveKitCreds } from "../../services/livekit.service.js";
import { isLlmProviderId, type LlmProviderId } from "../../services/llm/index.js";

/**
 * LiveKit in-process agent worker — Phase 1.
 *
 * Bridges a LiveKit Room (WebRTC) onto the existing CallSession state
 * machine. One worker per active simulator call. Spawned on demand by
 * `POST /api/voice/livekit/start-agent` after the browser participant
 * connects to the room.
 *
 * Pipeline (mirrors Twilio Media Streams but over WebRTC):
 *
 *   Browser mic (Opus 48k stereo)
 *     ↓ LiveKit SFU
 *     ↓ Room.connect + autoSubscribe
 *     ↓ TrackSubscribed event → AudioStream(track, {sampleRate:8000, numChannels:1})
 *         (rtc-node FFI resamples Opus 48k → PCM s16le 8k mono internally)
 *     ↓ AudioFrame → Buffer → CallSession.onMedia()
 *     ↓ CallSession runs STT → LLM → TTS via Sarvam, exactly as it does
 *       for Twilio calls — no carrier-specific branch needed because the
 *       LiveKitProvider's decode/encode are identity passthroughs.
 *     ↓ CallSession.streamTtsToTwilio() chunks 8 kHz PCM into 20ms frames
 *     ↓ session.sendAudio(pcmFrame) → AudioFrame → AudioSource.captureFrame
 *     ↓ rtc-node encodes Opus, publishes on agent's LocalAudioTrack
 *     ↓ Browser hears the agent through the SFU.
 *
 * Lifecycle:
 *   - The agent participant joins as `agent-<uuid>`, hidden:true so it
 *     doesn't pollute the simulator participant list.
 *   - When the browser participant disconnects (RoomEvent.ParticipantDisconnected
 *     for the only remote participant, or RoomEvent.Disconnected on the
 *     agent's own socket), we tear the CallSession down via onStop() and
 *     disconnect the room.
 *   - Workers are tracked in `liveKitAgents` so restarting a simulator on
 *     the same room replaces the previous worker cleanly.
 */

const SAMPLE_RATE = 8000;
const NUM_CHANNELS = 1;
// 20 ms @ 8 kHz mono = 160 samples = 320 bytes (s16le)
const FRAME_BYTES = 320;

interface StartLiveKitAgentOptions {
  roomName: string;
  /** Optional lead id, attached to the synthetic session's customParameters
   *  so CallSession can resolve the lead exactly like Twilio calls do. For
   *  Phase-1 simulator runs without a real lead, leave undefined and the
   *  greeting will use the configured agent defaults. */
  leadId?: number;
  /** Per-call LLM provider override (sarvam/openai/groq/gemini). */
  llmProvider?: string;
  /** Per-call Sarvam TTS voice override (e.g. "priya", "rohan"). */
  voice?: string;
  /** Per-call BCP-47 language code override (e.g. "en-IN", "hi-IN"). */
  language?: string;
  /** Optional human-friendly call SID for logs. Generated if absent. */
  callSid?: string;
  /** Task #31 — "simulator" for in-browser Call Simulator runs so
   *  CallSession can tag its call_metrics rows accordingly. Defaults to
   *  "production" for all other paths. */
  source?: "production" | "simulator";
  /** Fired exactly once when this worker tears down for any reason
   *  (explicit disconnect, last participant leave, room close, or a
   *  failure mid-stream). Lets the simulator controller drop its
   *  in-memory room map and finalise the call row without depending on
   *  the browser calling /end. */
  onTeardown?: (reason: string) => void;
}

interface LiveKitAgentHandle {
  callSid: string;
  roomName: string;
  disconnect(): Promise<void>;
}

const liveKitAgents = new Map<string, LiveKitAgentHandle>();
/**
 * Per-room start lock. Without this, two concurrent `start-agent` calls for
 * the same room can both pass the `existing` check before either reaches
 * `liveKitAgents.set(...)`, producing two live workers competing on one
 * AudioSource publication. The lock serialises starts per-room; cross-room
 * starts remain fully parallel.
 */
const liveKitStartLocks = new Map<string, Promise<unknown>>();

export async function startLiveKitAgent(
  opts: StartLiveKitAgentOptions,
): Promise<LiveKitAgentHandle> {
  const prior = liveKitStartLocks.get(opts.roomName);
  if (prior) {
    try { await prior; } catch { /* ignore — we'll attempt our own start */ }
  }
  const startPromise = doStartLiveKitAgent(opts);
  liveKitStartLocks.set(opts.roomName, startPromise);
  try {
    return await startPromise;
  } finally {
    // Only clear the lock if our promise is still the active one — a later
    // start may have already overwritten it during our await.
    if (liveKitStartLocks.get(opts.roomName) === startPromise) {
      liveKitStartLocks.delete(opts.roomName);
    }
  }
}

async function doStartLiveKitAgent(
  opts: StartLiveKitAgentOptions,
): Promise<LiveKitAgentHandle> {
  const creds = getLiveKitCreds();
  if (!creds) {
    throw new Error(
      "LiveKit not configured. Set LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LIVEKIT_URL.",
    );
  }
  // Optional kill-switch — lets ops disable the in-process agent worker
  // even when LiveKit creds are present (useful when rolling out Phase 2
  // SIP routing while keeping creds around for the simulator token route).
  // Default ON when creds are configured.
  const inproc = process.env["LIVEKIT_AGENT_INPROCESS"];
  if (inproc !== undefined && inproc !== "true" && inproc !== "1") {
    throw new Error(
      "LiveKit in-process agent disabled by LIVEKIT_AGENT_INPROCESS env var.",
    );
  }
  // Lazy native load — see top-of-file comment. If the binding fails (wrong
  // libc / missing prebuilt) we throw a clean error so the caller returns a
  // 500 with an actionable message; Twilio paths are completely unaffected
  // because they never reach this code path.
  let rtc: typeof import("@livekit/rtc-node");
  try {
    rtc = await import("@livekit/rtc-node");
  } catch (err) {
    logger.error(
      { err: (err as Error).message },
      "livekit_rtc_node_load_failed",
    );
    throw new Error(
      "Failed to load @livekit/rtc-node native bindings — LiveKit transport unavailable on this host. " +
      "Twilio/Exotel calls are not affected.",
    );
  }
  const {
    Room,
    RoomEvent,
    AudioStream,
    AudioSource,
    AudioFrame,
    LocalAudioTrack,
    TrackKind,
    TrackSource,
    TrackPublishOptions,
  } = rtc;

  const callSid = opts.callSid ?? `LKSIM${randomUUID().replace(/-/g, "").slice(0, 28)}`;
  const streamSid = `MZ${randomUUID().replace(/-/g, "").slice(0, 30)}`;
  const agentIdentity = `agent-${randomUUID().slice(0, 8)}`;

  // Replace any existing worker on the same room (idempotent re-start).
  const existing = liveKitAgents.get(opts.roomName);
  if (existing) {
    logger.info(
      { roomName: opts.roomName, oldCallSid: existing.callSid },
      "livekit_agent_replacing_existing",
    );
    try { await existing.disconnect(); } catch { /* swallow */ }
  }

  const token = await mintLiveKitToken({
    roomName: opts.roomName,
    identity: agentIdentity,
    name: "AI Agent",
    isAgent: true,
    ttlSeconds: 60 * 60,
  });

  const room = new Room();
  const audioSource = new AudioSource(SAMPLE_RATE, NUM_CHANNELS);
  const localTrack = LocalAudioTrack.createAudioTrack("agent-mic", audioSource);

  // Build the synthetic MediaStreamSession that CallSession consumes. The
  // sendAudio path converts the carrier-encoded buffer (which for LiveKit
  // is identity PCM s16le 8k via LiveKitProvider) into an AudioFrame and
  // hands it to AudioSource. sendMark / clear are no-ops because WebRTC
  // doesn't have an equivalent sync/discard primitive — barge-in is still
  // handled correctly because CallSession aborts its TTS loop locally on
  // its own (it doesn't rely on the carrier echoing a `mark`).
  const customParameters: Record<string, string> = {
    // Pin the CallSession to the LiveKit provider — without this a Twilio-
    // or Exotel-flagged tenant lookup on `leadId` would swap the provider
    // mid-start and start μ-law-encoding outbound PCM into the WebRTC
    // AudioSource, producing garbled audio on the browser side.
    forceProvider: "livekit",
  };
  if (opts.leadId != null && opts.leadId > 0) {
    customParameters["leadId"] = String(opts.leadId);
  }
  if (opts.llmProvider && isLlmProviderId(opts.llmProvider)) {
    customParameters["llmProvider"] = opts.llmProvider;
  }
  if (opts.voice && opts.voice.trim()) {
    customParameters["voice"] = opts.voice.trim();
  }
  if (opts.language && opts.language.trim()) {
    customParameters["language"] = opts.language.trim();
  }
  if (opts.source) {
    customParameters["source"] = opts.source;
  }

  const format: MediaStreamFormat = {
    encoding: "audio/pcm",
    sampleRate: SAMPLE_RATE,
    channels: NUM_CHANNELS,
  };

  // Build a fully-typed MediaStreamSession. The fields the WS server
  // maintains for metrics (chunkCount, totalAudioBytes, rmsSum, rmsCount,
  // stopped) are also tracked here so any downstream code that reads them
  // (none today, but defensive) gets sensible numbers.
  const sentinelSession: MediaStreamSession = {
    streamSid,
    callSid,
    customParameters,
    format,
    startedAt: Date.now(),
    chunkCount: 0,
    totalAudioBytes: 0,
    rmsSum: 0,
    rmsCount: 0,
    stopped: false,
    provider: getIvrProvider("livekit"),
    sendAudio(payload: Buffer) {
      // payload is PCM s16le 8 kHz mono (LiveKitProvider.encodeOutboundFrame
      // is identity). Pace is handled by CallSession.streamTtsToTwilio,
      // which awaits ~20 ms between frame sends — captureFrame is fire-and-
      // forget for the AudioSource's internal queue.
      if (sentinelSession.stopped) return;
      if (payload.length === 0) return;
      try {
        // Copy into an Int16Array so we don't alias upstream Buffer memory
        // that may be reused by the caller before captureFrame consumes it.
        const samples = payload.length / 2;
        const int16 = new Int16Array(samples);
        for (let i = 0; i < samples; i++) {
          int16[i] = payload.readInt16LE(i * 2);
        }
        const frame = new AudioFrame(int16, SAMPLE_RATE, NUM_CHANNELS, samples);
        void audioSource.captureFrame(frame).catch((err) => {
          logger.warn(
            { err: (err as Error).message, callSid, roomName: opts.roomName },
            "livekit_agent_capture_frame_failed",
          );
        });
      } catch (err) {
        logger.warn(
          { err: (err as Error).message, callSid },
          "livekit_agent_send_audio_failed",
        );
      }
    },
    sendMark(_name: string) { /* no-op for WebRTC */ },
    clear() { /* no-op for WebRTC */ },
    close() {
      // Triggered by CallSession.endCall — disconnects the room which in
      // turn ends the simulator session in the browser.
      void teardown("call_session_closed");
    },
  };

  const cs = new CallSession(sentinelSession, {
    llmProviderOverride: isLlmProviderId(opts.llmProvider)
      ? (opts.llmProvider as LlmProviderId)
      : undefined,
    voiceOverride: opts.voice?.trim() || undefined,
    languageOverride: opts.language?.trim() || undefined,
    source: opts.source,
  });

  // Track inbound-stream readers so teardown can cancel them. Without
  // cancellation the AudioStream readable will keep the room alive even
  // after Room.disconnect() returns.
  const inboundReaders: ReadableStreamDefaultReader<AudioFrameT>[] = [];

  let torndown = false;
  // Forward declaration so teardown can be invoked before `handle` is built.
  let registeredHandle: LiveKitAgentHandle | null = null;
  const teardown = async (reason: string): Promise<void> => {
    if (torndown) return;
    torndown = true;
    sentinelSession.stopped = true;
    logger.info({ callSid, roomName: opts.roomName, reason }, "livekit_agent_teardown");
    try { cs.onStop(); } catch (err) {
      logger.warn({ err: (err as Error).message, callSid }, "livekit_agent_onstop_failed");
    }
    for (const r of inboundReaders) {
      try { await r.cancel(); } catch { /* ignore */ }
    }
    try { await localTrack.close(); } catch { /* ignore */ }
    try { await audioSource.close(); } catch { /* ignore */ }
    try { await room.disconnect(); } catch { /* ignore */ }
    // Only evict the map entry if it still points at our handle — a later
    // start_agent on the same room may have overwritten it, and we mustn't
    // remove someone else's live worker.
    if (registeredHandle && liveKitAgents.get(opts.roomName) === registeredHandle) {
      liveKitAgents.delete(opts.roomName);
    }
    if (opts.onTeardown) {
      try { opts.onTeardown(reason); } catch (err) {
        logger.warn(
          { err: (err as Error).message, callSid, roomName: opts.roomName },
          "livekit_agent_onteardown_callback_failed",
        );
      }
    }
  };

  // Wire room events BEFORE connect so we don't miss participants that
  // joined before the agent (browser may publish before agent reconnects).
  room.on(RoomEvent.TrackSubscribed, (
    track: RemoteTrack,
    _publication: RemoteTrackPublication,
    participant: RemoteParticipant,
  ) => {
    if (track.kind !== TrackKind.KIND_AUDIO) return;
    logger.info(
      { callSid, roomName: opts.roomName, participant: participant.identity },
      "livekit_agent_track_subscribed",
    );
    const stream = new AudioStream(track, {
      sampleRate: SAMPLE_RATE,
      numChannels: NUM_CHANNELS,
      // 20 ms frames keep the inbound chunk size identical to Twilio's
      // 160-byte (μ-law) / 320-byte (PCM) frames. Smaller frames waste
      // FFI calls; larger frames break the per-chunk RMS / barge-in
      // resolution CallSession relies on.
      frameSizeMs: 20,
    });
    const reader = stream.getReader();
    inboundReaders.push(reader);
    void (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done || sentinelSession.stopped) break;
          // AudioFrame.data is Int16Array @ 8 kHz mono. Wrap as Buffer
          // without copying — CallSession.onMedia will hand this to
          // LiveKitProvider.decodeInboundFrame, which is identity, so the
          // bytes flow straight into the per-turn capture buffer.
          const data = value.data;
          const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
          sentinelSession.chunkCount++;
          sentinelSession.totalAudioBytes += buf.length;
          // Re-frame defensively: AudioStream *should* honour frameSizeMs,
          // but if it ever delivers a larger frame (e.g. backlog flush)
          // we split into 20-ms chunks so CallSession's per-frame VAD
          // stays accurate. Bytes too small to make one frame are
          // forwarded as-is.
          if (buf.length <= FRAME_BYTES) {
            cs.onMedia(buf);
          } else {
            for (let off = 0; off < buf.length; off += FRAME_BYTES) {
              const slice = buf.subarray(off, Math.min(off + FRAME_BYTES, buf.length));
              if (slice.length === FRAME_BYTES) {
                cs.onMedia(slice);
              } else if (slice.length >= 2) {
                // Trailing partial frame — pad with silence so we don't
                // confuse the s16le reader. Bytes / 2 = samples; round
                // down by dropping the odd trailing byte if any.
                cs.onMedia(slice.subarray(0, slice.length - (slice.length % 2)));
              }
            }
          }
        }
      } catch (err) {
        if (!sentinelSession.stopped) {
          logger.warn(
            { err: (err as Error).message, callSid },
            "livekit_agent_audio_stream_read_failed",
          );
        }
      } finally {
        try { reader.releaseLock(); } catch { /* ignore */ }
      }
    })();
  });

  room.on(RoomEvent.ParticipantDisconnected, (participant: RemoteParticipant) => {
    logger.info(
      { callSid, roomName: opts.roomName, participant: participant.identity },
      "livekit_agent_participant_disconnected",
    );
    // If no remote participants remain, the simulator user is gone — tear
    // down. We can't query room.remoteParticipants directly inside the
    // event handler because the disconnected participant is already
    // removed from the map by the time this fires.
    if (room.remoteParticipants.size === 0) {
      void teardown("last_participant_disconnected");
    }
  });

  room.on(RoomEvent.Disconnected, () => {
    void teardown("room_disconnected");
  });

  // Wrap connect + publishTrack in try/catch so a mid-start failure (network
  // error, expired token, SFU rejection) tears down partially-created FFI
  // resources rather than leaking the Room handle and AudioSource for the
  // lifetime of the process.
  try {
    await room.connect(creds.url, token, {
      autoSubscribe: true,
      dynacast: false,
    });
    await room.localParticipant!.publishTrack(
      localTrack,
      new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }),
    );
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, callSid, roomName: opts.roomName },
      "livekit_agent_connect_failed",
    );
    sentinelSession.stopped = true;
    for (const r of inboundReaders) {
      try { await r.cancel(); } catch { /* ignore */ }
    }
    try { await localTrack.close(); } catch { /* ignore */ }
    try { await audioSource.close(); } catch { /* ignore */ }
    try { await room.disconnect(); } catch { /* ignore */ }
    throw err;
  }

  logger.info(
    {
      callSid,
      roomName: opts.roomName,
      agentIdentity,
      leadId: opts.leadId ?? null,
      llmProvider: opts.llmProvider ?? null,
    },
    "livekit_agent_started",
  );

  // Kick off the brain. start() greets the lead and transitions to
  // BOT_SPEAKING; first audio frame appears on the browser side once
  // Sarvam TTS returns the first chunk.
  void cs.start();

  const handle: LiveKitAgentHandle = {
    callSid,
    roomName: opts.roomName,
    disconnect: () => teardown("explicit_disconnect"),
  };
  registeredHandle = handle;
  liveKitAgents.set(opts.roomName, handle);
  return handle;
}

export function getLiveKitAgent(roomName: string): LiveKitAgentHandle | undefined {
  return liveKitAgents.get(roomName);
}
