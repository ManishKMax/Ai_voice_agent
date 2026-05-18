import { logger } from "../lib/logger.js";
import { config } from "../config/index.js";
import type { AgentConfig } from "../config/agent.config.js";
import { agentConfig } from "../config/agent.config.js";
import type { ConversationMessage } from "./conversation-state.js";
import { resolveLlm, type LlmProviderId } from "./llm/index.js";

const STT_URL = "https://api.sarvam.ai/speech-to-text";
const TTS_URL = "https://api.sarvam.ai/text-to-speech";
const CHAT_URL = "https://api.sarvam.ai/v1/chat/completions";
// Conversation model: `sarvam-m` is the only model fast enough for live
// telephony. Benchmarked May 2026 on the upgraded tier (account
// sk_b...9wLJ, context window 7192 tokens):
//   sarvam-m    : 1.5-2.4s reliable, emits <think> block (stripped below) ✅
//   sarvam-30b  : 1.3s best-case but extremely variable — 28s outliers and
//                 timeouts in a 5-run benchmark. Caller hangs up. ❌
//   sarvam-105b : 4.7s on tiny prompts, balloons with history. ❌
// sarvam-30b is fine for post-call analysis (no caller waiting), so keep
// it as the analysis default. Override via SARVAM_CHAT_MODEL / SARVAM_ANALYSIS_MODEL.
const CHAT_MODEL_CONVERSATION = process.env.SARVAM_CHAT_MODEL ?? "sarvam-m";
const CHAT_MODEL_ANALYSIS = process.env.SARVAM_ANALYSIS_MODEL ?? "sarvam-30b";
// Token budget for live conversation. sarvam-m emits a <think>...</think>
// block before the reply (200-1500 tokens depending on prompt complexity).
// 2000 leaves headroom for both think + reply on multi-turn Hindi-mixed
// contexts and stays well within the upgraded-tier 7192-token cap.
//
// History (do not regress):
//  - 1500 was too tight: observed `empty_length_raw####` with finish_reason
//    "length" on long calls (think alone consumed the budget).
//  - 2500 broke production: starter tier capped sarvam-m at 2048, every
//    request returned HTTP 400 → bot only said the soft filler. Even on the
//    upgraded tier, 2000 is the empirical sweet spot — larger budgets just
//    let the model think longer (= higher TTFA) without better replies.
//  - sarvam-30b's 384-token budget is irrelevant here: 30b is no longer
//    used as primary because of latency variance.
const CHAT_MAX_TOKENS_CONVERSATION = 2000;
// Cap how many prior turns we send to the LLM. Sarvam-30b latency grows
// roughly linearly with prompt length, so a 10-turn call would ship ~3x
// slower than turn 1 if we replayed everything. The system prompt is always
// kept; only the trailing user/assistant turns are sliced.
const CHAT_HISTORY_MAX_TURNS = 6;
const TTS_MODEL = "bulbul:v3";
const STT_MODEL = "saaras:v3";

function sarvamHeaders(): Record<string, string> {
  return { "api-subscription-key": config.sarvam.apiKey };
}

// Sarvam TTS hard limit is 500 chars per input. We trim to 480 to leave
// room for preprocessing expansion (numbers → words, etc.) and break at a
// sentence/clause boundary so speech doesn't cut mid-word.
const TTS_MAX_CHARS = 480;

// Sarvam-m (and 105b) are reasoning models that wrap their internal thought
// process in <think>...</think> tags inside `message.content`. There is no
// API switch to disable this (verified against /v1/chat/completions May 2026);
// we must strip the block before speaking the reply, or the agent literally
// reads its own reasoning aloud. Handles both closed and unclosed (truncated)
// think blocks.
export function stripThinking(text: string): string {
  let out = text.replace(/<think>[\s\S]*?<\/think>\s*/gi, "");
  // If the reply was truncated mid-thought (finish_reason=length), there's
  // an opening <think> with no closer — drop everything after it.
  const openIdx = out.search(/<think>/i);
  if (openIdx !== -1) out = out.slice(0, openIdx);
  return out.trim();
}

/**
 * Split a reply into TTS-sized chunks at sentence/clause boundaries so the
 * caller can pipeline synthesis and playback: synthesize chunk N+1 while
 * playing chunk N. Time-to-first-audio is then bounded by the *first*
 * chunk's TTS cost, not the whole reply's.
 *
 * Sarvam HTTP TTS does not stream the response body — it returns the full
 * WAV as base64 in JSON. Sentence chunking is therefore the realistic way
 * to get sub-second time-to-first-frame on multi-sentence replies.
 */
export function splitForTTS(text: string, maxChars = 200): string[] {
  const t = text.trim();
  if (!t) return [];
  if (t.length <= maxChars) return [t];

  // Split on sentence terminators (English + Hindi danda) and keep the
  // terminator with the preceding chunk for natural prosody.
  const parts = t
    .split(/(?<=[.!?।])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  // Re-pack: any single piece longer than maxChars gets split on commas/
  // semicolons; consecutive short pieces get glued so we don't ship a flood
  // of 5-char chunks.
  const out: string[] = [];
  let buf = "";
  for (const p of parts) {
    if (p.length > maxChars) {
      if (buf) { out.push(buf); buf = ""; }
      // Hard-cut a string at maxChars boundaries, preferring the last
      // whitespace inside the window so we don't slice mid-word. This is
      // the true safety net — without it, oversized chunks reach
      // generateSpeech() and get silently truncated to 480 chars, dropping
      // the tail of the reply.
      const flush = (s: string): void => {
        let rest = s.trim();
        while (rest.length > maxChars) {
          const slice = rest.slice(0, maxChars);
          const lastSpace = slice.lastIndexOf(" ");
          const cut = lastSpace > maxChars * 0.5 ? lastSpace : maxChars;
          out.push(rest.slice(0, cut).trim());
          rest = rest.slice(cut).trim();
        }
        if (rest) out.push(rest);
      };
      // Split a runaway piece at clause boundaries first, then route every
      // emission through `flush()` so a single oversized clause (or an
      // accumulated `inner` that grew past maxChars before the next break)
      // still gets hard-cut to bounded chunks.
      const sub = p.match(/[^,;]+[,;]?\s*/g) ?? [p];
      let inner = "";
      for (const s of sub) {
        if ((inner + s).length > maxChars && inner) {
          flush(inner);
          inner = s;
        } else {
          inner += s;
        }
      }
      if (inner.trim()) flush(inner);
      continue;
    }
    if ((buf + " " + p).trim().length > maxChars) {
      if (buf) out.push(buf);
      buf = p;
    } else {
      buf = buf ? `${buf} ${p}` : p;
    }
  }
  if (buf) out.push(buf);
  return out;
}

export function truncateForTTS(text: string, maxChars = TTS_MAX_CHARS): string {
  const t = text.trim();
  if (t.length <= maxChars) return t;
  const slice = t.slice(0, maxChars);
  // Prefer cutting at sentence end, then comma/semicolon, then last space.
  const sentenceEnd = Math.max(
    slice.lastIndexOf(". "),
    slice.lastIndexOf("! "),
    slice.lastIndexOf("? "),
    slice.lastIndexOf("। "),
  );
  if (sentenceEnd > maxChars * 0.5) return slice.slice(0, sentenceEnd + 1).trim();
  const clauseEnd = Math.max(slice.lastIndexOf(", "), slice.lastIndexOf("; "));
  if (clauseEnd > maxChars * 0.6) return slice.slice(0, clauseEnd + 1).trim();
  const lastSpace = slice.lastIndexOf(" ");
  if (lastSpace > 0) return slice.slice(0, lastSpace).trim();
  return slice.trim();
}

/**
 * Generate agent speech audio using Sarvam Bulbul v3 TTS.
 * Returns a WAV audio Buffer, or null on failure.
 */
export async function generateSpeech(
  text: string,
  cfg: AgentConfig
): Promise<Buffer | null> {
  if (!config.sarvam.apiKey) {
    logger.warn("SARVAM_API_KEY not set — skipping TTS");
    return null;
  }

  // Sarvam TTS rejects inputs > 500 chars with HTTP 400. Hard-truncate
  // before sending — long AI replies should never break the call.
  const safeText = truncateForTTS(text);
  if (safeText.length < text.length) {
    logger.warn(
      { originalLength: text.length, truncatedLength: safeText.length },
      "TTS input truncated to fit Sarvam 500-char limit",
    );
  }

  try {
    const response = await fetch(TTS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...sarvamHeaders(),
      },
      body: JSON.stringify({
        // Sarvam deprecated the `inputs: [string]` array form (May 2026) in
        // favour of a single `text` string. Old form still works but logs a
        // deprecation warning on every call — use the new field.
        text: safeText,
        target_language_code: cfg.language,
        speaker: cfg.voice,
        model: TTS_MODEL,
        enable_preprocessing: true,
        target_sample_rate_hz: 8000,  // 8kHz WAV — standard telephony, compatible with Twilio <Play>
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      logger.error({ status: response.status, err }, "Sarvam TTS request failed");
      return null;
    }

    const data = (await response.json()) as { audios?: string[] };
    const audioBase64 = data.audios?.[0];
    if (!audioBase64) {
      logger.error({ data }, "Sarvam TTS returned no audio");
      return null;
    }

    return Buffer.from(audioBase64, "base64");
  } catch (err) {
    logger.error({ err }, "Sarvam TTS exception");
    return null;
  }
}

/**
 * Generate the agent's next conversational response using Sarvam Chat (sarvam-105b).
 * Returns { text, shouldEnd } where shouldEnd is true if the agent sent [DONE].
 */
export interface ChatResult {
  text: string;
  shouldEnd: boolean;
  /** Wall-clock ms spent in the chat call (sum across primary + fallback). */
  chatMs: number;
  /** Model that produced the returned text (or the last model attempted). */
  chatModel: string;
  /** LLM provider that produced the returned text. */
  chatProvider: LlmProviderId;
  /** Completion tokens returned by the provider, when available. Used for tokens/sec metric. */
  completionTokens?: number;
}

export interface GenerateConversationOptions {
  /**
   * Per-call override that takes precedence over the configured provider.
   * Used by the in-browser simulator (Task #31) to A/B test providers without
   * mutating global settings. Unknown ids fall back to the configured provider.
   */
  llmProviderOverride?: LlmProviderId | string;
}

/**
 * Orchestrate one conversational turn. Resolves the active LLM provider
 * (override → agent_settings.llmProviderId → "sarvam"), trims history,
 * and falls back to Sarvam if the primary provider returns empty.
 */
export async function generateConversationResponse(
  messages: ConversationMessage[],
  userInput: string,
  options: GenerateConversationOptions = {},
): Promise<ChatResult> {
  // Cap prompt size: keep the system message (always at index 0) plus the
  // last N user/assistant turns. Prevents per-turn LLM latency from growing
  // unboundedly as the conversation goes on.
  const systemMsg = messages[0]?.role === "system" ? [messages[0]] : [];
  const tail = messages
    .slice(systemMsg.length)
    .slice(-CHAT_HISTORY_MAX_TURNS * 2); // user+assistant per turn
  const historyMessages = [...systemMsg, ...tail];

  const resolved = resolveLlm({
    override: options.llmProviderOverride,
    configuredId: agentConfig.llmProviderId,
    credentials: agentConfig.llmCredentials,
    sarvamFallbackKey: config.sarvam.apiKey,
  });

  // No key for the chosen non-Sarvam provider — fall back to Sarvam
  // immediately rather than hanging up the call. Only if Sarvam itself has
  // no key (misconfigured platform) do we end politely.
  if (!resolved.apiKey) {
    if (resolved.provider.id !== "sarvam" && config.sarvam.apiKey) {
      logger.warn(
        { configuredProvider: resolved.provider.id },
        "primary_llm_no_key_falling_back_to_sarvam",
      );
      const sarvam = resolveLlm({
        configuredId: "sarvam",
        credentials: agentConfig.llmCredentials,
        sarvamFallbackKey: config.sarvam.apiKey,
      });
      const fb = await sarvam.provider.chat(
        { messages: historyMessages, userInput, maxTokens: CHAT_MAX_TOKENS_CONVERSATION, temperature: 0.3 },
        sarvam.apiKey,
        sarvam.model,
      );
      if (fb.text) {
        return {
          text: fb.text,
          shouldEnd: fb.shouldEnd,
          chatMs: fb.latencyMs,
          chatModel: fb.model,
          chatProvider: fb.providerId,
          completionTokens: fb.usage?.completionTokens,
        };
      }
    }
    return {
      text: "Thank you for your time. Goodbye!",
      shouldEnd: true,
      chatMs: 0,
      chatModel: resolved.provider.defaultModel,
      chatProvider: resolved.provider.id,
    };
  }

  const primary = await resolved.provider.chat(
    {
      messages: historyMessages,
      userInput,
      maxTokens: CHAT_MAX_TOKENS_CONVERSATION,
      temperature: 0.3,
    },
    resolved.apiKey,
    resolved.model,
  );

  if (primary.text) {
    return {
      text: primary.text,
      shouldEnd: primary.shouldEnd,
      chatMs: primary.latencyMs,
      chatModel: primary.model,
      chatProvider: primary.providerId,
      completionTokens: primary.usage?.completionTokens,
    };
  }

  // Cross-provider fallback: if the configured provider returned empty and
  // it wasn't already Sarvam, try Sarvam once as a safety net. Live voice
  // can't afford a dead reply.
  if (resolved.provider.id !== "sarvam" && config.sarvam.apiKey) {
    logger.warn(
      { primaryProvider: resolved.provider.id, primaryReason: primary.failureReason },
      "primary_llm_empty_falling_back_to_sarvam",
    );
    const sarvam = resolveLlm({
      configuredId: "sarvam",
      credentials: agentConfig.llmCredentials,
      sarvamFallbackKey: config.sarvam.apiKey,
    });
    const fb = await sarvam.provider.chat(
      { messages: historyMessages, userInput, maxTokens: CHAT_MAX_TOKENS_CONVERSATION, temperature: 0.3 },
      sarvam.apiKey,
      sarvam.model,
    );
    if (fb.text) {
      return {
        text: fb.text,
        shouldEnd: fb.shouldEnd,
        chatMs: primary.latencyMs + fb.latencyMs,
        chatModel: fb.model,
        chatProvider: fb.providerId,
        completionTokens: fb.usage?.completionTokens,
      };
    }
  }

  logger.warn(
    { provider: resolved.provider.id, primaryReason: primary.failureReason },
    "llm_returned_empty_soft_retry_filler",
  );
  return {
    text: "Sorry, ek second — kya aap dohra sakte hain?",
    shouldEnd: false,
    chatMs: primary.latencyMs,
    chatModel: primary.model,
    chatProvider: primary.providerId,
  };
}


/**
 * Transcribe a WAV/MP3 audio buffer using Sarvam Saaras v3 STT.
 * Returns the transcript string or empty string on failure.
 */
export async function transcribeAudio(
  audioBuffer: Buffer,
  languageCode: string,
  mimeType = "audio/wav"
): Promise<string> {
  if (!config.sarvam.apiKey) return "";

  try {
    const formData = new FormData();
    const blob = new Blob([Uint8Array.from(audioBuffer)], { type: mimeType });
    formData.append("file", blob, "audio.wav");
    formData.append("model", STT_MODEL);
    formData.append("language_code", languageCode);
    formData.append("mode", "transcribe");

    const response = await fetch(STT_URL, {
      method: "POST",
      headers: sarvamHeaders(),
      body: formData,
    });

    if (!response.ok) {
      const err = await response.text();
      logger.error({ status: response.status, err }, "Sarvam STT request failed");
      return "";
    }

    const data = (await response.json()) as { transcript?: string };
    return data.transcript ?? "";
  } catch (err) {
    logger.error({ err }, "Sarvam STT exception");
    return "";
  }
}

export interface TranscriptQuality {
  /** True when the transcript has enough signal to trust an LLM classification. */
  hasEnoughSignal: boolean;
  userUtteranceCount: number;
  qualifyingUtteranceCount: number;
  totalUserWords: number;
  reason: string;
}

/**
 * Inspect the conversation transcript (format: alternating "Lead: ...\nAgent: ...\n"
 * lines emitted by `conversation-state.addTurn`) and decide whether the lead
 * gave us enough to classify them. Calls dominated by filler ("Yes.", "Hmm.",
 * "OK") routinely flipped leads to "interested" before this gate existed
 * because the Sarvam analyser will always return SOMETHING — even a JSON
 * default when fed a near-empty input.
 *
 * Threshold: ≥ 2 user utterances of ≥ 3 words each, OR cumulative ≥ 10 words.
 */
export function assessTranscriptQuality(transcript: string): TranscriptQuality {
  const userLines = transcript
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("Lead:"))
    .map((l) => l.slice("Lead:".length).trim())
    .filter((l) => l.length > 0);
  const userWordsByUtt = userLines.map((u) => u.split(/\s+/).filter(Boolean).length);
  const totalUserWords = userWordsByUtt.reduce((a, b) => a + b, 0);
  const qualifying = userWordsByUtt.filter((w) => w >= 3).length;
  // BOTH thresholds must be satisfied to permit LLM classification. A single
  // long utterance (10+ words) without a second confirming reply is still
  // low information — the LLM otherwise happily over-classifies it as
  // "interested" and we send a wasted demo invite. Symmetrically, two short
  // "yes/ok" replies aren't enough either. Refuse when EITHER fails.
  const hasEnoughSignal = qualifying >= 2 && totalUserWords >= 10;
  const reason = hasEnoughSignal
    ? "ok"
    : `low_information: ${userLines.length} user utterances, ${qualifying} ≥3-word, ${totalUserWords} total words`;
  return {
    hasEnoughSignal,
    userUtteranceCount: userLines.length,
    qualifyingUtteranceCount: qualifying,
    totalUserWords,
    reason,
  };
}

/**
 * Analyse a completed call transcript and classify the lead.
 *
 * Two safeguards layered on top of the raw Sarvam call:
 *   1. Pre-LLM quality gate (assessTranscriptQuality) — refuses to classify
 *      low-information calls instead of letting the analyser hallucinate
 *      "interested" off a single "Yes."
 *   2. Per-model fallback — sarvam-30b is the default analyser but is the
 *      same model that's been observed returning intermittent 4xx/5xx; on
 *      any non-2xx, retry once with sarvam-m before giving up. This costs
 *      one extra HTTP call ONLY on actual analyser failure (never on the
 *      hot voice path).
 */
export async function analyzeTranscript(transcript: string): Promise<{
  interest: "high" | "medium" | "low";
  nextAction: "demo" | "follow_up" | "drop";
  summary: string;
  lowInformation?: boolean;
}> {
  const quality = assessTranscriptQuality(transcript);
  if (!quality.hasEnoughSignal) {
    logger.info(
      { quality },
      "analyzeTranscript_low_information_skipping_llm",
    );
    return {
      interest: "low",
      nextAction: "follow_up",
      summary: `Low-information call: ${quality.userUtteranceCount} user utterance(s), ${quality.totalUserWords} total words. Manual review recommended.`,
      lowInformation: true,
    };
  }

  const prompt = `You are a lead qualification analyst. Analyse this sales call transcript and respond ONLY with valid JSON.

Transcript:
"""
${transcript}
"""

Respond with exactly this JSON (no markdown, no extra text):
{"interest":"high"|"medium"|"low","nextAction":"demo"|"follow_up"|"drop","summary":"one sentence summary"}`;

  const tryModel = async (model: string): Promise<{
    interest: "high" | "medium" | "low";
    nextAction: "demo" | "follow_up" | "drop";
    summary: string;
  } | { httpError: number } | { exception: string }> => {
    try {
      const response = await fetch(CHAT_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "api-subscription-key": config.sarvam.apiKey,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: prompt }],
          temperature: 0.1,
          max_tokens: 2000,
        }),
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        logger.warn({ model, status: response.status, body: body.slice(0, 200) }, "analyzeTranscript_http_error");
        return { httpError: response.status };
      }
      const data = (await response.json()) as { choices: Array<{ message: { content: string } }> };
      const content = data.choices[0]?.message?.content ?? "{}";
      const cleaned = stripThinking(content).replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(cleaned || "{}");
      return {
        interest: parsed.interest ?? "low",
        nextAction: parsed.nextAction ?? "drop",
        summary: parsed.summary ?? "",
      };
    } catch (err) {
      return { exception: (err as Error).message };
    }
  };

  const primary = await tryModel(CHAT_MODEL_ANALYSIS);
  if ("interest" in primary) return primary;

  // Fallback to sarvam-m on any 4xx/5xx or exception. sarvam-m is the
  // primary live-conversation model — proven reliable, just slower for
  // post-call reasoning. One extra HTTP call only on analyser failure.
  if (CHAT_MODEL_ANALYSIS !== "sarvam-m") {
    logger.warn({ primary, fallback: "sarvam-m" }, "analyzeTranscript_falling_back_to_sarvam_m");
    const fallback = await tryModel("sarvam-m");
    if ("interest" in fallback) return fallback;
    logger.error({ primary, fallback }, "analyzeTranscript both models failed");
  } else {
    logger.error({ primary }, "analyzeTranscript_failed_no_fallback");
  }
  return { interest: "low", nextAction: "drop", summary: "Analysis failed" };
}
