import crypto from "crypto";
import { platformSettings } from "../config/platform.config.js";
import { logger } from "../lib/logger.js";
import type { Lead } from "@workspace/db/schema";

export type WebhookEvent =
  | "lead.interested"
  | "lead.not_interested"
  | "lead.callback"
  | "lead.completed"
  | "lead.dnc"
  | "lead.no_response";

const TERMINAL_STATUSES = new Set([
  "interested",
  "not_interested",
  "callback",
  "completed",
  "dnc",
  "no_response",
]);

export function shouldFireWebhook(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}

export function statusToEvent(status: string): WebhookEvent | null {
  const map: Record<string, WebhookEvent> = {
    interested: "lead.interested",
    not_interested: "lead.not_interested",
    callback: "lead.callback",
    completed: "lead.completed",
    dnc: "lead.dnc",
    no_response: "lead.no_response",
  };
  return map[status] ?? null;
}

export async function fireWebhook(event: WebhookEvent, lead: Lead): Promise<void> {
  const url = platformSettings.webhookUrl;
  if (!url) return;

  const payload = JSON.stringify({
    event,
    timestamp: new Date().toISOString(),
    lead: {
      id: lead.id,
      name: lead.name,
      phone: lead.phone,
      source: lead.source,
      sourceId: lead.sourceId,
      status: lead.status,
      tags: lead.tags,
      priority: lead.priority,
      notes: lead.notes,
      dnc: lead.dnc,
      createdAt: lead.createdAt,
      updatedAt: lead.updatedAt,
    },
  });

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "LeadCaller-Webhook/1.0",
    "X-Webhook-Event": event,
  };

  const secret = platformSettings.webhookSecret;
  if (secret) {
    const sig = crypto.createHmac("sha256", secret).update(payload).digest("hex");
    headers["X-Webhook-Signature"] = `sha256=${sig}`;
  }

  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: payload,
      signal: AbortSignal.timeout(10000),
    });
    logger.info(
      { event, leadId: lead.id, status: res.status, url },
      "Webhook fired"
    );
  } catch (err) {
    logger.warn({ err, event, leadId: lead.id, url }, "Webhook delivery failed (non-fatal)");
  }
}
