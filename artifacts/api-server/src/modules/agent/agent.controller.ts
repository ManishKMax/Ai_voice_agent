import type { Response } from "express";
import type { AuthRequest } from "../../middlewares/auth.js";
import {
  agentConfig,
  updateAgentConfig,
  buildSystemPrompt,
  buildGreetingText,
  defaultGreetingTemplate,
  SARVAM_VOICES,
  SARVAM_LANGUAGES,
} from "../../config/agent.config.js";
import { generateSpeech } from "../../services/sarvam.service.js";
import { logger } from "../../lib/logger.js";

export function getAgentConfigHandler(req: AuthRequest, res: Response): void {
  res.json({
    config: agentConfig,
    computedSystemPrompt: buildSystemPrompt(agentConfig, "<lead name>"),
    // Default template shown as placeholder in the Settings UI so users
    // see what the agent says when they leave the field blank.
    defaultGreetingTemplate: defaultGreetingTemplate(agentConfig),
    // Live preview of the greeting that will be spoken (placeholders
    // already substituted) — lets users hear/read the result before save.
    computedGreeting: buildGreetingText(agentConfig, "<lead name>"),
    voices: SARVAM_VOICES,
    languages: SARVAM_LANGUAGES,
  });
}

export async function updateAgentConfigHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const body = req.body as Record<string, unknown>;

    const patch: Partial<typeof agentConfig> = {};
    if (typeof body.name === "string" && body.name.trim()) patch.name = body.name.trim();
    if (typeof body.language === "string") patch.language = body.language;
    if (typeof body.voice === "string") patch.voice = body.voice;
    if (body.tone === "professional" || body.tone === "friendly" || body.tone === "casual") {
      patch.tone = body.tone;
    }
    if (typeof body.companyName === "string" && body.companyName.trim()) {
      patch.companyName = body.companyName.trim();
    }
    if (typeof body.productName === "string" && body.productName.trim()) {
      patch.productName = body.productName.trim();
    }
    if (typeof body.maxTurns === "number" && body.maxTurns >= 1 && body.maxTurns <= 20) {
      patch.maxTurns = body.maxTurns;
    }
    if (body.customSystemPrompt === null || body.customSystemPrompt === "") {
      patch.customSystemPrompt = null;
    } else if (typeof body.customSystemPrompt === "string") {
      patch.customSystemPrompt = body.customSystemPrompt;
    }
    // Greeting template: empty string / null both mean "use default".
    if (body.greetingTemplate === null || body.greetingTemplate === "") {
      patch.greetingTemplate = null;
    } else if (typeof body.greetingTemplate === "string") {
      patch.greetingTemplate = body.greetingTemplate;
    }

    const updated = await updateAgentConfig(patch);
    logger.info({ name: updated.name, voice: updated.voice }, "Agent config updated via API");

    res.json({
      config: updated,
      computedSystemPrompt: buildSystemPrompt(updated, "<lead name>"),
      defaultGreetingTemplate: defaultGreetingTemplate(updated),
      computedGreeting: buildGreetingText(updated, "<lead name>"),
    });
  } catch (err) {
    logger.error({ err }, "Failed to update agent config");
    res.status(500).json({ error: "Failed to update agent config" });
  }
}

export async function voicePreviewHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const body = req.body as { text?: string; voice?: string; language?: string };

    const previewCfg = {
      ...agentConfig,
      voice: body.voice ?? agentConfig.voice,
      language: body.language ?? agentConfig.language,
    };

    const sampleText =
      body.text?.trim() ||
      `Hello! This is ${previewCfg.voice.charAt(0).toUpperCase() + previewCfg.voice.slice(1)} from ${agentConfig.companyName}. How are you doing today?`;

    const audioBuffer = await generateSpeech(sampleText, previewCfg);
    if (!audioBuffer) {
      res.status(502).json({ error: "TTS generation failed" });
      return;
    }

    const audioBase64 = audioBuffer.toString("base64");
    res.json({ audioBase64, contentType: "audio/wav" });
  } catch (err) {
    logger.error({ err }, "Voice preview failed");
    res.status(500).json({ error: "Voice preview failed" });
  }
}
