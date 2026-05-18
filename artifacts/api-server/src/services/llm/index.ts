import { logger } from "../../lib/logger.js";
import { sarvamLlmProvider } from "./sarvam.js";
import { openaiLlmProvider, groqLlmProvider } from "./openai-compatible.js";
import { geminiLlmProvider } from "./gemini.js";
import type { LlmProvider, LlmProviderId } from "./types.js";

export type { LlmProvider, LlmProviderId } from "./types.js";
export type { LlmChatRequest, LlmChatResponse, LlmTestResult } from "./types.js";

export const LLM_PROVIDERS: Record<LlmProviderId, LlmProvider> = {
  sarvam: sarvamLlmProvider,
  openai: openaiLlmProvider,
  groq: groqLlmProvider,
  gemini: geminiLlmProvider,
};

export const LLM_PROVIDER_ORDER: LlmProviderId[] = ["sarvam", "groq", "openai", "gemini"];

export function getLlmProvider(id: LlmProviderId | string | undefined): LlmProvider {
  if (id && id in LLM_PROVIDERS) return LLM_PROVIDERS[id as LlmProviderId];
  return sarvamLlmProvider;
}

export function isLlmProviderId(v: string | undefined): v is LlmProviderId {
  return !!v && v in LLM_PROVIDERS;
}

/**
 * Resolve which LLM provider should handle the given turn. Order:
 *   1. explicit per-call override (e.g. simulator)
 *   2. agent_settings.llmProviderId (set via Settings UI)
 *   3. "sarvam" default
 *
 * Returns the provider plus the api key / model from the matching credentials
 * slot. The Sarvam slot falls back to `platformSettings.sarvamApiKey` for
 * backward compatibility with the existing Sarvam-only flow.
 */
export interface ResolvedLlm {
  provider: LlmProvider;
  apiKey: string;
  model: string | undefined;
  source: "override" | "config" | "default";
}

export function resolveLlm(args: {
  override?: string;
  configuredId?: LlmProviderId;
  credentials?: Partial<Record<LlmProviderId, { apiKey?: string; model?: string }>>;
  sarvamFallbackKey?: string;
}): ResolvedLlm {
  let chosenId: LlmProviderId;
  let source: ResolvedLlm["source"];
  if (isLlmProviderId(args.override)) {
    chosenId = args.override;
    source = "override";
  } else if (args.configuredId && args.configuredId in LLM_PROVIDERS) {
    chosenId = args.configuredId;
    source = "config";
  } else {
    chosenId = "sarvam";
    source = "default";
  }
  const provider = LLM_PROVIDERS[chosenId];
  const slot = args.credentials?.[chosenId] ?? {};
  let apiKey = slot.apiKey ?? "";
  if (chosenId === "sarvam" && !apiKey && args.sarvamFallbackKey) {
    apiKey = args.sarvamFallbackKey;
  }
  if (!apiKey) {
    logger.warn({ providerId: chosenId, source }, "llm_resolved_without_api_key");
  }
  return { provider, apiKey, model: slot.model, source };
}
