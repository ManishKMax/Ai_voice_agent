import { logger } from "../lib/logger.js";
import { config } from "../config/index.js";
import type { AgentConfig } from "../config/agent.config.js";
import type { ConversationMessage } from "./conversation-state.js";

const STT_URL = "https://api.sarvam.ai/speech-to-text";
const TTS_URL = "https://api.sarvam.ai/text-to-speech";
const CHAT_URL = "https://api.sarvam.ai/v1/chat/completions";
// Conversation model: default to `sarvam-m` (24B, no thinking, ~1-2s response).
// `sarvam-105b` is a thinking model that takes 8-14s per turn — too slow for
// real-time voice. Override with SARVAM_CHAT_MODEL if you want to experiment.
const CHAT_MODEL_CONVERSATION = process.env.SARVAM_CHAT_MODEL ?? "sarvam-m";
// Analysis runs after the call ends, so latency is fine — keep the smarter model.
const CHAT_MODEL_ANALYSIS = process.env.SARVAM_ANALYSIS_MODEL ?? "sarvam-105b";
// Both `sarvam-m` and `sarvam-105b` are reasoning models that emit a
// <think>...</think> block before the actual reply (verified May 2026 — no
// API switch can disable it). The thinking block alone commonly consumes
// 200-500 tokens, so 300 max_tokens leaves nothing for the spoken reply
// (finish_reason=length, content stuck inside <think>). 1500 gives the model
// room to think *and* answer; we still strip the <think> block via
// stripThinking() and truncate to 480 chars before TTS.
const CHAT_MAX_TOKENS_CONVERSATION = 1500;
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

  const fullMessages = [
    ...messages,
    { role: "user" as const, content: userInput },
  ];

  try {
    const response = await fetch(CHAT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-subscription-key": config.sarvam.apiKey,
      },
      body: JSON.stringify({
        model: CHAT_MODEL_CONVERSATION,
        messages: fullMessages,
        temperature: 0.7,
        max_tokens: CHAT_MAX_TOKENS_CONVERSATION,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      logger.error({ status: response.status, err }, "Sarvam chat request failed");
      return { text: "Thank you for your time. Goodbye!", shouldEnd: true };
    }

    const data = (await response.json()) as {
      choices: Array<{
        message: { content: string };
        finish_reason?: string;
      }>;
    };

    const raw = data.choices[0]?.message?.content ?? "";
    // Strip <think>...</think> reasoning blocks before doing anything else —
    // sarvam-m always emits them and they must NEVER reach TTS.
    const cleaned = stripThinking(raw);
    const shouldEnd = cleaned.startsWith("[DONE]");
    const text = cleaned.replace(/^\[DONE\]\s*/i, "").trim();

    if (!text) {
      logger.warn(
        {
          rawLength: raw.length,
          finishReason: data.choices[0]?.finish_reason,
          rawPreview: raw.slice(0, 200),
        },
        "Sarvam chat returned empty content after stripping <think> — falling back to goodbye",
      );
    }

    return { text: text || "Thank you for your time. Goodbye!", shouldEnd };
  } catch (err) {
    logger.error({ err }, "Sarvam conversation response exception");
    return { text: "Thank you for your time. Goodbye!", shouldEnd: true };
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
