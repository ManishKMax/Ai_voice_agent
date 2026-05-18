import { db } from "@workspace/db";
import {
  agentSettingsTable,
  type LlmCredentialsMap,
  type LlmProviderId,
} from "@workspace/db/schema";
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
  /**
   * Editable opening line. Null = built-in default. Supports placeholders:
   * {leadName}, {agentName}, {companyName}, {productName}.
   */
  greetingTemplate: string | null;
  /** Active LLM provider for live conversation. Default "sarvam". */
  llmProviderId: LlmProviderId;
  /** Per-provider credentials (apiKey + optional model). */
  llmCredentials: LlmCredentialsMap;
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

const VALID_LLM_IDS: ReadonlySet<LlmProviderId> = new Set(["sarvam", "groq", "openai", "gemini"]);

function parseLlmId(val: unknown): LlmProviderId {
  if (typeof val === "string" && VALID_LLM_IDS.has(val as LlmProviderId)) return val as LlmProviderId;
  return "sarvam";
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
    greetingTemplate: null,
    llmProviderId: "sarvam",
    llmCredentials: {},
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
        greetingTemplate: stored.greetingTemplate ?? null,
        llmProviderId: parseLlmId(stored.llmProviderId),
        llmCredentials: (stored.llmCredentials ?? {}) as LlmCredentialsMap,
      };
      logger.info(
        { name: agentConfig.name, voice: agentConfig.voice, llmProviderId: agentConfig.llmProviderId },
        "Agent config loaded from DB",
      );
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

/**
 * Substitute the four supported placeholders into a greeting template.
 * Trims to a HARD 200-char ceiling so a runaway template can't blow up
 * TTS latency or cause dead-air at call start.
 */
function fillGreetingTemplate(template: string, cfg: AgentConfig, leadName: string): string {
  const filled = template
    .replaceAll("{leadName}", leadName)
    .replaceAll("{agentName}", cfg.name)
    .replaceAll("{companyName}", cfg.companyName)
    .replaceAll("{productName}", cfg.productName)
    .trim();
  return filled.length > 200 ? filled.slice(0, 200) : filled;
}

/**
 * Built-in fallback greeting for when no template is configured. Kept in
 * its own helper so `agent.controller.ts` can show it as a placeholder in
 * the Settings UI ("here's what we'd say by default").
 */
export function defaultGreetingTemplate(cfg: AgentConfig): string {
  // Keep the greeting SHORT (~10 words) so TTS finishes in ~2s instead of ~5-6s.
  // Long greetings caused dead-air at the start of every call.
  //
  // For Indian languages, use the SAME Hinglish style the conversation
  // model uses — otherwise the lead hears an English greeting and then
  // the agent flips into Hindi mid-call, which sounds jarring. Hindi
  // words go in Devanagari so Bulbul's Hindi voice pronounces them
  // naturally (matches the system-prompt rule below).
  const isIndian = cfg.language === "hi-IN" || cfg.language === "en-IN";
  if (isIndian) {
    return cfg.tone === "professional"
      ? `Hi {leadName} ji, मैं {agentName} बोल रही हूँ {companyName} से। एक मिनट है आपके पास?`
      : cfg.tone === "casual"
      ? `Hi {leadName}, {agentName} this side, {companyName} से। एक minute हो सकता है?`
      : `Hello {leadName} ji, {agentName} from {companyName}. एक छोटा सा बात करनी थी, time है?`;
  }
  return cfg.tone === "professional"
    ? `Hi {leadName}, this is {agentName} from {companyName}. Got a minute?`
    : cfg.tone === "casual"
    ? `Hey {leadName}, {agentName} from {companyName} here. You free?`
    : `Hi {leadName}! {agentName} from {companyName}. Got a quick minute?`;
}

export function buildGreetingText(cfg: AgentConfig, leadName: string): string {
  // User-configured template wins; otherwise fall back to the built-in
  // tone-based default. Both paths share the same placeholder system.
  const template =
    cfg.greetingTemplate && cfg.greetingTemplate.trim()
      ? cfg.greetingTemplate
      : defaultGreetingTemplate(cfg);
  return fillGreetingTemplate(template, cfg, leadName);
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

  // For Indian languages (hi-IN and en-IN), reply in natural Hinglish —
  // mixing Hindi + English the way Indians actually speak on phone. The
  // CRITICAL detail: write Hindi words in DEVANAGARI script, English words
  // in Latin. The TTS voice (Sarvam Bulbul v3) auto-detects script and
  // routes Devanagari to the Hindi voice model (natural pronunciation) and
  // Latin to the English voice model (natural pronunciation of English
  // loanwords). Romanised Hindi like "samajh gayi" or "bataa deti hoon"
  // gets read letter-by-letter by the English model and sounds broken —
  // that was the previous default and we explicitly reversed it after
  // user feedback that pronunciation was unintelligible.
  const isIndian = cfg.language === "hi-IN" || cfg.language === "en-IN";
  const languageRule = isIndian
    ? `Reply in CASUAL EVERYDAY HINGLISH — the way young urban Indian professionals actually talk on phone. NOT formal/literary Hindi, NOT news-anchor Hindi.

SCRIPT RULES (critical for pronunciation):
- Write Hindi/Hindi-origin words in DEVANAGARI (e.g. "समझ गई", "ठीक है", "बता दो", "अच्छा")
- Write English/business/tech words in LATIN (e.g. "demo", "CRM", "schedule", "meeting", "system", "leads", "sales", "team", "follow-up", "call back", "okay", "sure", "actually", "basically")
- Use English for ALL technical, business, and modern words. Use Hindi ONLY for everyday connectors and emotion words.

VOCABULARY — USE these natural words:
✓ "system" (NOT "प्रणाली")          ✓ "abhi" / "अभी" (NOT "वर्तमान में")
✓ "manage karna" (NOT "प्रबंधन")    ✓ "use karte ho" (NOT "उपयोग करते हैं")
✓ "lead" / "leads" (NOT "ग्राहक")   ✓ "problem" (NOT "समस्या")
✓ "demo" (NOT "प्रदर्शन")           ✓ "team" (NOT "दल")
✓ "schedule" (NOT "नियोजन")         ✓ "feature" (NOT "विशेषता")

NEVER use heavy/formal Hindi: वर्तमान, प्रणाली, उपयोग, प्रबंधन, ग्राहक, समस्या, प्रदर्शन, विशेषता, सहायता, धन्यवाद (use "thanks"), कृपया (use "please" or just drop it).

Good example: "अच्छा, अभी कौन सा CRM use कर रहे हो? कोई specific problem face कर रहे हो leads manage करने में?"
Bad example: "वर्तमान में आप किस प्रणाली का उपयोग कर रहे हैं? क्या आपको ग्राहक प्रबंधन में कोई समस्या है?"`
    : `Reply in ${cfg.language}.`;

  return `You are ${cfg.name}, a fast voice sales agent from ${cfg.companyName}.
${toneStyle[cfg.tone]}
${nameCtx}
${greetingCtx}

Your goal: qualify the lead by (1) confirming the right person, (2) one-line pitch of ${cfg.productName}, (3) one open question, (4) gauge interest, (5) offer demo if interested, (6) politely close if not.

CRITICAL OUTPUT RULES (every turn):
- ${languageRule}
- KEEP IT UNDER 10 WORDS whenever possible. This is a live phone call — long replies cause dead air.
- HARD CEILING: never exceed 400 characters. Going over breaks the voice system.
- One short sentence per turn. Never two questions at once.
- No <think>, no meta-commentary, no markdown — only the spoken words.
- Never repeat the lead's words back.
- When the outcome is clear (interested / not interested) OR the conversation naturally concludes, start your final response with [DONE] followed by a brief farewell.
- Example endings: [DONE] Thank you, have a great day! | [DONE] Theek hai, aapka time bachata hoon, bye!`;
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
