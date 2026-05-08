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
import { SarvamSttClient } from "../services/sarvam-stt-ws.client.js";
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

  // Monotonic timestamps for the current turn.
  private botSpeakingStartMs: number | null = null;
  private botSpeakingEndMs: number | null = null;
  private listeningStartMs: number | null = null;
  private flushStartMs: number | null = null;

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

  constructor(session: MediaStreamSession) {
    this.session = session;
    const leadIdRaw = session.customParameters["leadId"];
    this.leadId = leadIdRaw ? parseInt(leadIdRaw, 10) || 0 : 0;
  }

  async start(): Promise<void> {
    try {
      const lead = this.leadId ? await getLeadById(this.leadId) : null;
      this.leadName = lead?.name ?? "there";
      // Resolve the per-tenant IVR adapter — Twilio for platform calls and
      // Twilio-flagged tenants, Exotel scaffold for Exotel-flagged tenants.
      // Fail-safe: any DB error keeps the Twilio default already on `this`.
      if (this.leadId) {
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
    // Use the lower-level SarvamSttClient directly (instead of the retrying
    // transcribePcm16 helper) so onStop() can abort the in-flight socket via
    // sttInFlight.cancel(). Phase 3 prefers fast termination on hangup over
    // best-effort retries — a hung-up call doesn't need a transcript.
    const sttClient = new SarvamSttClient();
    this.sttInFlight = sttClient;
    // Defence-in-depth watchdog: even if the STT client somehow fails to
    // emit a terminal event (a real-world hang we observed: lead 43, the
    // FLUSH_STT → WAIT_FOR_FINAL_TRANSCRIPT state sat for 10s with no log
    // until the user hung up), this guarantees the state machine never
    // wedges silently. Set 1s above the client's own response timeout so
    // the client gets the chance to surface a typed error first.
    const STT_HARD_DEADLINE_MS = 7000;
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
            { call_id: this.session.callSid, deadline_ms: STT_HARD_DEADLINE_MS },
            "call_session_stt_watchdog_fired",
          );
          try { sttClient.cancel(); } catch { /* ignore */ }
          reject(new Error("stt_watchdog_timeout"));
        }, STT_HARD_DEADLINE_MS);
        sttClient.transcribe({
          pcm16,
          sampleRate: 16000,
          language: agentConfig.language,
        });
      });
      transcript = (final.text ?? "").trim();
      finalReceived = true;
    } catch (err) {
      sttErr = (err as Error).message;
    } finally {
      if (watchdog) { clearTimeout(watchdog); watchdog = null; }
      // Clear handles so onStop() doesn't double-cancel a settled client and
      // doesn't try to reject a promise that already resolved.
      if (this.sttInFlight === sttClient) this.sttInFlight = null;
      this.sttRejectInFlight = null;
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
    logger.info(turnLog, "call_session_turn");

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

    const { text: agentText, shouldEnd } = await generateConversationResponse(
      sessionState.messages,
      transcript,
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

    if (shouldEnd || this.turnId >= (agentConfig.maxTurns ?? MAX_TURNS_DEFAULT)) {
      await this.speakAndEnd(agentText, shouldEnd ? "llm_done" : "max_turns");
      return;
    }

    await this.speakAndAdvance(agentText, /*isOpening*/ false);
  }

  private async speakAndAdvance(text: string, _isOpening: boolean): Promise<void> {
    if (this.cancelled) return;
    const myEpoch = ++this.ttsEpoch;
    this.ttsStopRequested = false;
    this.bargeInFirstAtMs = null;
    this.transition("BOT_SPEAKING");
    this.botSpeakingStartMs = performance.now();
    await this.streamTtsToTwilio(text, myEpoch);
    // If a newer speak invocation has started (barge-in → next turn) while we
    // were awaiting our pipelined TTS promises, bail without touching state
    // or arming a watchdog — the new speak owns the session now.
    if (this.cancelled || this.ttsEpoch !== myEpoch) return;
    if (this.state !== "BOT_SPEAKING") return;
    this.botSpeakingEndMs = performance.now();

    this.transition("WAIT_AFTER_BOT_SPEECH");
    this.postBotTimer = setTimeout(() => {
      this.postBotTimer = null;
      this.startListening();
    }, POST_BOT_GRACE_MS);
  }

  private async speakAndEnd(text: string, reason: string): Promise<void> {
    if (this.cancelled) return;
    const myEpoch = ++this.ttsEpoch;
    this.ttsStopRequested = false;
    this.bargeInFirstAtMs = null;
    this.transition("BOT_SPEAKING");
    this.botSpeakingStartMs = performance.now();
    await this.streamTtsToTwilio(text, myEpoch);
    if (this.cancelled || this.ttsEpoch !== myEpoch) return;
    this.botSpeakingEndMs = performance.now();
    logger.info(
      { call_id: this.session.callSid, reason, turn_id: this.turnId },
      "call_session_ending",
    );
    this.endCall(reason);
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
  private async streamTtsToTwilio(text: string, epoch: number): Promise<void> {
    const startedAtAll = performance.now();
    const chunks = splitForTTS(text);
    if (chunks.length === 0) return;

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
      if (isStale()) return;
      const wav = await ttsPromises[i];
      if (isStale()) return;
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

      const pcm = extractWavPcm(wav) ?? wav.subarray(44);
      const frameBytesPcm = this.provider.outboundFrameBytesPcm();
      const frameIntervalMs = this.provider.outboundFrameIntervalMs();
      const totalFrames = Math.ceil(pcm.length / frameBytesPcm);
      const startedAtChunk = performance.now();

      for (let sent = 0; sent < totalFrames; sent++) {
        if (isStale()) return;
        const offset = sent * frameBytesPcm;
        const pcmSlice = pcm.subarray(offset, Math.min(offset + frameBytesPcm, pcm.length));
        const wireSlice = this.provider.encodeOutboundFrame(pcmSlice);
        this.session.sendAudio(wireSlice);

        if (!firstFrameLogged) {
          firstFrameLogged = true;
          logger.info(
            {
              call_id: this.session.callSid,
              turn_id: this.turnId,
              ttfa_ms: Math.round(performance.now() - startedAtAll),
              chunks: chunks.length,
              first_chunk_chars: chunks[0].length,
            },
            "call_session_tts_first_frame",
          );
        }

        const targetMs = (sent + 1) * frameIntervalMs;
        const elapsedMs = performance.now() - startedAtChunk;
        const drift = targetMs - elapsedMs;
        if (drift > 1) {
          await new Promise<void>((r) => setTimeout(r, drift));
        }
      }
    }
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
 * Walk a RIFF/WAVE buffer and return just the `data` chunk payload.
 * Returns null if the buffer is not a parseable WAV — caller falls back to
 * the canonical 44-byte offset.
 */
function extractWavPcm(buf: Buffer): Buffer | null {
  if (buf.length < 12) return null;
  if (buf.toString("ascii", 0, 4) !== "RIFF") return null;
  if (buf.toString("ascii", 8, 12) !== "WAVE") return null;
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const payloadStart = offset + 8;
    const payloadEnd = payloadStart + size;
    if (id === "data") {
      if (payloadEnd > buf.length) return buf.subarray(payloadStart);
      return buf.subarray(payloadStart, payloadEnd);
    }
    // RIFF chunks are word-aligned; pad byte if size is odd.
    offset = payloadEnd + (size % 2);
  }
  return null;
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
      const cs = new CallSession(session);
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
