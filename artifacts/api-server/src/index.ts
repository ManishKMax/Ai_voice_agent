import http from "http";
import app from "./app.js";
import { logger } from "./lib/logger.js";
import { attachMediaStreamServer } from "./websocket/media-stream.js";
import { registerProcessor } from "./modules/queue/queue.service.js";
import { triggerCallForLead } from "./modules/calls/calls.service.js";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error("PORT environment variable is required but was not provided.");
}

const port = Number(rawPort);
if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

registerProcessor(async (leadId: number) => {
  logger.info({ leadId }, "Queue processor: triggering call");
  await triggerCallForLead(leadId);
});

const httpServer = http.createServer(app);
attachMediaStreamServer(httpServer);

httpServer.listen(port, () => {
  logger.info({ port }, "Server listening");
});

httpServer.on("error", (err) => {
  logger.error({ err }, "HTTP server error");
  process.exit(1);
});
