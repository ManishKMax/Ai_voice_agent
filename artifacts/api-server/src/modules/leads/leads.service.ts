import { eq, desc, ilike, or, and } from "drizzle-orm";
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
  // Only include notes in the update set if explicitly provided
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

export async function exportLeadsCSV(): Promise<string> {
  const leads = await db.select().from(leadsTable).orderBy(desc(leadsTable.createdAt));
  const header = "id,name,phone,source,status,notes,createdAt\n";
  const rows = leads
    .map(
      (l) =>
        `${l.id},"${l.name}","${l.phone}","${l.source ?? ""}","${l.status}","${l.notes ?? ""}","${l.createdAt.toISOString()}"`
    )
    .join("\n");
  return header + rows;
}

/**
 * On server startup, reset any leads stuck in "calling" back to "pending"
 * so they get re-queued. This handles crashes mid-call-initiation.
 */
export async function resetStuckCallingLeads() {
  const stuck = await db
    .update(leadsTable)
    .set({ status: "pending", updatedAt: new Date() })
    .where(eq(leadsTable.status, "calling"))
    .returning({ id: leadsTable.id });

  if (stuck.length > 0) {
    logger.warn({ count: stuck.length, ids: stuck.map((l) => l.id) }, "Reset stuck calling leads");
    for (const lead of stuck) {
      enqueueLead(lead.id);
    }
  }
}
