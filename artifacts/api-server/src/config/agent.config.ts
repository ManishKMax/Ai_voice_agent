export interface AgentConfig {
  name: string;
  language: string;
  voice: string;
  tone: "professional" | "friendly" | "casual";
  companyName: string;
  productName: string;
  maxTurns: number;
}

const TONE_MAP = {
  professional: "professional",
  friendly: "friendly",
  casual: "casual",
} as const;

function parseTone(val?: string): AgentConfig["tone"] {
  if (val && val in TONE_MAP) return val as AgentConfig["tone"];
  return "professional";
}

export const agentConfig: AgentConfig = {
  name: process.env.AGENT_NAME ?? "Priya",
  language: process.env.AGENT_LANGUAGE ?? "en-IN",
  voice: process.env.AGENT_VOICE ?? "priya",
  tone: parseTone(process.env.AGENT_TONE),
  companyName: process.env.COMPANY_NAME ?? "TechCorp CRM",
  productName: process.env.PRODUCT_NAME ?? "CRM Suite",
  maxTurns: parseInt(process.env.AGENT_MAX_TURNS ?? "6"),
};

export function buildSystemPrompt(cfg: AgentConfig, leadName?: string, greetingText?: string): string {
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
