import { logger } from "../../lib/logger.js";
import type {
  LlmChatRequest,
  LlmChatResponse,
  LlmProvider,
  LlmProviderId,
  LlmTestResult,
} from "./types.js";

/**
 * Shared implementation for OpenAI-compatible chat APIs (OpenAI, Groq).
 * Both expose `POST {baseUrl}/chat/completions` with a Bearer token and the
 * same request/response shape.
 */
function makeOpenAiCompatibleProvider(args: {
  id: LlmProviderId;
  label: string;
  defaultModel: string;
  baseUrl: string;
}): LlmProvider {
  const { id, label, defaultModel, baseUrl } = args;
  const chatUrl = `${baseUrl}/chat/completions`;

  return {
    id,
    label,
    defaultModel,
    async chat(req: LlmChatRequest, apiKey: string, model?: string): Promise<LlmChatResponse> {
      const useModel = model || defaultModel;
      if (!apiKey) {
        return { text: "", shouldEnd: false, latencyMs: 0, firstTokenMs: null, providerId: id, model: useModel, failureReason: "missing_api_key" };
      }
      const timeoutMs = req.timeoutMs ?? 12000;
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      const t0 = Date.now();
      try {
        const response = await fetch(chatUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: useModel,
            messages: [...req.messages, { role: "user", content: req.userInput }],
            temperature: req.temperature ?? 0.3,
            max_tokens: req.maxTokens,
          }),
          signal: ac.signal,
        });
        const latencyMs = Date.now() - t0;
        if (!response.ok) {
          const err = await response.text().catch(() => "");
          logger.warn({ provider: id, model: useModel, status: response.status, err: err.slice(0, 200) }, "llm_openai_compat_http_error");
          return { text: "", shouldEnd: false, latencyMs, firstTokenMs: null, providerId: id, model: useModel, failureReason: `http_${response.status}` };
        }
        const data = (await response.json()) as {
          choices: Array<{ message: { content: string }; finish_reason?: string }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        const raw = (data.choices[0]?.message?.content ?? "").trim();
        const shouldEnd = raw.startsWith("[DONE]");
        const text = raw.replace(/^\[DONE\]\s*/i, "").trim();
        if (shouldEnd) {
          return {
            text: text || "Thank you for your time. Goodbye!",
            shouldEnd: true, latencyMs, firstTokenMs: null, providerId: id, model: useModel,
            usage: { promptTokens: data.usage?.prompt_tokens, completionTokens: data.usage?.completion_tokens },
          };
        }
        if (!text) {
          return { text: "", shouldEnd: false, latencyMs, firstTokenMs: null, providerId: id, model: useModel, failureReason: `empty_${data.choices[0]?.finish_reason ?? "unknown"}` };
        }
        return {
          text, shouldEnd: false, latencyMs, firstTokenMs: null, providerId: id, model: useModel,
          usage: { promptTokens: data.usage?.prompt_tokens, completionTokens: data.usage?.completion_tokens },
        };
      } catch (err) {
        const latencyMs = Date.now() - t0;
        const aborted = (err as { name?: string } | null)?.name === "AbortError";
        const reason = aborted ? `timeout_${timeoutMs}ms` : "exception";
        logger.error({ provider: id, err: (err as Error).message, model: useModel }, "llm_openai_compat_exception");
        return { text: "", shouldEnd: false, latencyMs, firstTokenMs: null, providerId: id, model: useModel, failureReason: reason };
      } finally {
        clearTimeout(timer);
      }
    },

    async test(apiKey: string, model?: string): Promise<LlmTestResult> {
      const useModel = model || defaultModel;
      if (!apiKey) return { ok: false, message: `${label} API key is required`, latencyMs: 0 };
      const t0 = Date.now();
      try {
        const r = await fetch(chatUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
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
          return { ok: false, message: `${label} returned HTTP ${r.status}: ${body.slice(0, 160)}`, latencyMs };
        }
        return { ok: true, message: `${label} reachable (${useModel}) in ${latencyMs}ms`, latencyMs, modelEcho: useModel };
      } catch (err) {
        return { ok: false, message: `${label} test failed: ${(err as Error).message}`, latencyMs: Date.now() - t0 };
      }
    },
  };
}

export const openaiLlmProvider: LlmProvider = makeOpenAiCompatibleProvider({
  id: "openai",
  label: "OpenAI",
  defaultModel: "gpt-4o-mini",
  baseUrl: "https://api.openai.com/v1",
});

export const groqLlmProvider: LlmProvider = makeOpenAiCompatibleProvider({
  id: "groq",
  label: "Groq",
  defaultModel: "llama-3.3-70b-versatile",
  baseUrl: "https://api.groq.com/openai/v1",
});
