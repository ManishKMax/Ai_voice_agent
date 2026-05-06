import { db } from "@workspace/db";
import { agentSettingsTable } from "@workspace/db/schema";
import { logger } from "../lib/logger.js";

export interface AgentConfig {
  name: string;
  language: string;
  voice: string;
  tone: "professional" | "friendly" | "casual";
  companyName: string;
  productName: string;
  maxTurns: number;
  customSystemPrompt: string | null;
}

const TONE_MAP = {
  professional: "professional",
  friendly: "friendly",
  casual: "casual",
} as const;

function parseTone(val?: string | null): AgentConfig["tone"] {
  if (val && val in TONE_MAP) return val as AgentConfig["tone"];
  return "professional";
}

function defaultConfig(): AgentConfig {
  return {
    name: process.env.AGENT_NAME ?? "Priya",
    language: process.env.AGENT_LANGUAGE ?? "en-IN",
    voice: process.env.AGENT_VOICE ?? "priya",
    tone: parseTone(process.env.AGENT_TONE),
    companyName: process.env.COMPANY_NAME ?? "TechCorp CRM",
    productName: process.env.PRODUCT_NAME ?? "CRM Suite",
    maxTurns: parseInt(process.env.AGENT_MAX_TURNS ?? "6"),
    customSystemPrompt: null,
  };
}

// Mutable runtime config — updated by updateAgentConfig()
export let agentConfig: AgentConfig = defaultConfig();

/**
 * Load persisted config from DB on startup.
 * Falls back silently to env-var defaults if no row exists.
 */
export async function loadAgentConfig(): Promise<void> {
  try {
    const rows = await db.select().from(agentSettingsTable).limit(1);
    if (rows.length > 0 && rows[0].config) {
      const stored = rows[0].config;
      agentConfig = {
        name: stored.name ?? agentConfig.name,
        language: stored.language ?? agentConfig.language,
        voice: stored.voice ?? agentConfig.voice,
        tone: parseTone(stored.tone),
        companyName: stored.companyName ?? agentConfig.companyName,
        productName: stored.productName ?? agentConfig.productName,
        maxTurns: typeof stored.maxTurns === "number" ? stored.maxTurns : agentConfig.maxTurns,
        customSystemPrompt: stored.customSystemPrompt ?? null,
      };
      logger.info({ name: agentConfig.name, voice: agentConfig.voice }, "Agent config loaded from DB");
    }
  } catch (err) {
    logger.warn({ err }, "Failed to load agent config from DB — using env defaults");
  }
}

/**
 * Update in-memory config and persist to DB.
 */
export async function updateAgentConfig(patch: Partial<AgentConfig>): Promise<AgentConfig> {
  agentConfig = { ...agentConfig, ...patch };

  const rows = await db.select({ id: agentSettingsTable.id }).from(agentSettingsTable).limit(1);
  if (rows.length > 0) {
    await db
      .update(agentSettingsTable)
      .set({ config: agentConfig, updatedAt: new Date() });
  } else {
    await db.insert(agentSettingsTable).values({ config: agentConfig });
  }

  return agentConfig;
}

export function buildGreetingText(cfg: AgentConfig, leadName: string): string {
  return cfg.tone === "professional"
    ? `Hello, this is ${cfg.name} calling from ${cfg.companyName}. May I speak with ${leadName}?`
    : cfg.tone === "casual"
    ? `Hey! This is ${cfg.name} from ${cfg.companyName}. Is this ${leadName}?`
    : `Hi there! This is ${cfg.name} from ${cfg.companyName}. Am I speaking with ${leadName}?`;
}

export function buildSystemPrompt(cfg: AgentConfig, leadName?: string, greetingText?: string): string {
  if (cfg.customSystemPrompt) {
    const nameCtx = leadName ? `\nThe lead's name is ${leadName}.` : "";
    const greetingCtx = greetingText
      ? `\nYou have already opened the call with: "${greetingText}"`
      : `\nYou are beginning the call now.`;
    return cfg.customSystemPrompt + nameCtx + greetingCtx;
  }

  const toneStyle: Record<AgentConfig["tone"], string> = {
    professional: "Be formal, concise and professional. Maintain a business tone throughout.",
    friendly: "Be warm, empathetic and conversational. Make the person feel comfortable.",
    casual: "Be relaxed, easy-going and natural. Keep it light and approachable.",
  };

  const nameCtx = leadName ? `The lead's name is ${leadName}.` : "";
  const greetingCtx = greetingText
    ? `You have already opened the call with: "${greetingText}"`
    : `You are beginning the call now.`;

  return `You are ${cfg.name}, a sales representative calling from ${cfg.companyName}.
${toneStyle[cfg.tone]}
${nameCtx}
${greetingCtx}

Your goal is to qualify the lead by:
1. Confirming you are speaking with the right person (if not yet confirmed)
2. Briefly explaining ${cfg.productName} in one sentence
3. Asking one open-ended question about their current business challenges
4. Gauging their interest level
5. If interested, offering to schedule a product demo
6. If not interested or busy, politely closing the call

IMPORTANT RULES:
- Keep every response to 1-2 short sentences. This is a phone call, not an essay.
- Never ask more than one question at a time.
- Never repeat yourself.
- Do NOT start your response with [DONE] unless you are truly ending the call.
- When the call outcome is clear (interested/not interested) OR the conversation naturally concludes, start your final response with [DONE] followed ONLY by a brief farewell sentence.
- Example endings: [DONE] Thank you for your time, have a great day! | [DONE] I'll have someone reach out with more details. Goodbye!`;
}

export const SARVAM_VOICES = [
  { value: "priya", label: "Priya (F)" },
  { value: "neha", label: "Neha (F)" },
  { value: "kavya", label: "Kavya (F)" },
  { value: "ritu", label: "Ritu (F)" },
  { value: "pooja", label: "Pooja (F)" },
  { value: "ishita", label: "Ishita (F)" },
  { value: "shreya", label: "Shreya (F)" },
  { value: "simran", label: "Simran (F)" },
  { value: "roopa", label: "Roopa (F)" },
  { value: "tanya", label: "Tanya (F)" },
  { value: "shruti", label: "Shruti (F)" },
  { value: "suhani", label: "Suhani (F)" },
  { value: "rupali", label: "Rupali (F)" },
  { value: "niharika", label: "Niharika (F)" },
  { value: "kavitha", label: "Kavitha (F)" },
  { value: "rohan", label: "Rohan (M)" },
  { value: "aditya", label: "Aditya (M)" },
  { value: "rahul", label: "Rahul (M)" },
  { value: "ashutosh", label: "Ashutosh (M)" },
  { value: "amit", label: "Amit (M)" },
  { value: "dev", label: "Dev (M)" },
  { value: "ratan", label: "Ratan (M)" },
  { value: "varun", label: "Varun (M)" },
  { value: "manan", label: "Manan (M)" },
  { value: "sumit", label: "Sumit (M)" },
  { value: "kabir", label: "Kabir (M)" },
  { value: "aayan", label: "Aayan (M)" },
  { value: "shubh", label: "Shubh (M)" },
  { value: "advait", label: "Advait (M)" },
  { value: "anand", label: "Anand (M)" },
  { value: "tarun", label: "Tarun (M)" },
  { value: "sunny", label: "Sunny (M)" },
  { value: "mani", label: "Mani (M)" },
  { value: "gokul", label: "Gokul (M)" },
  { value: "vijay", label: "Vijay (M)" },
  { value: "mohit", label: "Mohit (M)" },
  { value: "rehan", label: "Rehan (M)" },
  { value: "soham", label: "Soham (M)" },
];

export const SARVAM_LANGUAGES = [
  { value: "en-IN", label: "English (India)" },
  { value: "hi-IN", label: "Hindi" },
  { value: "te-IN", label: "Telugu" },
  { value: "ta-IN", label: "Tamil" },
  { value: "kn-IN", label: "Kannada" },
  { value: "ml-IN", label: "Malayalam" },
  { value: "mr-IN", label: "Marathi" },
  { value: "bn-IN", label: "Bengali" },
  { value: "gu-IN", label: "Gujarati" },
  { value: "or-IN", label: "Odia" },
  { value: "pa-IN", label: "Punjabi" },
];
