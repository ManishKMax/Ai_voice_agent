import { logger } from "../lib/logger.js";
import { config } from "../config/index.js";

const SARVAM_WS_URL = "wss://api.sarvam.ai/v1/realtime";

export type SarvamMessage =
  | { type: "session.update"; session: Record<string, unknown> }
  | { type: "input_audio_buffer.append"; audio: string }
  | { type: "response.create" };

const SYSTEM_PROMPT = `You are a professional sales agent calling on behalf of a CRM company. 
Your goal is to:
1. Introduce yourself and explain the product briefly
2. Qualify the lead by asking about their current pain points with customer management
3. Detect their level of interest (high / medium / low)
4. If interested, propose scheduling a product demo
5. Be polite, concise, and conversational
6. If they are busy, offer to call back later
Speak clearly and naturally. Keep responses short and focused.`;

export function buildSarvamSessionConfig() {
  return {
    model: "sarvam-1",
    instructions: SYSTEM_PROMPT,
    voice: "meera",
    input_audio_format: "mulaw",
    output_audio_format: "mulaw",
    input_audio_transcription: { model: "sarvam-1" },
    turn_detection: {
      type: "server_vad",
      threshold: 0.5,
      silence_duration_ms: 800,
    },
  };
}

export async function analyzeTranscript(transcript: string): Promise<{
  interest: "high" | "medium" | "low";
  nextAction: "demo" | "follow_up" | "drop";
  summary: string;
}> {
  const url = "https://api.sarvam.ai/v1/chat/completions";
  const prompt = `You are a lead qualification analyst. Analyze the following sales call transcript and respond ONLY with valid JSON.

Transcript:
"""
${transcript}
"""

Respond with exactly this JSON format:
{
  "interest": "high" | "medium" | "low",
  "nextAction": "demo" | "follow_up" | "drop",
  "summary": "one sentence summary of the call outcome"
}`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.sarvam.apiKey}`,
      },
      body: JSON.stringify({
        model: "sarvam-1",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.1,
      }),
    });

    if (!response.ok) {
      throw new Error(`Sarvam API error: ${response.status}`);
    }

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
