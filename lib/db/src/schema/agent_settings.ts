import { pgTable, serial, jsonb, timestamp } from "drizzle-orm/pg-core";

export type LlmProviderId = "sarvam" | "groq" | "openai" | "gemini";

export interface LlmProviderCredential {
  apiKey?: string;
  model?: string;
}

export type LlmCredentialsMap = Partial<Record<LlmProviderId, LlmProviderCredential>>;

export interface StoredAgentConfig {
  name: string;
  language: string;
  voice: string;
  tone: "professional" | "friendly" | "casual";
  companyName: string;
  productName: string;
  maxTurns: number;
  customSystemPrompt: string | null;
  llmProviderId?: LlmProviderId;
  llmCredentials?: LlmCredentialsMap;
}

export const agentSettingsTable = pgTable("agent_settings", {
  id: serial("id").primaryKey(),
  config: jsonb("config").notNull().$type<StoredAgentConfig>(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
