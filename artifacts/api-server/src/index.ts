import http from "http";
import app from "./app.js";
import { logger } from "./lib/logger.js";
import { registerProcessor } from "./modules/queue/queue.service.js";
import { triggerCallForLead } from "./modules/calls/calls.service.js";
import { resetStuckCallingLeads } from "./modules/leads/leads.service.js";
import { loadAgentConfig } from "./config/agent.config.js";

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

httpServer.listen(port, async () => {
  logger.info({ port }, "Server listening");

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
});

httpServer.on("error", (err) => {
  logger.error({ err }, "HTTP server error");
  process.exit(1);
});
