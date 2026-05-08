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
  muLawToPcm16,
  upsample8kTo16k,
  pcm16ToMuLaw,
  rmsPcm16,
} from "../audio/codec.js";
import {
  generateSpeech,
  generateConversationResponse,
  analyzeTranscript,
} from "../services/sarvam.service.js";
import { transcribePcm16 } from "../services/sarvam-stt-ws.client.js";
import {
  agentConfig,
  buildGreetingText,
  buildSystemPrompt,
} from "../config/agent.config.js";
import {
  createSession,
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

const FRAME_BYTES = 160;             // 20 ms @ 8 kHz μ-law
const FRAME_INTERVAL_MS = 20;
const POST_BOT_GRACE_MS = 400;       // WAIT_AFTER_BOT_SPEECH
const SILENCE_END_MS = 1500;         // USER_SILENCE_DETECTED window
const SPEECH_RMS_THRESHOLD = 600;    // RMS over 8 kHz PCM s16le ~ silence floor
const SILENCE_RMS_THRESHOLD = 350;   // hysteresis: must drop below this to count as silence
const HEALTH_GATE_AFTER_MS = 6000;   // re-prompt eligibility window
const MIN_SPEECH_MS = 300;           // ignore sub-300ms blips as noise
const MAX_LISTEN_MS = 12000;         // hard ceiling on a single LISTENING window
const MAX_TURNS_DEFAULT = 6;

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

class CallSession {
  state: State = "IDLE";
  private session: MediaStreamSession;
  private leadId: number;
  private leadName = "there";
  private turnId = 0;

  // Per-turn capture buffers (PCM s16le 8 kHz frames concatenated; we upsample
  // once at flush rather than per-frame to amortise cost).
  private pcmFrames: Buffer[] = [];
  private rmsValues: number[] = [];
  private speechFirstAtMs: number | null = null;
  private speechLastAtMs: number | null = null;

  // Monotonic timestamps for the current turn.
  private botSpeakingStartMs: number | null = null;
  private botSpeakingEndMs: number | null = null;
  private listeningStartMs: number | null = null;
  private flushStartMs: number | null = null;

  // Lifecycle flags / timers
  private cancelled = false;
  private ttsStopRequested = false;
  private postBotTimer: NodeJS.Timeout | null = null;
  private listenWatchdog: NodeJS.Timeout | null = null;
  private healthGateFired = false;
  private rePromptCount = 0;
  private finalised = false;

  constructor(session: MediaStreamSession) {
    this.session = session;
    const leadIdRaw = session.customParameters["leadId"];
    this.leadId = leadIdRaw ? parseInt(leadIdRaw, 10) || 0 : 0;
  }

  async start(): Promise<void> {
    try {
      const lead = this.leadId ? await getLeadById(this.leadId) : null;
      this.leadName = lead?.name ?? "there";

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

      logger.info(
        {
          call_id: this.session.callSid,
          leadId: this.leadId,
          leadName: this.leadName,
          state_from: "IDLE",
          state_to: "BOT_SPEAKING",
          ts: Math.round(performance.now()),
        },
        "call_session_state_transition",
      );

      await this.speakAndAdvance(greetingText, /*isOpening*/ true);
    } catch (err) {
      logger.error({ err, callSid: this.session.callSid }, "call_session_start_failed");
      this.endCall("start_failed");
    }
  }

  /** Inbound μ-law frame from Twilio. Drop unless we're actively listening. */
  onMedia(payload: Buffer): void {
    if (this.cancelled) return;
    if (this.state !== "LISTENING" && this.state !== "USER_SPEECH_DETECTED") return;

    const pcm8 = muLawToPcm16(payload);
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
    this.healthGateFired = false;
    this.flushStartMs = null;
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
      // We DID get audio but no clear speech onset (e.g. background noise).
      // Wait the rest of MAX_LISTEN_MS in case the user is still gathering.
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
    // terminator. Per spec.
    const rePrompt =
      agentConfig.language === "hi-IN" || agentConfig.language === "en-IN"
        ? "Hello, kya aap sun rahe hain?"
        : "Hello, are you still there?";
    await this.speakAndAdvance(rePrompt, /*isOpening*/ false, /*countAsTurn*/ false);
  }

  private async flushAndProcess(reason: string): Promise<void> {
    if (this.cancelled || this.finalised) return;
    if (this.listenWatchdog) { clearTimeout(this.listenWatchdog); this.listenWatchdog = null; }

    this.transition("FLUSH_STT");
    this.flushStartMs = performance.now();

    const pcm8 = Buffer.concat(this.pcmFrames);
    const chunkCount = this.pcmFrames.length;
    const totalAudioMs = chunkCount * FRAME_INTERVAL_MS;
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
    try {
      const final = await transcribePcm16({
        pcm16,
        sampleRate: 16000,
        language: agentConfig.language,
      });
      transcript = (final.text ?? "").trim();
      finalReceived = true;
    } catch (err) {
      sttErr = (err as Error).message;
    }

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
        /*countAsTurn*/ false,
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

    const sessionState = (await import("../services/conversation-state.js")).getSession(
      this.session.callSid,
    );
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

  private async speakAndAdvance(
    text: string,
    _isOpening: boolean,
    countAsTurn = true,
  ): Promise<void> {
    if (this.cancelled) return;
    this.transition("BOT_SPEAKING");
    this.botSpeakingStartMs = performance.now();
    await this.streamTtsToTwilio(text);
    if (this.cancelled) return;
    this.botSpeakingEndMs = performance.now();
    void countAsTurn; // currently informational only

    this.transition("WAIT_AFTER_BOT_SPEECH");
    this.postBotTimer = setTimeout(() => {
      this.postBotTimer = null;
      this.startListening();
    }, POST_BOT_GRACE_MS);
  }

  private async speakAndEnd(text: string, reason: string): Promise<void> {
    if (this.cancelled) return;
    this.transition("BOT_SPEAKING");
    this.botSpeakingStartMs = performance.now();
    await this.streamTtsToTwilio(text);
    this.botSpeakingEndMs = performance.now();
    logger.info(
      { call_id: this.session.callSid, reason, turn_id: this.turnId },
      "call_session_ending",
    );
    this.endCall(reason);
  }

  private async streamTtsToTwilio(text: string): Promise<void> {
    const wav = await generateSpeech(text, agentConfig);
    if (!wav || wav.length <= 44) {
      logger.warn(
        { call_id: this.session.callSid, textPreview: text.slice(0, 60) },
        "call_session_tts_empty",
      );
      return;
    }
    // Strip 44-byte RIFF/WAVE header → raw PCM s16le 8 kHz mono.
    const pcm = wav.subarray(44);
    const mulaw = pcm16ToMuLaw(pcm);

    // Send 20 ms frames paced at real-time. We keep a tiny lead buffer (3
    // frames) so brief event-loop hiccups don't produce audible gaps; Twilio
    // tolerates small bursts.
    const totalFrames = Math.ceil(mulaw.length / FRAME_BYTES);
    let sent = 0;
    const startedAt = performance.now();
    while (sent < totalFrames) {
      if (this.cancelled || this.ttsStopRequested) return;
      const offset = sent * FRAME_BYTES;
      const slice = mulaw.subarray(offset, Math.min(offset + FRAME_BYTES, mulaw.length));
      this.session.sendAudio(slice);
      sent++;
      const targetMs = sent * FRAME_INTERVAL_MS;
      const elapsedMs = performance.now() - startedAt;
      const drift = targetMs - elapsedMs;
      if (drift > 1) {
        await new Promise<void>((r) => setTimeout(r, drift));
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
