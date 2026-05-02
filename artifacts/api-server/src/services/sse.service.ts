import type { Response } from "express";
import { logger } from "../lib/logger.js";

interface SseClient {
  id: string;
  res: Response;
}

const clients: SseClient[] = [];

export function addSseClient(res: Response): string {
  const id = `sse-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  clients.push({ id, res });
  logger.info({ clientId: id, total: clients.length }, "SSE client connected");
  return id;
}

export function removeSseClient(id: string) {
  const idx = clients.findIndex((c) => c.id === id);
  if (idx !== -1) {
    clients.splice(idx, 1);
    logger.info({ clientId: id, total: clients.length }, "SSE client disconnected");
  }
}

export function broadcastSse(event: string, data: unknown) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  const dead: string[] = [];
  for (const client of clients) {
    try {
      client.res.write(payload);
    } catch {
      dead.push(client.id);
    }
  }
  for (const id of dead) {
    removeSseClient(id);
  }
}

export function getSseClientCount(): number {
  return clients.length;
}
