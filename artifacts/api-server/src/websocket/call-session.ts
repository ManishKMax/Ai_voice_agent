import { performance } from "perf_hooks";
import { eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { leadsTable } from "@workspace/db/schema";
import { logger } from "../lib/logger.js";
import {
  subscribeMediaStream,
  type MediaStreamHandler,
  type MediaStreamSession,
} from "./media-stream.js";
import {
  upsample8kTo16k,
  rmsPcm16,
  resamplePcm16Mono,
  stereoToMonoPcm16,
} from "../audio/codec.js";
import {
  getIvrProvider,
  resolveProviderForLead,
  type IvrProvider,
} from "../voice/ivr/index.js";
import {
  generateSpeech,
  generateConversationResponse,
  analyzeTranscript,
  splitForTTS,
} from "../services/sarvam.service.js";
import { SarvamSttClient, STT_RESPONSE_TIMEOUT_MS } from "../services/sarvam-stt-ws.client.js";
import {
  agentConfig,
  buildGreetingText,
  buildSystemPrompt,
} from "../config/agent.config.js";
import {
  createSession,
  getSession,
  addAgentOpening,
  addTurn,
  endSession,
} from "../services/conversation-state.js";
import { getLeadById, updateLeadStatus } from "../modules/leads/leads.service.js";
import { updateCallTranscript } from "../modules/calls/calls.service.js";
import { broadcastSse } from "../services/sse.service.js";
import { isLlmProviderId } from "../services/llm/index.js";
import { recordTurnMetrics, findCallIdBySid } from "../services/metrics.service.js";

/**
 * Phase 3 — Live call state machine driven by Twilio Media Streams.
 *
 * States (per design spec):
 *   BOT_SPEAKING → WAIT_AFTER_BOT_SPEECH (400 ms) → LISTENING →
 *   USER_SPEECH_DETECTED → USER_SILENCE_DETECTED (1.5 s of trailing silence)
 *   → FLUSH_STT → WAIT_FOR_FINAL_TRANSCRIPT → PROCESS_TRANSCRIPT → BOT_SPEAKING
 *
 * Inbound media frames received during BOT_SPEAKING / WAIT_AFTER_BOT_SPEECH
 * are dropped (no barge-in for v1). Transitions are logged with monotonic
 * `performance.now()` timestamps so cross-day calls remain comparable.
 *
 * Drift from spec: the spec assumed Sarvam TTS WS would emit PCM that we
 * downsample to μ-law. Phase-2 protocol discovery proved Sarvam TTS WS only
 * emits MP3 frames, with no PCM/WAV codec switch. Decoding MP3 in pure-JS
 * for every turn is heavy and would require a native dep. The HTTP TTS
 * endpoint (`generateSpeech`) returns 8 kHz mono WAV directly — telephony
 * native — so we use it: strip the 44-byte RIFF header, μ-law encode, chunk
 * into 160-byte (20 ms) frames, pace at real-time.
 */

type State =
  | "IDLE"
  | "BOT_SPEAKING"
  | "WAIT_AFTER_BOT_SPEECH"
  | "LISTENING"
  | "USER_SPEECH_DETECTED"
  | "USER_SILENCE_DETECTED"
  | "FLUSH_STT"
  | "WAIT_FOR_FINAL_TRANSCRIPT"
  | "PROCESS_TRANSCRIPT"
  | "ENDED";

const MAX_TURNS_DEFAULT = 6;

/**
 * VAD / endpointing thresholds. All overridable via env so operators can tune
 * for noisy lines, soft speakers, or aggressive endpointing without a deploy.
 * Defaults reflect what worked best in dev testing for Indian phone lines.
 */
function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  if (Number.isNaN(n) || n < min || n > max) return fallback;
  return n;
}
const POST_BOT_GRACE_MS      = envInt("VOICE_POST_BOT_GRACE_MS",      400,    0, 5000);
const SILENCE_END_MS         = envInt("VOICE_SILENCE_END_MS",         1500, 200, 5000);
const SPEECH_RMS_THRESHOLD   = envInt("VOICE_SPEECH_RMS_THRESHOLD",    600,   1, 32767);
const SILENCE_RMS_THRESHOLD  = envInt("VOICE_SILENCE_RMS_THRESHOLD",   350,   1, 32767);
const HEALTH_GATE_AFTER_MS   = envInt("VOICE_HEALTH_GATE_AFTER_MS",   6000, 1000, 60000);
const MIN_SPEECH_MS          = envInt("VOICE_MIN_SPEECH_MS",           300,   0, 5000);
// Cap a single user utterance at 8s. Longer utterances make Sarvam STT
// slower (it processes the whole buffer at once and is request/response,
// not streaming) — observed dead-air hangs when the user spoke for 11s
// and STT couldn't return before they hung up. 8s keeps the per-turn STT
// round-trip under the new 6s response timeout.
const MAX_LISTEN_MS          = envInt("VOICE_MAX_LISTEN_MS",          8000, 2000, 60000);
// Barge-in: minimum sustained speech duration (ms) during BOT_SPEAKING that
// counts as the user interrupting. Set <=0 to disable barge-in.
const BARGE_IN_MIN_MS        = envInt("VOICE_BARGE_IN_MIN_MS",         200,   0, 5000);
// Barge-in grace: ignore inbound speech for this long *after the bot's first
// audio frame is actually sent*. Without this, the user's "Hello?" on pickup
// (which arrives during the 1–16s gap between BOT_SPEAKING state entry and
// TTS being ready) trips barge-in and kills the greeting before the user
// has heard a single word from the agent.
const BARGE_IN_GRACE_MS      = envInt("VOICE_BARGE_IN_GRACE_MS",       800,   0, 10000);

interface TtsTimings {
  ttsRequestAtMs: number;
  ttsFirstByteAtMs: number | null;
  firstFrameAtMs: number | null;
  firstFrameWallClockAt: Date | null;
  lastFrameAtMs: number | null;
}

interface PerTurnLog {
  call_id: string;
  turn_id: number;
  state: State;
  bot_speaking_start: number | null;
  bot_speaking_end: number | null;
  listening_start: number | null;
  audio_sample_rate: number;
  audio_encoding: string;
  chunk_count_sent_to_stt: number;
  total_audio_ms_sent_to_stt: number;
  rms_min: number;
  rms_avg: number;
  rms_max: number;
  stt_partial_received: number;
  stt_final_received: boolean;
  final_transcript: string;
  flush_time: number | null;
  silence_timeout_reason: string | null;
  sarvam_ws_errors: string | null;
}

export class CallSession {
  state: State = "IDLE";
  private session: MediaStreamSession;
  private leadId: number;
  private leadName = "there";
  private turnId = 0;
  /**
   * Phase 4: which IVR adapter handles inbound/outbound codec + webhook
   * envelope for this call. Defaulted to Twilio for safety; replaced in
   * start() with the per-tenant resolution. Not readonly because start()
   * may swap it in based on `tenants.telephony_provider`.
   */
  private provider: IvrProvider = getIvrProvider("twilio");

  // Per-turn capture buffers (PCM s16le 8 kHz frames concatenated; we upsample
  // once at flush rather than per-frame to amortise cost).
  private pcmFrames: Buffer[] = [];
  private rmsValues: number[] = [];
  private speechFirstAtMs: number | null = null;
  private speechLastAtMs: number | null = null;

  // Barge-in: timestamp of the first sustained-speech frame observed during
  // BOT_SPEAKING. Reset whenever we see a quiet frame so noise blips don't
  // accumulate into a false interruption.
  private bargeInFirstAtMs: number | null = null;
  // Monotonic time at which the first outbound TTS frame was actually sent
  // for the current speak invocation. Used to gate barge-in detection — we
  // can't legitimately call it "the user interrupted" until the user has
  // had a chance to hear the bot's voice for at least BARGE_IN_GRACE_MS.
  private botFirstFrameSentAtMs: number | null = null;

  // Monotonic timestamps for the current turn.
  private botSpeakingStartMs: number | null = null;
  private botSpeakingEndMs: number | null = null;
  private listeningStartMs: number | null = null;
  private flushStartMs: number | null = null;
  private lastTurnContext: Record<string, unknown> | null = null;

  // Lifecycle flags / timers
  private cancelled = false;
  private ttsStopRequested = false;
  /**
   * Monotonic counter incremented on every speak invocation. Each in-flight
   * `streamTtsToTwilio()` captures the value at entry and aborts immediately
   * if it observes a newer epoch — prevents an older speak loop (still
   * awaiting one of its parallel TTS promises) from emitting stale audio
   * frames or running stale post-speech transitions after barge-in starts a
   * new turn that resets `ttsStopRequested`.
   */
  private ttsEpoch = 0;
  private postBotTimer: NodeJS.Timeout | null = null;
  private listenWatchdog: NodeJS.Timeout | null = null;
  private healthGateFired = false;
  private rePromptCount = 0;
  private finalised = false;
  /** Active in-flight STT client, so onStop() can abort it cleanly. */
  private sttInFlight: SarvamSttClient | null = null;
  /** Reject handle for the active STT promise so cancel settles the await. */
  private sttRejectInFlight: ((err: Error) => void) | null = null;
  /**
   * Pre-warmed Sarvam STT WS. Opened during BOT_SPEAKING so the handshake
   * (~300ms typical, up to 12s on cold turn-1) is paid before the user
   * finishes their reply. Consumed at flushAndProcess time; recreated for
   * the next turn. Idle warm sockets that the server closes mid-bot-speech
   * are detected via `isWarm()` and replaced with a cold open.
   */
  private warmStt: SarvamSttClient | null = null;
  /** Once-per-call flag for the TTS resampling notice (was per-turn WARN). */
  private ttsResamplingNoticeLogged = false;

  /**
   * Per-call LLM provider override (e.g. "openai", "groq"). Resolved from
   * the start envelope's `customParameters.llmProvider` so the upcoming
   * in-browser simulator (Task #31) can A/B providers without mutating
   * agent_settings. Unknown values are ignored by the resolver and fall
   * through to the configured provider.
   */
  private readonly llmProviderOverride: import("../services/llm/index.js").LlmProviderId | undefined;

  constructor(
    session: MediaStreamSession,
    opts: { llmProviderOverride?: import("../services/llm/index.js").LlmProviderId } = {},
  ) {
    this.session = session;
    const leadIdRaw = session.customParameters["leadId"];
    this.leadId = leadIdRaw ? parseInt(leadIdRaw, 10) || 0 : 0;
    const rawOverride = opts.llmProviderOverride ?? session.customParameters["llmProvider"];
    this.llmProviderOverride = isLlmProviderId(rawOverride) ? rawOverride : undefined;
  }

  async start(): Promise<void> {
    try {
      const lead = this.leadId ? await getLeadById(this.leadId) : null;
      this.leadName = lead?.name ?? "there";
      // Resolve the per-tenant IVR adapter — Twilio for platform calls and
      // Twilio-flagged tenants, Exotel scaffold for Exotel-flagged tenants.
      // Fail-safe: any DB error keeps the Twilio default already on `this`.
      // `forceProvider` is set by transports that own their own carrier
      // identity (e.g. the LiveKit agent worker) and must NOT have the
      // provider flipped to Twilio/Exotel by tenant-lookup. Without this
      // guard, a LiveKit-backed session with a Twilio-flagged leadId would
      // start decoding inbound PCM frames as μ-law and encoding outbound
      // PCM as μ-law before captureFrame, producing distorted/invalid
      // audio on the WebRTC track.
      const forceProvider = this.session.customParameters["forceProvider"];
      if (forceProvider) {
        logger.info(
          { call_id: this.session.callSid, providerId: this.provider.id, forceProvider },
          "call_session_provider_forced",
        );
      } else if (this.leadId) {
        this.provider = await resolveProviderForLead(this.leadId);
        logger.info(
          { call_id: this.session.callSid, providerId: this.provider.id },
          "call_session_provider_resolved",
        );
      }

      const greetingText = buildGreetingText(agentConfig, this.leadName);
      const systemPrompt = buildSystemPrompt(agentConfig, this.leadName, greetingText);

      createSession(this.session.callSid, this.leadId, this.leadName, systemPrompt);
      addAgentOpening(this.session.callSid, greetingText);

      broadcastSse("call.started", {
        callSid: this.session.callSid,
        leadId: this.leadId,
        leadName: this.leadName,
        phone: lead?.phone ?? "",
        agentText: greetingText,
        turn: 0,
        startedAt: Date.now(),
        pipeline: "ws",
      });

      // Note: speakAndAdvance() emits the IDLE→BOT_SPEAKING transition log
      // via this.transition(), so we don't duplicate it here.
      await this.speakAndAdvance(greetingText, /*isOpening*/ true);
    } catch (err) {
      logger.error({ err, callSid: this.session.callSid }, "call_session_start_failed");
      this.endCall("start_failed");
    }
  }

  /** Inbound μ-law frame from Twilio. Drop unless we're actively listening. */
  onMedia(payload: Buffer): void {
    if (this.cancelled) return;

    // Barge-in: while the bot is speaking, watch for sustained speech that
    // indicates the user wants to interrupt. Quiet frames reset the onset
    // (must be sustained, not a single noise blip).
    if (this.state === "BOT_SPEAKING") {
      if (BARGE_IN_MIN_MS <= 0) return;
      // Don't consider barge-in until the bot has actually been audible
      // for BARGE_IN_GRACE_MS. Without this, the user's "Hello?" on pickup
      // (arriving in the 1–16s gap before TTS finishes synthesizing) trips
      // barge-in and kills the greeting before it ever plays.
      if (
        this.botFirstFrameSentAtMs === null ||
        performance.now() - this.botFirstFrameSentAtMs < BARGE_IN_GRACE_MS
      ) {
        return;
      }
      const pcm8 = this.provider.decodeInboundFrame(payload);
      const rms = rmsPcm16(pcm8);
      const nowMono = performance.now();
      if (rms >= SPEECH_RMS_THRESHOLD) {
        if (this.bargeInFirstAtMs === null) this.bargeInFirstAtMs = nowMono;
        if (nowMono - this.bargeInFirstAtMs >= BARGE_IN_MIN_MS) {
          this.handleBargeIn(pcm8, rms, nowMono);
        }
      } else if (rms < SILENCE_RMS_THRESHOLD) {
        this.bargeInFirstAtMs = null;
      }
      return;
    }

    if (this.state !== "LISTENING" && this.state !== "USER_SPEECH_DETECTED") return;

    const pcm8 = this.provider.decodeInboundFrame(payload);
    const rms = rmsPcm16(pcm8);
    this.pcmFrames.push(pcm8);
    this.rmsValues.push(rms);

    const nowMono = performance.now();

    if (rms >= SPEECH_RMS_THRESHOLD) {
      if (this.speechFirstAtMs === null) this.speechFirstAtMs = nowMono;
      this.speechLastAtMs = nowMono;
      if (this.state === "LISTENING") this.transition("USER_SPEECH_DETECTED");
      return;
    }

    // We're below the speech threshold. If we've ever heard speech, check the
    // trailing-silence window for end-of-utterance.
    if (
      this.state === "USER_SPEECH_DETECTED" &&
      rms < SILENCE_RMS_THRESHOLD &&
      this.speechLastAtMs !== null &&
      nowMono - this.speechLastAtMs >= SILENCE_END_MS &&
      this.speechFirstAtMs !== null &&
      this.speechLastAtMs - this.speechFirstAtMs >= MIN_SPEECH_MS
    ) {
      this.transition("USER_SILENCE_DETECTED");
      void this.flushAndProcess("end_of_utterance");
    }
  }

  /** Twilio said stop, or socket closed — tear down everything. */
  onStop(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.clearTimers();
    this.ttsStopRequested = true;
    // Abort any in-flight Sarvam STT request so its socket doesn't linger
    // until handshake/response timeout. cancel() is idempotent and safe
    // from any WS readyState.
    if (this.sttInFlight) {
      try { this.sttInFlight.cancel(); } catch { /* ignore */ }
      this.sttInFlight = null;
    }
    // Same for any pre-warmed STT socket that hasn't been consumed yet —
    // failure to terminate would leak the WS until handshake/idle timeout.
    if (this.warmStt) {
      try { this.warmStt.cancel(); } catch { /* ignore */ }
      this.warmStt = null;
    }
    // Settle the pending await deterministically — cancel() may not fire
    // `final` or `error` after marking the client closed, which would leave
    // the flushAndProcess promise dangling for the lifetime of the process.
    if (this.sttRejectInFlight) {
      try { this.sttRejectInFlight(new Error("call_session_stopped")); } catch { /* ignore */ }
      this.sttRejectInFlight = null;
    }
    logger.info(
      { call_id: this.session.callSid, finalState: this.state },
      "call_session_stopped",
    );
    void this.finaliseAndAnalyse("stop");
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private transition(to: State): void {
    if (this.state === to) return;
    const from = this.state;
    this.state = to;
    logger.info(
      {
        call_id: this.session.callSid,
        turn_id: this.turnId,
        state_from: from,
        state_to: to,
        ts: Math.round(performance.now()),
      },
      "call_session_state_transition",
    );
  }

  private clearTimers(): void {
    if (this.postBotTimer) { clearTimeout(this.postBotTimer); this.postBotTimer = null; }
    if (this.listenWatchdog) { clearTimeout(this.listenWatchdog); this.listenWatchdog = null; }
  }

  private resetTurnBuffers(): void {
    this.pcmFrames = [];
    this.rmsValues = [];
    this.speechFirstAtMs = null;
    this.speechLastAtMs = null;
    this.bargeInFirstAtMs = null;
    this.healthGateFired = false;
    this.flushStartMs = null;
  }

  /**
   * The user spoke for ≥ BARGE_IN_MIN_MS while the bot was talking. Cancel
   * the in-flight TTS, flush whatever audio the carrier has buffered, and
   * jump straight into a normal listening turn — seeded with the speech
   * frame that triggered the barge-in so we don't lose the leading audio.
   */
  private handleBargeIn(pcm8: Buffer, rms: number, nowMono: number): void {
    if (this.cancelled) return;
    logger.info(
      {
        call_id: this.session.callSid,
        turn_id: this.turnId,
        rms,
        ts: Math.round(nowMono),
      },
      "call_session_barge_in",
    );
    // Stop the TTS pacing loop on its next tick AND bump the epoch so any
    // in-flight pipelined TTS still awaiting `generateSpeech` resolves into
    // a stale-epoch check and exits without sending frames or mutating state.
    this.ttsStopRequested = true;
    this.ttsEpoch++;
    // Tell the carrier to drop any audio it has buffered for playback.
    try { this.session.clear(); } catch { /* provider may not support */ }
    this.botSpeakingEndMs = nowMono;
    this.bargeInFirstAtMs = null;

    // Seed the listening turn with the speech that triggered barge-in so
    // the user's first words make it to STT.
    this.pcmFrames.push(pcm8);
    this.rmsValues.push(rms);
    this.speechFirstAtMs = nowMono;
    this.speechLastAtMs = nowMono;

    this.transition("LISTENING");
    this.listeningStartMs = nowMono;
    this.transition("USER_SPEECH_DETECTED");
    if (this.listenWatchdog) clearTimeout(this.listenWatchdog);
    this.listenWatchdog = setTimeout(
      () => void this.handleListenWatchdog(),
      MAX_LISTEN_MS,
    );
  }

  private startListening(): void {
    if (this.cancelled) return;
    this.transition("LISTENING");
    this.listeningStartMs = performance.now();
    // Watchdog: if no speech onset in HEALTH_GATE_AFTER_MS or call exceeds
    // MAX_LISTEN_MS, fire the audio-health re-prompt or hard end.
    this.listenWatchdog = setTimeout(() => {
      void this.handleListenWatchdog();
    }, HEALTH_GATE_AFTER_MS);
  }

  private async handleListenWatchdog(): Promise<void> {
    if (this.cancelled) return;
    const nowMono = performance.now();
    const elapsedMs = this.listeningStartMs ? nowMono - this.listeningStartMs : 0;

    // If user already started speaking, give them up to MAX_LISTEN_MS to finish.
    if (this.state === "USER_SPEECH_DETECTED") {
      if (elapsedMs >= MAX_LISTEN_MS) {
        await this.flushAndProcess("max_listen_window");
      } else {
        // Re-arm watchdog for the remainder.
        this.listenWatchdog = setTimeout(
          () => void this.handleListenWatchdog(),
          MAX_LISTEN_MS - elapsedMs,
        );
      }
      return;
    }

    if (this.state !== "LISTENING") return;

    // Audio health gate — exact spec rules:
    //   (a) bot finished speaking ✓ (we're in LISTENING)
    //   (b) ≥ HEALTH_GATE_AFTER_MS elapsed since LISTENING start ✓
    //   (c) zero partial transcripts received (Sarvam STT WS has no partials,
    //       so this is structurally true; we treat "no speech onset" as the
    //       moral equivalent for Phase 3)
    //   (d) RMS stayed below speech threshold throughout
    //   (e) no valid audio chunks received above silence floor
    const rmsMax = this.rmsValues.length ? Math.max(...this.rmsValues) : 0;
    const validAudio = this.rmsValues.some((r) => r >= SILENCE_RMS_THRESHOLD);
    const allConditionsMet =
      !this.speechFirstAtMs &&
      rmsMax < SPEECH_RMS_THRESHOLD &&
      !validAudio;

    if (!allConditionsMet) {
      // We DID get audio but no clear speech onset (e.g. background noise on
      // the line). Give the caller the rest of the MAX_LISTEN_MS window in
      // case they're still gathering thoughts — but enforce a hard cap so a
      // perpetually noisy line can't keep the call stuck in LISTENING forever.
      if (elapsedMs >= MAX_LISTEN_MS) {
        logger.warn(
          {
            call_id: this.session.callSid,
            turn_id: this.turnId,
            listening_ms: Math.round(elapsedMs),
            rms_max: Math.round(rmsMax),
            silence_timeout_reason: "noise_only_max_listen",
          },
          "call_session_listen_max_window_noise",
        );
        this.rePromptCount++;
        if (this.rePromptCount > 1) {
          await this.speakAndEnd(
            agentConfig.language === "hi-IN" || agentConfig.language === "en-IN"
              ? "Line par awaaz nahi aa rahi. Baad mein call karte hain. Dhanyavaad!"
              : "I can't quite make out what you're saying. I'll call you back. Goodbye!",
            "noise_only_exhausted",
          );
          return;
        }
        const rePrompt =
          agentConfig.language === "hi-IN" || agentConfig.language === "en-IN"
            ? "Sorry, line par awaaz saaf nahi aa rahi. Kya aap dohra sakte hain?"
            : "Sorry, the line is a bit unclear — could you repeat that?";
        // Reset turn buffers so the re-prompt's listening window starts fresh.
        this.resetTurnBuffers();
        await this.speakAndAdvance(rePrompt, /*isOpening*/ false);
        return;
      }
      const remaining = Math.max(2000, MAX_LISTEN_MS - elapsedMs);
      this.listenWatchdog = setTimeout(
        () => void this.handleListenWatchdog(),
        remaining,
      );
      return;
    }

    // True silence — re-prompt or end gracefully if we've already re-prompted.
    this.healthGateFired = true;
    this.rePromptCount++;
    logger.warn(
      {
        call_id: this.session.callSid,
        turn_id: this.turnId,
        listening_ms: Math.round(elapsedMs),
        rms_max: Math.round(rmsMax),
        valid_audio_chunks: 0,
        re_prompt_count: this.rePromptCount,
        silence_timeout_reason: "no_speech_detected",
      },
      "call_session_audio_health_gate",
    );

    if (this.rePromptCount > 1) {
      // Two strikes — wrap up politely instead of looping forever.
      await this.speakAndEnd(
        agentConfig.language === "hi-IN" || agentConfig.language === "en-IN"
          ? "Theek hai, baad mein call karte hain. Dhanyavaad!"
          : "I'll try reaching you another time. Have a great day!",
        "health_gate_exhausted",
      );
      return;
    }

    // Short Hinglish-friendly re-prompt — NOT a hard "I could not hear you"
    // terminator. Per spec. Reset buffers first so prior silence frames don't
    // bleed into the re-prompt's listening window (parity with noise-only
    // path).
    this.resetTurnBuffers();
    const rePrompt =
      agentConfig.language === "hi-IN" || agentConfig.language === "en-IN"
        ? "Hello, kya aap sun rahe hain?"
        : "Hello, are you still there?";
    await this.speakAndAdvance(rePrompt, /*isOpening*/ false);
  }

  private async flushAndProcess(reason: string): Promise<void> {
    if (this.cancelled || this.finalised) return;
    if (this.listenWatchdog) { clearTimeout(this.listenWatchdog); this.listenWatchdog = null; }

    this.transition("FLUSH_STT");
    this.flushStartMs = performance.now();

    const pcm8 = Buffer.concat(this.pcmFrames);
    const chunkCount = this.pcmFrames.length;
    // Each inbound frame is one provider outboundFrameIntervalMs() worth of
    // audio (20 ms for both Twilio μ-law and the Exotel scaffold).
    const totalAudioMs = chunkCount * this.provider.outboundFrameIntervalMs();
    const rmsMin = this.rmsValues.length ? Math.min(...this.rmsValues) : 0;
    const rmsMax = this.rmsValues.length ? Math.max(...this.rmsValues) : 0;
    const rmsAvg = this.rmsValues.length
      ? this.rmsValues.reduce((a, b) => a + b, 0) / this.rmsValues.length
      : 0;

    // Sarvam STT wants 16 kHz PCM s16le.
    const pcm16 = upsample8kTo16k(pcm8);

    this.transition("WAIT_FOR_FINAL_TRANSCRIPT");

    let transcript = "";
    let sttErr: string | null = null;
    let finalReceived = false;
    let sttAttempts = 0;
    let sttUsedWarmSocket = false;
    // Defence-in-depth watchdog: even if the STT client somehow fails to
    // emit a terminal event (a real-world hang we observed: lead 43, the
    // FLUSH_STT → WAIT_FOR_FINAL_TRANSCRIPT state sat for 10s with no log
    // until the user hung up), this guarantees the state machine never
    // wedges silently. Set 1s above the client's own response timeout so
    // the client gets the chance to surface a typed error first.
    //
    // CRITICAL: must be DERIVED from STT_RESPONSE_TIMEOUT_MS, not a fixed
    // constant. A previous hardcoded 7000ms (below the 12000ms client
    // timeout) defeated the client timeout entirely on long utterances —
    // the watchdog would fire first and abort STT before the client got a
    // chance to return a final on an 8-second utterance.
    const STT_HARD_DEADLINE_MS = STT_RESPONSE_TIMEOUT_MS + 1000;

    // One STT attempt. Uses the warm socket on attempt 0 if available.
    // Returns the transcript (which may be empty if Sarvam returned no text)
    // or throws on transient/terminal error.
    const runSttOnce = async (deadlineMs: number = STT_HARD_DEADLINE_MS): Promise<string> => {
      sttAttempts++;
      let sttClient: SarvamSttClient;
      if (this.warmStt && this.warmStt.isWarm()) {
        sttClient = this.warmStt;
        this.warmStt = null;
        sttUsedWarmSocket = true;
      } else {
        if (this.warmStt) {
          // Stale warm socket — terminate it so it doesn't leak.
          try { this.warmStt.cancel(); } catch { /* ignore */ }
          this.warmStt = null;
        }
        sttClient = new SarvamSttClient();
        sttUsedWarmSocket = false;
      }
      this.sttInFlight = sttClient;
      let watchdog: NodeJS.Timeout | null = null;
      try {
        const final = await new Promise<{ text: string }>((resolve, reject) => {
          // Expose reject so onStop() can settle this promise immediately when
          // cancel() doesn't trigger a `final`/`error` event from the client.
          this.sttRejectInFlight = reject;
          sttClient.on("final", (ev) => resolve({ text: ev.text }));
          sttClient.on("error", (err) => reject(err));
          watchdog = setTimeout(() => {
            logger.warn(
              { call_id: this.session.callSid, deadline_ms: deadlineMs },
              "call_session_stt_watchdog_fired",
            );
            try { sttClient.cancel(); } catch { /* ignore */ }
            reject(new Error("stt_watchdog_timeout"));
          }, deadlineMs);
          sttClient.transcribe({
            pcm16,
            sampleRate: 16000,
            language: agentConfig.language,
          });
        });
        return (final.text ?? "").trim();
      } finally {
        if (watchdog) { clearTimeout(watchdog); watchdog = null; }
        if (this.sttInFlight === sttClient) this.sttInFlight = null;
        this.sttRejectInFlight = null;
      }
    };

    try {
      transcript = await runSttOnce();
      finalReceived = true;
    } catch (err) {
      sttErr = (err as Error).message;
      // Turn-1 retry: cold-call STT failures are dominated by handshake / TLS
      // setup race conditions that almost always succeed on the immediate
      // second attempt. We retry ONLY on the first user turn, ONLY on
      // transient-looking errors (timeouts / closes / network), and ONLY
      // once. Subsequent turns rely on the warm socket so they don't need
      // this safety net.
      const transient =
        sttErr.includes("timeout") ||
        sttErr.includes("closed_without_response") ||
        sttErr.includes("watchdog") ||
        sttErr.includes("ECONN") ||
        sttErr.includes("socket hang up") ||
        sttErr.includes("network");
      if (this.turnId === 0 && transient && !this.cancelled) {
        // Bounded 2s deadline for the retry: the first attempt already burned
        // up to STT_HARD_DEADLINE_MS; if we let the retry run for the same
        // duration, dead air on a stuck second attempt would exceed 24s.
        // 2s is enough for a fast warm-handshake-and-respond on a healthy
        // network and fails fast otherwise so we can re-prompt the user.
        const RETRY_DEADLINE_MS = 2000;
        logger.warn(
          { call_id: this.session.callSid, err: sttErr, retry_deadline_ms: RETRY_DEADLINE_MS },
          "call_session_stt_turn1_retrying",
        );
        try {
          transcript = await runSttOnce(RETRY_DEADLINE_MS);
          finalReceived = true;
          sttErr = null;
        } catch (err2) {
          sttErr = `retry: ${(err2 as Error).message}`;
        }
      }
    }
    // If onStop() fired during the await, drop the result and exit cleanly.
    if (this.cancelled) return;

    const flushMs = Math.round(performance.now() - this.flushStartMs);

    const turnLog: PerTurnLog = {
      call_id: this.session.callSid,
      turn_id: this.turnId + 1,
      state: this.state,
      bot_speaking_start: this.botSpeakingStartMs ? Math.round(this.botSpeakingStartMs) : null,
      bot_speaking_end: this.botSpeakingEndMs ? Math.round(this.botSpeakingEndMs) : null,
      listening_start: this.listeningStartMs ? Math.round(this.listeningStartMs) : null,
      audio_sample_rate: this.session.format.sampleRate,
      audio_encoding: this.session.format.encoding,
      chunk_count_sent_to_stt: chunkCount,
      total_audio_ms_sent_to_stt: totalAudioMs,
      rms_min: Math.round(rmsMin),
      rms_avg: Math.round(rmsAvg),
      rms_max: Math.round(rmsMax),
      stt_partial_received: 0,
      stt_final_received: finalReceived,
      final_transcript: transcript,
      flush_time: flushMs,
      silence_timeout_reason: reason,
      sarvam_ws_errors: sttErr,
    };
    // STT-only context log. The canonical `call_session_turn` event is
    // emitted later in flushAndProcess once LLM+TTS metrics are known, so
    // downstream consumers can rely on a single event with all 13 fields.
    logger.info(
      { ...turnLog, stt_attempts: sttAttempts, stt_used_warm_socket: sttUsedWarmSocket },
      "call_session_stt_complete",
    );
    // Stash the turn context so we can fold it into the final
    // `call_session_turn` payload (single canonical emission contract).
    this.lastTurnContext = {
      ...turnLog,
      stt_attempts: sttAttempts,
      stt_used_warm_socket: sttUsedWarmSocket,
    };

    if (this.cancelled) return;

    if (!transcript) {
      // Couldn't get a transcript — re-prompt once, otherwise end.
      this.resetTurnBuffers();
      this.rePromptCount++;
      if (this.rePromptCount > 2) {
        await this.speakAndEnd(
          "Sorry, I'm having trouble hearing you. I'll call you back soon. Bye!",
          "stt_failure",
        );
        return;
      }
      await this.speakAndAdvance(
        "Sorry, kya aap dohra sakte hain?",
        /*isOpening*/ false,
      );
      return;
    }

    this.transition("PROCESS_TRANSCRIPT");
    this.turnId++;
    // Capture the end-of-user-utterance timestamp BEFORE resetTurnBuffers()
    // clears flushStartMs — otherwise stt_latency_ms collapses to ~0 and
    // total_roundtrip_ms loses the STT stage (caught by code review).
    const turnStartMs = this.flushStartMs ?? performance.now();
    // Clear buffers BEFORE the LLM await so any inbound frames during the
    // gap don't accumulate against the next turn (they're already dropped
    // because state isn't LISTENING, but be defensive).
    this.resetTurnBuffers();
    this.rePromptCount = 0;

    const sessionState = getSession(this.session.callSid);
    if (!sessionState) {
      logger.warn({ callSid: this.session.callSid }, "call_session_lost_conversation_state");
      await this.speakAndEnd("Thank you for your time. Goodbye!", "session_lost");
      return;
    }

    // Capture LLM request / complete stamps to compute per-stage metrics.
    // For non-streaming providers (the only kind we have today) first-token
    // is reported as the response completion stamp, so llm_first_token_ms
    // collapses to llm_latency_ms. Once a streaming provider lands the
    // provider's `firstTokenMs` will be honoured here.
    const sttFinalAtMs = performance.now();
    const llmRequestSentAtMs = performance.now();
    const { text: agentText, shouldEnd, chatMs, chatModel, chatProvider, completionTokens, firstTokenMs: providerFirstTokenMs } =
      await generateConversationResponse(
        sessionState.messages,
        transcript,
        { llmProviderOverride: this.llmProviderOverride },
      );
    const llmCompleteAtMs = performance.now();
    logger.info(
      {
        call_id: this.session.callSid,
        turn_id: this.turnId,
        chat_ms: chatMs,
        chat_model: chatModel,
        chat_provider: chatProvider,
        should_end: shouldEnd,
        agent_text_preview: agentText.slice(0, 200),
      },
      "call_session_chat_completed",
    );
    addTurn(this.session.callSid, transcript, agentText);

    broadcastSse("call.turn", {
      callSid: this.session.callSid,
      leadId: this.leadId,
      leadName: this.leadName,
      turn: this.turnId,
      userText: transcript,
      agentText,
      isEnd: shouldEnd || this.turnId >= (agentConfig.maxTurns ?? MAX_TURNS_DEFAULT),
    });

    const isEnd = shouldEnd || this.turnId >= (agentConfig.maxTurns ?? MAX_TURNS_DEFAULT);
    const ttsTimings = isEnd
      ? await this.speakAndEnd(agentText, shouldEnd ? "llm_done" : "max_turns")
      : await this.speakAndAdvance(agentText, /*isOpening*/ false);

    // Compute per-stage metrics + persist fire-and-forget. Wrap the whole
    // block so an arithmetic edge case never aborts the call.
    try {
      const sttLatencyMs = Math.max(0, Math.round(sttFinalAtMs - turnStartMs));
      const llmLatencyMs = Math.max(0, Math.round(llmCompleteAtMs - llmRequestSentAtMs));
      // Honour the provider's reported first-token timing when available
      // (streaming providers); fall back to full LLM latency for
      // non-streaming providers (synthetic, per task #29 spec).
      const llmFirstTokenMs =
        providerFirstTokenMs != null ? Math.max(0, Math.round(providerFirstTokenMs)) : llmLatencyMs;
      // Real wall-clock at which the first token landed; used as the
      // baseline for first_word_trigger_ms and the divisor for tokens/sec
      // (only the post-first-token generation window counts).
      const llmFirstTokenAtMs = llmRequestSentAtMs + llmFirstTokenMs;
      const llmGenerationMs = Math.max(1, llmLatencyMs - llmFirstTokenMs);
      // tokens/sec is "completion tokens emitted per second of generation
      // after first token", per task #29 spec. Null when the provider
      // didn't return usage (Sarvam currently).
      const llmTokensPerSec =
        completionTokens ? +(completionTokens / (llmGenerationMs / 1000)).toFixed(2) : null;

      const firstFrameAtMs = ttsTimings?.firstFrameAtMs ?? null;
      const lastFrameAtMs  = ttsTimings?.lastFrameAtMs  ?? null;
      const ttsRequestAtMs = ttsTimings?.ttsRequestAtMs ?? null;
      const ttsFirstByteAtMs = ttsTimings?.ttsFirstByteAtMs ?? null;

      // first_word_trigger_ms = time from LLM's first token to TTS request
      // dispatch. For non-streaming providers first-token == complete, so
      // this equals the time we spent buffering after the LLM call returned.
      const firstWordTriggerMs =
        ttsRequestAtMs != null ? Math.max(0, Math.round(ttsRequestAtMs - llmFirstTokenAtMs)) : null;
      const ttsStreamStartMs =
        ttsRequestAtMs != null && ttsFirstByteAtMs != null
          ? Math.max(0, Math.round(ttsFirstByteAtMs - ttsRequestAtMs))
          : null;
      const firstPlaybackMs =
        ttsFirstByteAtMs != null && firstFrameAtMs != null
          ? Math.max(0, Math.round(firstFrameAtMs - ttsFirstByteAtMs))
          : null;
      const firstAudioChunkMs =
        firstFrameAtMs != null ? Math.max(0, Math.round(firstFrameAtMs - turnStartMs)) : null;
      const ttsCompleteMs =
        ttsFirstByteAtMs != null && lastFrameAtMs != null
          ? Math.max(0, Math.round(lastFrameAtMs - ttsFirstByteAtMs))
          : null;
      const ttsLatencyMs =
        ttsRequestAtMs != null && lastFrameAtMs != null
          ? Math.max(0, Math.round(lastFrameAtMs - ttsRequestAtMs))
          : null;
      const totalRoundtripMs = firstAudioChunkMs;
      const ttsPlaybackStartAt = ttsTimings?.firstFrameWallClockAt ?? null;

      const metricsBlock = {
        stt_latency_ms: sttLatencyMs,
        llm_first_token_ms: llmFirstTokenMs,
        llm_tokens_per_sec: llmTokensPerSec,
        first_word_trigger_ms: firstWordTriggerMs,
        tts_stream_start_ms: ttsStreamStartMs,
        first_playback_ms: firstPlaybackMs,
        first_audio_chunk_ms: firstAudioChunkMs,
        tts_playback_start_at: ttsPlaybackStartAt?.toISOString() ?? null,
        tts_complete_ms: ttsCompleteMs,
        llm_latency_ms: llmLatencyMs,
        tts_latency_ms: ttsLatencyMs,
        total_roundtrip_ms: totalRoundtripMs,
        livekit_transport_ms: null as number | null,
      };

      // Single canonical `call_session_turn` event — fold the STT context
      // captured earlier with the LLM + TTS metrics so live tail consumers
      // get one payload with all 13 fields + transcript/turn context.
      logger.info(
        {
          ...(this.lastTurnContext ?? {}),
          call_id: this.session.callSid,
          turn_id: this.turnId,
          llm_provider: chatProvider,
          llm_model: chatModel,
          ...metricsBlock,
        },
        "call_session_turn",
      );
      this.lastTurnContext = null;

      // Resolve the DB call id from the Twilio call SID and persist.
      // Fire-and-forget; no await — the call session continues immediately.
      void (async () => {
        try {
          const dbCallId = await findCallIdBySid(this.session.callSid);
          if (dbCallId == null) return;
          recordTurnMetrics({
            callId: dbCallId,
            turnId: this.turnId,
            llmProvider: chatProvider,
            llmModel: chatModel,
            sttLatencyMs,
            llmFirstTokenMs,
            llmTokensPerSec,
            firstWordTriggerMs,
            ttsStreamStartMs,
            firstPlaybackMs,
            firstAudioChunkMs,
            ttsPlaybackStartAt,
            ttsCompleteMs,
            llmLatencyMs,
            ttsLatencyMs,
            totalRoundtripMs,
            livekitTransportMs: null,
          });
        } catch (err) {
          logger.warn(
            { err: (err as Error).message, call_id: this.session.callSid },
            "call_metrics_resolve_failed",
          );
        }
      })();
    } catch (err) {
      logger.warn(
        { err: (err as Error).message, call_id: this.session.callSid, turn_id: this.turnId },
        "call_session_metrics_compute_failed",
      );
    }
  }

  private async speakAndAdvance(text: string, _isOpening: boolean): Promise<TtsTimings | null> {
    if (this.cancelled) return null;
    const myEpoch = ++this.ttsEpoch;
    this.ttsStopRequested = false;
    this.bargeInFirstAtMs = null;
    this.botFirstFrameSentAtMs = null;
    this.transition("BOT_SPEAKING");
    this.botSpeakingStartMs = performance.now();
    // Pre-warm the Sarvam STT WS during bot speech so the handshake cost
    // (~300ms typical, observed up to 12s on cold turn-1) is paid before
    // the user finishes their reply rather than after.
    this.prewarmStt();
    const timings = await this.streamTtsToTwilio(text, myEpoch);
    // If a newer speak invocation has started (barge-in → next turn) while we
    // were awaiting our pipelined TTS promises, bail without touching state
    // or arming a watchdog — the new speak owns the session now.
    if (this.cancelled || this.ttsEpoch !== myEpoch) return timings;
    if (this.state !== "BOT_SPEAKING") return timings;
    this.botSpeakingEndMs = performance.now();

    this.transition("WAIT_AFTER_BOT_SPEECH");
    this.postBotTimer = setTimeout(() => {
      this.postBotTimer = null;
      this.startListening();
    }, POST_BOT_GRACE_MS);
    return timings;
  }

  /**
   * Open a Sarvam STT WS in the background during BOT_SPEAKING, no-op if a
   * warm socket already exists, no-op if cancelled or no API key. Failures
   * are swallowed at info level — the cold path in flushAndProcess will pick
   * up the slack so a prewarm error never breaks a turn.
   */
  private prewarmStt(): void {
    if (this.cancelled || this.warmStt) return;
    const client = new SarvamSttClient();
    // CRITICAL: attach a no-op `error` listener BEFORE prewarm() fires.
    // SarvamSttClient is an EventEmitter and `fail()` emits 'error'; without
    // a listener, Node's EventEmitter throws and crashes the process. The
    // prewarm path has no transcribe-time listeners attached yet, so we own
    // the safety net here. runSttOnce will add its own 'error' listener
    // later (multiple listeners are fine — both fire, prewarm noop ignores,
    // runSttOnce rejects).
    client.on("error", () => { /* swallowed — handled via prewarm() promise */ });
    this.warmStt = client;
    client.prewarm(agentConfig.language).catch((err) => {
      logger.info(
        { call_id: this.session.callSid, err: (err as Error).message },
        "call_session_stt_prewarm_failed",
      );
      if (this.warmStt === client) this.warmStt = null;
    });
  }

  private async speakAndEnd(text: string, reason: string): Promise<TtsTimings | null> {
    if (this.cancelled) return null;
    const myEpoch = ++this.ttsEpoch;
    this.ttsStopRequested = false;
    this.bargeInFirstAtMs = null;
    this.botFirstFrameSentAtMs = null;
    this.transition("BOT_SPEAKING");
    this.botSpeakingStartMs = performance.now();
    const timings = await this.streamTtsToTwilio(text, myEpoch);
    if (this.cancelled || this.ttsEpoch !== myEpoch) return timings;
    this.botSpeakingEndMs = performance.now();
    logger.info(
      { call_id: this.session.callSid, reason, turn_id: this.turnId },
      "call_session_ending",
    );
    this.endCall(reason);
    return timings;
  }

  /**
   * Pipeline TTS synthesis and playback at the sentence level so the user
   * hears the first sentence within ~one TTS round-trip instead of waiting
   * for the whole reply to synthesize.
   *
   * Sarvam HTTP TTS does not chunked-stream the response body (it returns
   * full WAV as base64 in JSON), so true byte-level streaming isn't
   * available. Sentence chunking is the realistic equivalent: the first
   * chunk's TTS cost dominates time-to-first-audio, and remaining chunks
   * synthesize in parallel during playback of earlier ones.
   */
  private async streamTtsToTwilio(text: string, epoch: number): Promise<TtsTimings | null> {
    const startedAtAll = performance.now();
    const chunks = splitForTTS(text);
    if (chunks.length === 0) return null;

    // Per-stage stamps used by the metrics block in flushAndProcess.
    const ttsRequestAtMs = performance.now();
    let ttsFirstByteAtMs: number | null = null;
    let firstFrameAtMs: number | null = null;
    let firstFrameWallClockAt: Date | null = null;
    let lastFrameAtMs: number | null = null;

    // Kick off all TTS requests concurrently. They resolve out of order, but
    // we play them strictly in order via the awaited iteration below.
    const ttsPromises = chunks.map((c) => generateSpeech(c, agentConfig));

    let firstFrameLogged = false;
    // Stale-epoch check: any in-flight call from a superseded turn must not
    // emit frames, even if the original `ttsStopRequested` was reset by a
    // newer `speakAndAdvance()` invocation.
    const isStale = (): boolean =>
      this.cancelled || this.ttsStopRequested || this.ttsEpoch !== epoch;

    for (let i = 0; i < ttsPromises.length; i++) {
      if (isStale()) return { ttsRequestAtMs, ttsFirstByteAtMs, firstFrameAtMs, firstFrameWallClockAt, lastFrameAtMs };
      const wav = await ttsPromises[i];
      if (i === 0) ttsFirstByteAtMs = performance.now();
      if (isStale()) return { ttsRequestAtMs, ttsFirstByteAtMs, firstFrameAtMs, firstFrameWallClockAt, lastFrameAtMs };
      if (!wav || wav.length <= 44) {
        logger.warn(
          {
            call_id: this.session.callSid,
            chunkIndex: i,
            textPreview: chunks[i].slice(0, 60),
          },
          "call_session_tts_empty",
        );
        continue;
      }

      const parsed = parseWav(wav);
      let pcm = parsed?.pcm ?? wav.subarray(44);
      const srcRate = parsed?.sampleRate ?? 8000;
      const srcChannels = parsed?.channels ?? 1;
      const srcBits = parsed?.bitsPerSample ?? 16;

      // Defensive normalisation: Twilio Media Streams expects 8 kHz mono s16le
      // PCM (which we then μ-law encode). Sarvam should honour
      // target_sample_rate_hz=8000, but Bulbul has historically returned
      // 22050/24000 in some cases — verify and resample on the fly so the
      // user actually hears intelligible speech instead of pitched-down garble.
      if (srcBits !== 16) {
        logger.warn(
          { call_id: this.session.callSid, srcBits, chunkIndex: i },
          "call_session_tts_unexpected_bit_depth",
        );
      }
      if (srcChannels === 2) pcm = stereoToMonoPcm16(pcm);
      if (srcRate !== 8000) {
        if (!this.ttsResamplingNoticeLogged) {
          // INFO not WARN: Sarvam Bulbul:v3 routinely ignores
          // target_sample_rate_hz=8000 and returns 22050/24000 even when we
          // ask for 8000. The on-the-fly resample is correct behaviour, not
          // a fault — emitting a per-turn WARN was just spamming the log.
          // Once-per-call info gives us the same observability without noise.
          // See replit.md ("Sarvam TTS sample rate") for context.
          this.ttsResamplingNoticeLogged = true;
          logger.info(
            { call_id: this.session.callSid, srcRate, srcChannels, srcBits },
            "call_session_tts_resampling_to_8khz",
          );
        }
        pcm = resamplePcm16Mono(pcm, srcRate, 8000);
      }

      const frameBytesPcm = this.provider.outboundFrameBytesPcm();
      const frameIntervalMs = this.provider.outboundFrameIntervalMs();
      const totalFrames = Math.ceil(pcm.length / frameBytesPcm);
      const startedAtChunk = performance.now();

      for (let sent = 0; sent < totalFrames; sent++) {
        if (isStale()) return { ttsRequestAtMs, ttsFirstByteAtMs, firstFrameAtMs, firstFrameWallClockAt, lastFrameAtMs };
        const offset = sent * frameBytesPcm;
        const pcmSlice = pcm.subarray(offset, Math.min(offset + frameBytesPcm, pcm.length));
        const wireSlice = this.provider.encodeOutboundFrame(pcmSlice);
        this.session.sendAudio(wireSlice);

        if (!firstFrameLogged) {
          firstFrameLogged = true;
          // Mark when audio actually started flowing — barge-in detection
          // gates on this so the user's "Hello?" on pickup doesn't kill
          // the greeting before they've heard anything.
          this.botFirstFrameSentAtMs = performance.now();
          firstFrameAtMs = this.botFirstFrameSentAtMs;
          firstFrameWallClockAt = new Date();
          {
            const elapsed = Math.round(performance.now() - startedAtAll);
            logger.info(
              {
                call_id: this.session.callSid,
                turn_id: this.turnId,
                // ttfa_ms preserved for log-search compatibility; tts_ms and
                // first_wire_frame_ms are aliases that match the names other
                // observability surfaces (dashboards, alerts) standardise on.
                ttfa_ms: elapsed,
                tts_ms: elapsed,
                first_wire_frame_ms: elapsed,
                chunks: chunks.length,
                first_chunk_chars: chunks[0].length,
              },
              "call_session_tts_first_frame",
            );
          }
        }

        const targetMs = (sent + 1) * frameIntervalMs;
        const elapsedMs = performance.now() - startedAtChunk;
        const drift = targetMs - elapsedMs;
        if (drift > 1) {
          await new Promise<void>((r) => setTimeout(r, drift));
        }
      }
    }
    lastFrameAtMs = performance.now();
    return { ttsRequestAtMs, ttsFirstByteAtMs, firstFrameAtMs, firstFrameWallClockAt, lastFrameAtMs };
  }

  private endCall(reason: string): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.ttsStopRequested = true;
    this.clearTimers();
    this.transition("ENDED");
    void this.finaliseAndAnalyse(reason);
    // Closing the WS makes Twilio terminate the call leg.
    this.session.close();
  }

  private async finaliseAndAnalyse(reason: string): Promise<void> {
    if (this.finalised) return;
    this.finalised = true;

    const sessionState = endSession(this.session.callSid);
    broadcastSse("call.ended", {
      callSid: this.session.callSid,
      leadId: this.leadId,
      leadName: this.leadName,
      turns: sessionState?.turnCount ?? 0,
      endedAt: Date.now(),
      reason,
    });

    if (!sessionState || !sessionState.transcript) {
      logger.info(
        { call_id: this.session.callSid, reason },
        "call_session_finalised_no_transcript",
      );
      return;
    }

    try {
      await updateCallTranscript(this.session.callSid, sessionState.transcript);
      const { interest, nextAction, summary } = await analyzeTranscript(
        sessionState.transcript,
      );
      const leadStatus =
        interest === "high" || nextAction === "demo"
          ? "interested"
          : nextAction === "drop"
          ? "not_interested"
          : "completed";
      if (this.leadId) {
        await updateLeadStatus(this.leadId, leadStatus);
        await db
          .update(leadsTable)
          .set({ notes: summary, updatedAt: new Date() })
          .where(eq(leadsTable.id, this.leadId));
      }
      logger.info(
        { call_id: this.session.callSid, leadId: this.leadId, leadStatus, interest, nextAction },
        "call_session_finalised",
      );
    } catch (err) {
      logger.error(
        { err, call_id: this.session.callSid },
        "call_session_finalise_failed",
      );
    }
  }
}

/**
 * Walk a RIFF/WAVE buffer and return the `data` payload plus the format
 * metadata read from the `fmt ` chunk (sample rate, channels, bit depth).
 * Returns null if the buffer is not a parseable WAV — caller falls back to
 * the canonical 44-byte offset and an assumed 8 kHz mono s16le format.
 */
function parseWav(
  buf: Buffer,
): { pcm: Buffer; sampleRate: number; channels: number; bitsPerSample: number } | null {
  if (buf.length < 12) return null;
  if (buf.toString("ascii", 0, 4) !== "RIFF") return null;
  if (buf.toString("ascii", 8, 12) !== "WAVE") return null;
  let sampleRate = 0;
  let channels = 0;
  let bitsPerSample = 0;
  let pcm: Buffer | null = null;
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const payloadStart = offset + 8;
    const payloadEnd = payloadStart + size;
    if (id === "fmt " && payloadStart + 16 <= buf.length) {
      // WAVEFORMAT(EX): u16 audioFormat, u16 channels, u32 sampleRate,
      //                 u32 byteRate, u16 blockAlign, u16 bitsPerSample
      channels = buf.readUInt16LE(payloadStart + 2);
      sampleRate = buf.readUInt32LE(payloadStart + 4);
      bitsPerSample = buf.readUInt16LE(payloadStart + 14);
    } else if (id === "data") {
      pcm =
        payloadEnd > buf.length
          ? buf.subarray(payloadStart)
          : buf.subarray(payloadStart, payloadEnd);
    }
    if (pcm && sampleRate) break;
    // RIFF chunks are word-aligned; pad byte if size is odd.
    offset = payloadEnd + (size % 2);
  }
  if (!pcm) return null;
  return {
    pcm,
    sampleRate: sampleRate || 8000,
    channels: channels || 1,
    bitsPerSample: bitsPerSample || 16,
  };
}

// ── Subscriber registration ────────────────────────────────────────────────
//
// CallSession matches any Media Streams session that has a `leadId` custom
// parameter and is NOT a debug audio capture (which uses `captureId`). The
// audio-capture subscriber registers earlier in module load order and matches
// only `captureId`, so there's no ambiguity.

subscribeMediaStream({
  match(_callSid, params) {
    if (params["captureId"]) return false;
    return !!params["leadId"];
  },
  handler: makeHandler(),
});

function makeHandler(): MediaStreamHandler {
  // One CallSession per MediaStreamSession instance, keyed by streamSid.
  const sessions = new Map<string, CallSession>();
  return {
    onStart(session) {
      const rawOverride = session.customParameters["llmProvider"];
      const cs = new CallSession(session, {
        llmProviderOverride: isLlmProviderId(rawOverride) ? rawOverride : undefined,
      });
      sessions.set(session.streamSid, cs);
      void cs.start();
    },
    onMedia(session, payload) {
      const cs = sessions.get(session.streamSid);
      cs?.onMedia(payload);
    },
    onStop(session) {
      const cs = sessions.get(session.streamSid);
      if (!cs) return;
      sessions.delete(session.streamSid);
      cs.onStop();
    },
  };
}
