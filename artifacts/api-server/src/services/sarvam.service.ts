import { logger } from "../lib/logger.js";
import { config } from "../config/index.js";
import type { AgentConfig } from "../config/agent.config.js";
import type { ConversationMessage } from "./conversation-state.js";

const STT_URL = "https://api.sarvam.ai/speech-to-text";
const TTS_URL = "https://api.sarvam.ai/text-to-speech";
const CHAT_URL = "https://api.sarvam.ai/v1/chat/completions";
const CHAT_MODEL_CONVERSATION = "sarvam-105b";
const CHAT_MODEL_ANALYSIS = "sarvam-105b";
const TTS_MODEL = "bulbul:v3";
const STT_MODEL = "saaras:v3";

function sarvamHeaders(): Record<string, string> {
  return { "api-subscription-key": config.sarvam.apiKey };
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

  try {
    const response = await fetch(TTS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...sarvamHeaders(),
      },
      body: JSON.stringify({
        inputs: [text],
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
        Authorization: `Bearer ${config.sarvam.apiKey}`,
      },
      body: JSON.stringify({
        model: CHAT_MODEL_CONVERSATION,
        messages: fullMessages,
        temperature: 0.7,
        max_tokens: 2000,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      logger.error({ status: response.status, err }, "Sarvam chat request failed");
      return { text: "Thank you for your time. Goodbye!", shouldEnd: true };
    }

    const data = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
    };

    const raw = data.choices[0]?.message?.content?.trim() ?? "";
    const shouldEnd = raw.startsWith("[DONE]");
    const text = raw.replace(/^\[DONE\]\s*/i, "").trim();

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
        Authorization: `Bearer ${config.sarvam.apiKey}`,
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
    const parsed = JSON.parse(content.replace(/```json|```/g, "").trim());

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
