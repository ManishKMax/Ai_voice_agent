import { eq, desc, ilike, or, inArray, and } from "drizzle-orm";
import { db } from "@workspace/db";
import { leadsTable, callsTable, type InsertLead, type LeadStatus, type LeadPriority } from "@workspace/db/schema";
import { enqueueLead } from "../queue/queue.service.js";
import { logger } from "../../lib/logger.js";
import { fireWebhook, shouldFireWebhook, statusToEvent } from "../../services/webhook.service.js";
import { broadcastSse } from "../../services/sse.service.js";
import { agentConfig, buildGreetingText } from "../../config/agent.config.js";
import { generateSpeech } from "../../services/sarvam.service.js";
import { storeAudio, setPendingGreeting } from "../../services/audio-cache.js";

/**
 * Fire-and-forget: kick off greeting TTS the moment a lead is created so the
 * audio is cached well before Twilio places the call. Skipped for DNC leads
 * (they are never dialed → would just waste Sarvam quota).
 */
function prewarmLeadGreeting(
  leadId: number,
  leadName: string | null,
  dnc: boolean | null | undefined,
): void {
  if (dnc) return;
  const text = buildGreetingText(agentConfig, leadName ?? "there");
  const promise = generateSpeech(text, agentConfig)
    .then(buf => (buf ? storeAudio(buf, "audio/wav") : null))
    .catch(err => {
      logger.warn({ err, leadId }, "Lead-creation greeting prewarm failed");
      return null;
    });
  setPendingGreeting(leadId, text, promise);
}

export async function retryCallForLead(leadId: number): Promise<{ queued: boolean; reason?: string }> {
  const [lead] = await db
    .select()
    .from(leadsTable)
    .where(eq(leadsTable.id, leadId))
    .limit(1);

  if (!lead) return { queued: false, reason: "Lead not found" };
  if (lead.dnc) return { queued: false, reason: "Lead is on DNC list" };
  if (lead.status === "calling") return { queued: false, reason: "Call already in progress" };

  await db
    .update(leadsTable)
    .set({ status: "pending", retryCount: "0", updatedAt: new Date() })
    .where(eq(leadsTable.id, leadId));

  enqueueLead(leadId, 0, lead.priority ?? 2);
  logger.info({ leadId }, "Lead reset to pending and re-enqueued via retry");
  return { queued: true };
}

export async function createLead(data: InsertLead) {
  const [lead] = await db.insert(leadsTable).values(data as typeof leadsTable.$inferInsert).returning();
  enqueueLead(lead.id, 0, lead.priority);
  prewarmLeadGreeting(lead.id, lead.name, lead.dnc);
  logger.info({ leadId: lead.id }, "Lead created, enqueued, and greeting prewarmed");
  broadcastSse("lead.created", { leadId: lead.id, name: lead.name, status: lead.status });
  return lead;
}

export async function createLeadsFromCSV(rows: InsertLead[]) {
  const leads = await db.insert(leadsTable).values(rows as (typeof leadsTable.$inferInsert)[]).returning();
  for (const lead of leads) {
    enqueueLead(lead.id, 0, lead.priority);
    prewarmLeadGreeting(lead.id, lead.name, lead.dnc);
  }
  logger.info({ count: leads.length }, "Bulk leads created, enqueued, and greetings prewarmed");
  return leads;
}

export async function getLeads(filters?: {
  status?: LeadStatus;
  search?: string;
  tags?: string;
  priority?: number;
  limit?: number;
  offset?: number;
}) {
  const conditions: ReturnType<typeof eq>[] = [];

  if (filters?.status) {
    conditions.push(eq(leadsTable.status, filters.status));
  }

  const base = db
    .select()
    .from(leadsTable)
    .orderBy(desc(leadsTable.priority), desc(leadsTable.createdAt))
    .limit(filters?.limit ?? 50)
    .offset(filters?.offset ?? 0);

  if (filters?.search) {
    return base.where(
      and(
        ...(conditions as []),
        or(
          ilike(leadsTable.name, `%${filters.search}%`),
          ilike(leadsTable.phone, `%${filters.search}%`)
        )
      )
    );
  }

  return conditions.length > 0 ? base.where(and(...(conditions as [ReturnType<typeof eq>, ...ReturnType<typeof eq>[]]))) : base;
}

export async function getLeadsCount(filters?: { status?: LeadStatus; search?: string }) {
  const all = await getLeads({ ...filters, limit: 9999, offset: 0 });
  return all.length;
}

export async function updateLeadStatus(leadId: number, status: LeadStatus, notes?: string) {
  const updateData: { status: LeadStatus; updatedAt: Date; notes?: string } = {
    status,
    updatedAt: new Date(),
  };
  if (notes !== undefined) {
    updateData.notes = notes;
  }
  const [updated] = await db
    .update(leadsTable)
    .set(updateData)
    .where(eq(leadsTable.id, leadId))
    .returning();

  if (updated) {
    broadcastSse("lead.status_changed", { leadId, status, name: updated.name });

    if (shouldFireWebhook(status)) {
      const event = statusToEvent(status);
      if (event) {
        fireWebhook(event, updated).catch(() => {});
      }
    }
  }

  return updated;
}

export async function updateLead(
  id: number,
  data: {
    name?: string;
    phone?: string;
    source?: string;
    sourceId?: string;
    notes?: string;
    tags?: string;
    priority?: LeadPriority;
    status?: LeadStatus;
    dnc?: boolean;
  }
) {
  const patch: Record<string, unknown> = { ...data, updatedAt: new Date() };

  if (data.status === "pending") {
    enqueueLead(id);
  }

  const [updated] = await db
    .update(leadsTable)
    .set(patch)
    .where(eq(leadsTable.id, id))
    .returning();

  if (updated) {
    broadcastSse("lead.updated", { leadId: id, changes: Object.keys(data) });

    if (data.status && shouldFireWebhook(data.status)) {
      const event = statusToEvent(data.status);
      if (event) {
        fireWebhook(event, updated).catch(() => {});
      }
    }
  }

  logger.info({ leadId: id, patch: Object.keys(data) }, "Lead updated");
  return updated;
}

export async function deleteLead(id: number) {
  await db.delete(callsTable).where(eq(callsTable.leadId, id));
  const [deleted] = await db
    .delete(leadsTable)
    .where(eq(leadsTable.id, id))
    .returning({ id: leadsTable.id });
  logger.info({ leadId: id }, "Lead deleted");
  return deleted;
}

export async function bulkLeadAction(
  ids: number[],
  action: "delete" | "requeue" | "set_status" | "set_dnc",
  payload?: { status?: LeadStatus; dnc?: boolean }
) {
  if (ids.length === 0) return { count: 0 };

  if (action === "delete") {
    await db.delete(callsTable).where(inArray(callsTable.leadId, ids));
    await db.delete(leadsTable).where(inArray(leadsTable.id, ids));
    logger.info({ count: ids.length }, "Bulk leads deleted");
    return { count: ids.length };
  }

  if (action === "requeue") {
    await db
      .update(leadsTable)
      .set({ status: "pending", updatedAt: new Date() })
      .where(inArray(leadsTable.id, ids));
    for (const id of ids) {
      enqueueLead(id);
    }
    logger.info({ count: ids.length }, "Bulk leads re-queued");
    return { count: ids.length };
  }

  if (action === "set_status" && payload?.status) {
    await db
      .update(leadsTable)
      .set({ status: payload.status, updatedAt: new Date() })
      .where(inArray(leadsTable.id, ids));
    logger.info({ count: ids.length, status: payload.status }, "Bulk lead status updated");
    return { count: ids.length };
  }

  if (action === "set_dnc") {
    await db
      .update(leadsTable)
      .set({ dnc: payload?.dnc ?? true, updatedAt: new Date() })
      .where(inArray(leadsTable.id, ids));
    logger.info({ count: ids.length }, "Bulk DNC flag set");
    return { count: ids.length };
  }

  return { count: 0 };
}

export async function getLeadById(id: number) {
  const [lead] = await db.select().from(leadsTable).where(eq(leadsTable.id, id)).limit(1);
  return lead;
}

function csvEscape(value: string | null | undefined): string {
  const str = value ?? "";
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export async function exportLeadsCSV(): Promise<string> {
  const leads = await db.select().from(leadsTable).orderBy(desc(leadsTable.createdAt));
  const header = "id,name,phone,source,source_id,status,tags,priority,notes,dnc,createdAt\n";
  const rows = leads
    .map(
      (l) =>
        [
          l.id,
          csvEscape(l.name),
          csvEscape(l.phone),
          csvEscape(l.source),
          csvEscape(l.sourceId),
          csvEscape(l.status),
          csvEscape(l.tags),
          l.priority,
          csvEscape(l.notes),
          l.dnc ? "true" : "false",
          l.createdAt.toISOString(),
        ].join(",")
    )
    .join("\n");
  return header + rows;
}

export async function resetStuckCallingLeads() {
  const stuck = await db
    .update(leadsTable)
    .set({ status: "pending", updatedAt: new Date() })
    .where(eq(leadsTable.status, "calling"))
    .returning({ id: leadsTable.id, priority: leadsTable.priority });

  if (stuck.length > 0) {
    logger.warn({ count: stuck.length, ids: stuck.map((l) => l.id) }, "Reset stuck calling leads on startup");
    for (const lead of stuck) {
      enqueueLead(lead.id, 0, lead.priority);
    }
  }

  const pendingLeads = await db
    .select({ id: leadsTable.id, priority: leadsTable.priority })
    .from(leadsTable)
    .where(and(eq(leadsTable.status, "pending"), eq(leadsTable.dnc, false)));

  let reEnqueued = 0;
  for (const lead of pendingLeads) {
    enqueueLead(lead.id, 0, lead.priority);
    reEnqueued++;
  }

  if (reEnqueued > 0) {
    logger.info({ count: reEnqueued }, "Re-enqueued pending leads on startup");
  }
}
