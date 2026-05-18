import type { ConversationMessage } from "../conversation-state.js";
import type { LlmProviderId } from "@workspace/db/schema";

export type { LlmProviderId };

export interface LlmChatRequest {
  /** Full chat history (system + alternating user/assistant). */
  messages: ConversationMessage[];
  /** Latest user input — provider appends this as the trailing user turn. */
  userInput: string;
  /** Hard upper bound on generated tokens. */
  maxTokens: number;
  /** 0..1, defaults vary per provider. */
  temperature?: number;
  /** Hard request abort deadline (ms). */
  timeoutMs?: number;
}

export interface LlmChatResponse {
  /** Final spoken text (post-cleanup, [DONE] prefix stripped). */
  text: string;
  /** True when the model signalled end-of-call via [DONE]. */
  shouldEnd: boolean;
  /** Wall-clock ms for the chat call. */
  latencyMs: number;
  /** Time to first token (ms) when streamed; null when non-streaming. */
  firstTokenMs: number | null;
  /** Provider id that produced this response. */
  providerId: LlmProviderId;
  /** Model name actually used. */
  model: string;
  /** Optional usage data when the provider returns it. */
  usage?: { promptTokens?: number; completionTokens?: number };
  /** Set when text === "" so the caller can fall back / soft-retry. */
  failureReason?: string;
}

export interface LlmTestResult {
  ok: boolean;
  message: string;
  latencyMs: number;
  modelEcho?: string;
}

export interface LlmProvider {
  readonly id: LlmProviderId;
  readonly label: string;
  readonly defaultModel: string;
  /** Run one chat completion. Returns text="" on transport failure. */
  chat(req: LlmChatRequest, apiKey: string, model?: string): Promise<LlmChatResponse>;
  /** Cheap reachability test — usually a tiny chat round-trip. */
  test(apiKey: string, model?: string): Promise<LlmTestResult>;
}
