import { Router } from "express";
import type { Request, Response } from "express";
import { addSseClient, removeSseClient } from "../../services/sse.service.js";

const router = Router();

router.get("/sse/events", (req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const clientId = addSseClient(res);

  res.write(`event: connected\ndata: ${JSON.stringify({ clientId, ts: Date.now() })}\n\n`);

  const heartbeat = setInterval(() => {
    res.write(`:heartbeat\n\n`);
  }, 25_000);

  req.on("close", () => {
    clearInterval(heartbeat);
    removeSseClient(clientId);
  });
});

export default router;
