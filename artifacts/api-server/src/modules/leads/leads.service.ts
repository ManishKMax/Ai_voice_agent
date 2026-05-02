import { eq, desc, ilike, or, inArray, and } from "drizzle-orm";
import { db } from "@workspace/db";
import { leadsTable, callsTable, type InsertLead, type LeadStatus, type LeadPriority } from "@workspace/db/schema";
import { enqueueLead } from "../queue/queue.service.js";
import { logger } from "../../lib/logger.js";

export async function createLead(data: InsertLead) {
  const [lead] = await db.insert(leadsTable).values(data).returning();
  enqueueLead(lead.id);
  logger.info({ leadId: lead.id }, "Lead created and enqueued");
  return lead;
}

export async function createLeadsFromCSV(rows: InsertLead[]) {
  const leads = await db.insert(leadsTable).values(rows).returning();
  for (const lead of leads) {
    enqueueLead(lead.id);
  }
  logger.info({ count: leads.length }, "Bulk leads created and enqueued");
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

  // If manually set back to pending, re-enqueue
  if (data.status === "pending") {
    enqueueLead(id);
  }

  const [updated] = await db
    .update(leadsTable)
    .set(patch)
    .where(eq(leadsTable.id, id))
    .returning();

  logger.info({ leadId: id, patch: Object.keys(data) }, "Lead updated");
  return updated;
}

export async function deleteLead(id: number) {
  // Delete related call_analysis and calls first
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

/** Properly escape a CSV field value */
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

/**
 * On server startup, reset any leads stuck in "calling" back to "pending"
 * and also re-enqueue all "pending" leads that are not already in the queue.
 */
export async function resetStuckCallingLeads() {
  const stuck = await db
    .update(leadsTable)
    .set({ status: "pending", updatedAt: new Date() })
    .where(eq(leadsTable.status, "calling"))
    .returning({ id: leadsTable.id });

  if (stuck.length > 0) {
    logger.warn({ count: stuck.length, ids: stuck.map((l) => l.id) }, "Reset stuck calling leads on startup");
    for (const lead of stuck) {
      enqueueLead(lead.id);
    }
  }

  const pendingLeads = await db
    .select({ id: leadsTable.id })
    .from(leadsTable)
    .where(and(eq(leadsTable.status, "pending"), eq(leadsTable.dnc, false)));

  let reEnqueued = 0;
  for (const lead of pendingLeads) {
    enqueueLead(lead.id);
    reEnqueued++;
  }

  if (reEnqueued > 0) {
    logger.info({ count: reEnqueued }, "Re-enqueued pending leads on startup");
  }
}
