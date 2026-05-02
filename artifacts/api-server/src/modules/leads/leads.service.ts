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
  const query = db
    .select()
    .from(leadsTable)
    .orderBy(desc(leadsTable.createdAt))
    .limit(filters?.limit ?? 50)
    .offset(filters?.offset ?? 0);

  if (filters?.status) {
    query.where(eq(leadsTable.status, filters.status));
  } else if (filters?.search) {
    query.where(
      or(
        ilike(leadsTable.name, `%${filters.search}%`),
        ilike(leadsTable.phone, `%${filters.search}%`)
      )
    );
  }

  return query;
}

export async function updateLeadStatus(leadId: number, status: LeadStatus, notes?: string) {
  const [updated] = await db
    .update(leadsTable)
    .set({ status, notes, updatedAt: new Date() })
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
