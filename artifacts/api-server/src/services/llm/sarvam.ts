import { logger } from "../../lib/logger.js";
import { stripThinking } from "../sarvam.service.js";
import type {
  LlmChatRequest,
  LlmChatResponse,
  LlmProvider,
  LlmTestResult,
} from "./types.js";

const CHAT_URL = "https://api.sarvam.ai/v1/chat/completions";
const DEFAULT_MODEL = "sarvam-m";

export const sarvamLlmProvider: LlmProvider = {
  id: "sarvam",
  label: "Sarvam AI",
  defaultModel: DEFAULT_MODEL,

  async chat(req: LlmChatRequest, apiKey: string, model?: string): Promise<LlmChatResponse> {
    const useModel = model || DEFAULT_MODEL;
    if (!apiKey) {
      return emptyResp(useModel, "missing_api_key");
    }
    const timeoutMs = req.timeoutMs ?? 12000;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    const t0 = Date.now();
    try {
      const response = await fetch(CHAT_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "api-subscription-key": apiKey,
        },
        body: JSON.stringify({
          model: useModel,
          messages: [...req.messages, { role: "user", content: req.userInput }],
          temperature: req.temperature ?? 0.3,
          presence_penalty: 0.6,
          max_tokens: req.maxTokens,
          chat_template_kwargs: { enable_thinking: false },
        }),
        signal: ac.signal,
      });
      const latencyMs = Date.now() - t0;
      if (!response.ok) {
        const err = await response.text().catch(() => "");
        logger.warn({ model: useModel, status: response.status, err: err.slice(0, 200) }, "llm_sarvam_http_error");
        return emptyResp(useModel, `http_${response.status}`, latencyMs);
      }
      const data = (await response.json()) as {
        choices: Array<{ message: { content: string }; finish_reason?: string }>;
      };
      const raw = data.choices[0]?.message?.content ?? "";
      const cleaned = stripThinking(raw);
      const shouldEnd = cleaned.startsWith("[DONE]");
      const text = cleaned.replace(/^\[DONE\]\s*/i, "").trim();
      if (shouldEnd) {
        return {
          text: text || "Thank you for your time. Goodbye!",
          shouldEnd: true,
          latencyMs,
          firstTokenMs: null,
          providerId: "sarvam",
          model: useModel,
        };
      }
      if (!text) {
        return emptyResp(useModel, `empty_${data.choices[0]?.finish_reason ?? "unknown"}_raw${raw.length}`, latencyMs);
      }
      return { text, shouldEnd: false, latencyMs, firstTokenMs: null, providerId: "sarvam", model: useModel };
    } catch (err) {
      const latencyMs = Date.now() - t0;
      const aborted = (err as { name?: string } | null)?.name === "AbortError";
      const reason = aborted ? `timeout_${timeoutMs}ms` : "exception";
      logger.error({ err: (err as Error).message, model: useModel }, "llm_sarvam_exception");
      return emptyResp(useModel, reason, latencyMs);
    } finally {
      clearTimeout(timer);
    }
  },

  async test(apiKey: string, model?: string): Promise<LlmTestResult> {
    const useModel = model || DEFAULT_MODEL;
    if (!apiKey) return { ok: false, message: "Sarvam API key is required", latencyMs: 0 };
    const t0 = Date.now();
    try {
      const r = await fetch(CHAT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "api-subscription-key": apiKey },
        body: JSON.stringify({
          model: useModel,
          messages: [{ role: "user", content: "Reply with the single word: OK" }],
          max_tokens: 20,
          temperature: 0,
        }),
        signal: AbortSignal.timeout(10000),
      });
      const latencyMs = Date.now() - t0;
      if (!r.ok) {
        const body = await r.text().catch(() => "");
        return { ok: false, message: `Sarvam returned HTTP ${r.status}: ${body.slice(0, 160)}`, latencyMs };
      }
      return { ok: true, message: `Sarvam reachable (${useModel}) in ${latencyMs}ms`, latencyMs, modelEcho: useModel };
    } catch (err) {
      return { ok: false, message: `Sarvam test failed: ${(err as Error).message}`, latencyMs: Date.now() - t0 };
    }
  },
};

function emptyResp(model: string, reason: string, latencyMs = 0): LlmChatResponse {
  return { text: "", shouldEnd: false, latencyMs, firstTokenMs: null, providerId: "sarvam", model, failureReason: reason };
}
