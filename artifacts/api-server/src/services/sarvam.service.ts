import { logger } from "../lib/logger.js";
import { config } from "../config/index.js";
import type { AgentConfig } from "../config/agent.config.js";
import type { ConversationMessage } from "./conversation-state.js";

const STT_URL = "https://api.sarvam.ai/speech-to-text";
const TTS_URL = "https://api.sarvam.ai/text-to-speech";
const CHAT_URL = "https://api.sarvam.ai/v1/chat/completions";
// Conversation model: default to `sarvam-m` — `sarvam-30b` was tried but
// in production it consistently consumes its 384-token budget on internal
// reasoning and returns empty content (`empty_length_raw0`), forcing a
// 45-60s fallback to sarvam-m anyway. Skip the wasted round-trip.
// Original (broken) note retained below for context:
// Conversation model: default to `sarvam-30b` — verified May 2026 to be the
// fastest *and* cleanest option for live voice:
//   sarvam-30b  : ~1.0s, NO <think> block, native Hinglish ✅
//   sarvam-m    : ~2.2s, always emits <think> (must strip), eats 200-500 tokens
//   sarvam-105b : ~50s, way too slow for live voice (still ok for analysis)
// Override with SARVAM_CHAT_MODEL.
const CHAT_MODEL_CONVERSATION = process.env.SARVAM_CHAT_MODEL ?? "sarvam-m";
// Analysis runs after the call ends so latency matters less, but sarvam-30b
// is also clean+fast for JSON, so default to it. Override via env.
const CHAT_MODEL_ANALYSIS = process.env.SARVAM_ANALYSIS_MODEL ?? "sarvam-30b";
// Token budgets per model — empirically tuned (May 2026):
//   sarvam-30b : 384 is the live-voice sweet spot. Replies in this flow are
//                1-3 sentences, so 384 ships sooner (model stops generating
//                earlier → TTS starts earlier). 1024 was the previous default
//                but gave the model headroom to ramble in multi-turn calls,
//                pushing per-turn LLM latency from ~1s to 2-3s by turn 4-5.
//                Lower than 256 silently fails on long system prompts.
//   sarvam-m / sarvam-105b: thinking models — 1500 leaves room to think AND
//                answer. <think> block alone eats 200-500 tokens.
const CHAT_MAX_TOKENS_CONVERSATION =
  CHAT_MODEL_CONVERSATION === "sarvam-30b" ? 384 : 1500;
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
export async function generateConversationResponse(
  messages: ConversationMessage[],
  userInput: string
): Promise<{ text: string; shouldEnd: boolean }> {
  if (!config.sarvam.apiKey) {
    return { text: "Thank you for your time. Goodbye!", shouldEnd: true };
  }

  // Cap prompt size: keep the system message (always at index 0) plus the
  // last N user/assistant turns. Prevents per-turn LLM latency from growing
  // unboundedly as the conversation goes on.
  const systemMsg = messages[0]?.role === "system" ? [messages[0]] : [];
  const tail = messages
    .slice(systemMsg.length)
    .slice(-CHAT_HISTORY_MAX_TURNS * 2); // user+assistant per turn
  const fullMessages = [
    ...systemMsg,
    ...tail,
    { role: "user" as const, content: userInput },
  ];

  // Try the fast primary model first, then fall back to sarvam-m if it returns
  // empty content. sarvam-30b is ~1s on short prompts but on long multi-turn
  // contexts it sometimes burns the entire token budget producing nothing —
  // sarvam-m is slower (~2-3s) but reliably emits content (with <think>).
  const primary = await callSarvamChat(
    CHAT_MODEL_CONVERSATION,
    fullMessages,
    CHAT_MAX_TOKENS_CONVERSATION,
  );
  if (primary.text) {
    return primary;
  }

  // Primary failed (empty/error). If we were already on sarvam-m there's
  // nothing better to try — return soft filler to keep call alive.
  if (CHAT_MODEL_CONVERSATION === "sarvam-m") {
    logger.warn(
      { primaryReason: primary.failureReason },
      "Primary chat returned empty — no fallback available, soft retry filler",
    );
    return { text: "Sorry, ek second — kya aap dohra sakte hain?", shouldEnd: false };
  }

  logger.warn(
    { primaryReason: primary.failureReason },
    "Primary chat (sarvam-30b) empty — falling back to sarvam-m",
  );
  const fallback = await callSarvamChat("sarvam-m", fullMessages, 1500);
  if (fallback.text) {
    return fallback;
  }

  logger.warn(
    { fallbackReason: fallback.failureReason },
    "Both primary and fallback chat returned empty — soft retry filler",
  );
  return { text: "Sorry, ek second — kya aap dohra sakte hain?", shouldEnd: false };
}

/**
 * Single Sarvam chat call. Returns text="" if the call failed or produced
 * empty content (after <think> stripping). Caller decides whether to retry.
 */
async function callSarvamChat(
  model: string,
  messages: ConversationMessage[],
  maxTokens: number,
): Promise<{ text: string; shouldEnd: boolean; failureReason?: string }> {
  // Hard per-request timeout: live voice cannot tolerate a hanging fetch.
  // Sarvam has been observed to stall 45-60s on `sarvam-30b` returning
  // empty content. Abort fast so the caller can fall back or recover.
  const timeoutMs = Number(process.env.SARVAM_CHAT_TIMEOUT_MS ?? 12000);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const response = await fetch(CHAT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-subscription-key": config.sarvam.apiKey!,
      },
      body: JSON.stringify({
        model,
        messages,
        // Live voice replies should be short, on-topic and predictable.
        // Lower temperature reduces rambling; presence_penalty discourages
        // repeating earlier phrases (a common failure mode on long calls).
        temperature: 0.3,
        presence_penalty: 0.6,
        max_tokens: maxTokens,
      }),
      signal: ac.signal,
    });

    if (!response.ok) {
      const err = await response.text();
      logger.error({ model, status: response.status, err }, "Sarvam chat request failed");
      return { text: "", shouldEnd: false, failureReason: `http_${response.status}` };
    }

    const data = (await response.json()) as {
      choices: Array<{
        message: { content: string };
        finish_reason?: string;
      }>;
    };

    const raw = data.choices[0]?.message?.content ?? "";
    // Strip <think>...</think> reasoning blocks — sarvam-m always emits them
    // and they must NEVER reach TTS.
    const cleaned = stripThinking(raw);
    const shouldEnd = cleaned.startsWith("[DONE]");
    const text = cleaned.replace(/^\[DONE\]\s*/i, "").trim();

    // Honour [DONE] even if the model forgot to include a farewell — it's
    // a valid termination signal, not a failure. Substitute a polite goodbye.
    if (shouldEnd) {
      return { text: text || "Thank you for your time. Goodbye!", shouldEnd: true };
    }

    if (!text) {
      return {
        text: "",
        shouldEnd: false,
        failureReason: `empty_${data.choices[0]?.finish_reason ?? "unknown"}_raw${raw.length}`,
      };
    }

    return { text, shouldEnd };
  } catch (err) {
    const aborted = (err as { name?: string } | null)?.name === "AbortError";
    if (aborted) {
      logger.warn({ model, timeoutMs }, "Sarvam chat timed out");
      return { text: "", shouldEnd: false, failureReason: `timeout_${timeoutMs}ms` };
    }
    logger.error({ err, model }, "Sarvam conversation response exception");
    return { text: "", shouldEnd: false, failureReason: "exception" };
  } finally {
    clearTimeout(timer);
  }
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

/**
 * Analyse a completed call transcript and classify the lead.
 */
export async function analyzeTranscript(transcript: string): Promise<{
  interest: "high" | "medium" | "low";
  nextAction: "demo" | "follow_up" | "drop";
  summary: string;
}> {
  const prompt = `You are a lead qualification analyst. Analyse this sales call transcript and respond ONLY with valid JSON.

Transcript:
"""
${transcript}
"""

Respond with exactly this JSON (no markdown, no extra text):
{"interest":"high"|"medium"|"low","nextAction":"demo"|"follow_up"|"drop","summary":"one sentence summary"}`;

  try {
    const response = await fetch(CHAT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-subscription-key": config.sarvam.apiKey,
      },
      body: JSON.stringify({
        model: CHAT_MODEL_ANALYSIS,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.1,
        max_tokens: 2000,
      }),
    });

    if (!response.ok) throw new Error(`Sarvam chat ${response.status}`);

    const data = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    const content = data.choices[0]?.message?.content ?? "{}";
    // Strip <think> blocks first (sarvam-105b emits them too) then code fences.
    const cleaned = stripThinking(content).replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(cleaned || "{}");

    return {
      interest: parsed.interest ?? "low",
      nextAction: parsed.nextAction ?? "drop",
      summary: parsed.summary ?? "",
    };
  } catch (err) {
    logger.error({ err }, "Sarvam transcript analysis failed");
    return { interest: "low", nextAction: "drop", summary: "Analysis failed" };
  }
}
