import http from "http";
import app from "./app.js";
import { logger } from "./lib/logger.js";
import { registerProcessor } from "./modules/queue/queue.service.js";
import { triggerCallForLead } from "./modules/calls/calls.service.js";
import { resetStuckCallingLeads } from "./modules/leads/leads.service.js";
import { loadAgentConfig } from "./config/agent.config.js";
import { loadPlatformSettings } from "./config/platform.config.js";
import { attachMediaStreamServer } from "./websocket/media-stream.js";
// Importing for side effects: registers the Phase-3 CallSession subscriber on
// the Media Streams server so live WS calls (VOICE_PIPELINE=ws) get handled.
import "./websocket/call-session.js";

const rawPort = process.env["PORT"];
if (!rawPort) {
  throw new Error("PORT environment variable is required but was not provided.");
}

const port = Number(rawPort);
if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// Register the queue processor — called for every job dequeued
registerProcessor(async (leadId: number) => {
  logger.info({ leadId }, "Queue processor: triggering call for lead");
  await triggerCallForLead(leadId);
});

const httpServer = http.createServer(app);

// Phase 1: Twilio Media Streams WebSocket server, mounted on the same HTTP
// listener so it works behind Replit's path-based proxy. Endpoint: /api/voice/stream
attachMediaStreamServer(httpServer);

httpServer.listen(port, async () => {
  logger.info({ port }, "Server listening");

  // Load persisted platform credentials from DB (overrides env-var defaults)
  try {
    await loadPlatformSettings();
  } catch (err) {
    logger.error({ err }, "Failed to load platform settings on startup");
  }

  // Load persisted agent config from DB (falls back to env defaults if not set)
  try {
    await loadAgentConfig();
  } catch (err) {
    logger.error({ err }, "Failed to load agent config on startup");
  }

  // On startup, reset any leads that got stuck in "calling" due to a crash
  try {
    await resetStuckCallingLeads();
  } catch (err) {
    logger.error({ err }, "Failed to reset stuck calling leads on startup");
  }

  // Boot-time enable_thinking probe: send a single sarvam-m chat with the
  // documented chat_template_kwargs.enable_thinking=false flag and inspect
  // whether the raw response still contains a <think> block. If Sarvam ever
  // honours the flag, we can drop stripThinking() and recover ~200-1500
  // tokens of latency per turn. Probe runs once at boot, fire-and-forget,
  // never blocks startup, never affects live traffic.
  void probeEnableThinking();
});

async function probeEnableThinking(): Promise<void> {
  const apiKey = process.env["SARVAM_API_KEY"];
  if (!apiKey) {
    logger.info("sarvam_enable_thinking_probe_skipped: no SARVAM_API_KEY");
    return;
  }
  try {
    const res = await fetch("https://api.sarvam.ai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "api-subscription-key": apiKey },
      body: JSON.stringify({
        model: process.env["SARVAM_CHAT_MODEL"] ?? "sarvam-m",
        messages: [{ role: "user", content: "Reply with just the word OK." }],
        temperature: 0,
        max_tokens: 200,
        chat_template_kwargs: { enable_thinking: false },
      }),
    });
    if (!res.ok) {
      logger.warn({ status: res.status }, "sarvam_enable_thinking_probe_http_error");
      return;
    }
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content ?? "";
    const hasThink = /<think>/i.test(content);
    logger.info(
      { has_think_block: hasThink, content_preview: content.slice(0, 80) },
      hasThink
        ? "sarvam_enable_thinking_probe: ignored — <think> still present, stripThinking() still required"
        : "sarvam_enable_thinking_probe: HONOURED — consider dropping stripThinking() and shrinking max_tokens",
    );
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "sarvam_enable_thinking_probe_failed");
  }
}

httpServer.on("error", (err) => {
  logger.error({ err }, "HTTP server error");
  process.exit(1);
});
