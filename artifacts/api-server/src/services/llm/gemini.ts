import { logger } from "../../lib/logger.js";
import type {
  LlmChatRequest,
  LlmChatResponse,
  LlmProvider,
  LlmTestResult,
} from "./types.js";

const DEFAULT_MODEL = "gemini-2.0-flash";
const BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";

interface GeminiContent {
  role: "user" | "model";
  parts: Array<{ text: string }>;
}

/**
 * Convert OpenAI-style chat messages into Gemini's `contents` array.
 * Gemini does not have a "system" role — we prepend the system message text
 * to the first user turn instead, which is the documented workaround.
 */
function toGeminiContents(messages: Array<{ role: string; content: string }>, userInput: string): {
  systemInstruction?: { parts: Array<{ text: string }> };
  contents: GeminiContent[];
} {
  let systemInstruction: { parts: Array<{ text: string }> } | undefined;
  const contents: GeminiContent[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      systemInstruction = { parts: [{ text: m.content }] };
      continue;
    }
    contents.push({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    });
  }
  contents.push({ role: "user", parts: [{ text: userInput }] });
  return { systemInstruction, contents };
}

export const geminiLlmProvider: LlmProvider = {
  id: "gemini",
  label: "Google Gemini",
  defaultModel: DEFAULT_MODEL,

  async chat(req: LlmChatRequest, apiKey: string, model?: string): Promise<LlmChatResponse> {
    const useModel = model || DEFAULT_MODEL;
    if (!apiKey) {
      return { text: "", shouldEnd: false, latencyMs: 0, firstTokenMs: null, providerId: "gemini", model: useModel, failureReason: "missing_api_key" };
    }
    const timeoutMs = req.timeoutMs ?? 12000;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    const t0 = Date.now();
    try {
      const { systemInstruction, contents } = toGeminiContents(req.messages, req.userInput);
      const url = `${BASE_URL}/${encodeURIComponent(useModel)}:generateContent?key=${encodeURIComponent(apiKey)}`;
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents,
          ...(systemInstruction ? { systemInstruction } : {}),
          generationConfig: {
            temperature: req.temperature ?? 0.3,
            maxOutputTokens: req.maxTokens,
          },
        }),
        signal: ac.signal,
      });
      const latencyMs = Date.now() - t0;
      if (!response.ok) {
        const err = await response.text().catch(() => "");
        logger.warn({ model: useModel, status: response.status, err: err.slice(0, 200) }, "llm_gemini_http_error");
        return { text: "", shouldEnd: false, latencyMs, firstTokenMs: null, providerId: "gemini", model: useModel, failureReason: `http_${response.status}` };
      }
      const data = (await response.json()) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
        usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
      };
      const raw = (data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "").trim();
      const shouldEnd = raw.startsWith("[DONE]");
      const text = raw.replace(/^\[DONE\]\s*/i, "").trim();
      if (shouldEnd) {
        return {
          text: text || "Thank you for your time. Goodbye!",
          shouldEnd: true, latencyMs, firstTokenMs: null, providerId: "gemini", model: useModel,
          usage: { promptTokens: data.usageMetadata?.promptTokenCount, completionTokens: data.usageMetadata?.candidatesTokenCount },
        };
      }
      if (!text) {
        return { text: "", shouldEnd: false, latencyMs, firstTokenMs: null, providerId: "gemini", model: useModel, failureReason: `empty_${data.candidates?.[0]?.finishReason ?? "unknown"}` };
      }
      return {
        text, shouldEnd: false, latencyMs, firstTokenMs: null, providerId: "gemini", model: useModel,
        usage: { promptTokens: data.usageMetadata?.promptTokenCount, completionTokens: data.usageMetadata?.candidatesTokenCount },
      };
    } catch (err) {
      const latencyMs = Date.now() - t0;
      const aborted = (err as { name?: string } | null)?.name === "AbortError";
      const reason = aborted ? `timeout_${timeoutMs}ms` : "exception";
      logger.error({ err: (err as Error).message, model: useModel }, "llm_gemini_exception");
      return { text: "", shouldEnd: false, latencyMs, firstTokenMs: null, providerId: "gemini", model: useModel, failureReason: reason };
    } finally {
      clearTimeout(timer);
    }
  },

  async test(apiKey: string, model?: string): Promise<LlmTestResult> {
    const useModel = model || DEFAULT_MODEL;
    if (!apiKey) return { ok: false, message: "Gemini API key is required", latencyMs: 0 };
    const t0 = Date.now();
    try {
      const url = `${BASE_URL}/${encodeURIComponent(useModel)}:generateContent?key=${encodeURIComponent(apiKey)}`;
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "Reply with the single word: OK" }] }],
          generationConfig: { temperature: 0, maxOutputTokens: 20 },
        }),
        signal: AbortSignal.timeout(10000),
      });
      const latencyMs = Date.now() - t0;
      if (!r.ok) {
        const body = await r.text().catch(() => "");
        return { ok: false, message: `Gemini returned HTTP ${r.status}: ${body.slice(0, 160)}`, latencyMs };
      }
      return { ok: true, message: `Gemini reachable (${useModel}) in ${latencyMs}ms`, latencyMs, modelEcho: useModel };
    } catch (err) {
      return { ok: false, message: `Gemini test failed: ${(err as Error).message}`, latencyMs: Date.now() - t0 };
    }
  },
};
