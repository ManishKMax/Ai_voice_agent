import { eq, desc, ilike, or } from "drizzle-orm";
import { db } from "@workspace/db";
import { leadsTable, type InsertLead, type LeadStatus } from "@workspace/db/schema";
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
  limit?: number;
  offset?: number;
}) {
  // Build where clause before chaining — Drizzle query builder is immutable
  const whereClause = filters?.status
    ? eq(leadsTable.status, filters.status)
    : filters?.search
      ? or(
          ilike(leadsTable.name, `%${filters.search}%`),
          ilike(leadsTable.phone, `%${filters.search}%`)
        )
      : undefined;

  const base = db
    .select()
    .from(leadsTable)
    .orderBy(desc(leadsTable.createdAt))
    .limit(filters?.limit ?? 50)
    .offset(filters?.offset ?? 0);

  return whereClause ? base.where(whereClause) : base;
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

export async function getLeadById(id: number) {
  const [lead] = await db.select().from(leadsTable).where(eq(leadsTable.id, id)).limit(1);
  return lead;
}

/** Properly escape a CSV field value */
function csvEscape(value: string | null | undefined): string {
  const str = value ?? "";
  // If the value contains a comma, quote, newline, or carriage return — wrap in quotes and double internal quotes
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export async function exportLeadsCSV(): Promise<string> {
  const leads = await db.select().from(leadsTable).orderBy(desc(leadsTable.createdAt));
  const header = "id,name,phone,source,status,notes,createdAt\n";
  const rows = leads
    .map(
      (l) =>
        [
          l.id,
          csvEscape(l.name),
          csvEscape(l.phone),
          csvEscape(l.source),
          csvEscape(l.status),
          csvEscape(l.notes),
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
  // 1. Reset "calling" leads (server crash mid-call)
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

  // 2. Re-enqueue any "pending" leads not already in the in-memory queue
  // (covers server restart where the in-memory queue was lost)
  const pendingLeads = await db
    .select({ id: leadsTable.id })
    .from(leadsTable)
    .where(eq(leadsTable.status, "pending"));

  let reEnqueued = 0;
  for (const lead of pendingLeads) {
    // enqueueLead already has a duplicate guard — skip if already queued
    enqueueLead(lead.id);
    reEnqueued++;
  }

  if (reEnqueued > 0) {
    logger.info({ count: reEnqueued }, "Re-enqueued pending leads on startup");
  }
}
