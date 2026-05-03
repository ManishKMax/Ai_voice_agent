import { db, tenantsTable, pricingConfigTable, kycDocumentsTable, usersTable } from "@workspace/db";
import { callsTable, leadsTable } from "@workspace/db/schema";
import { eq, sql, desc, and, gte, lt } from "drizzle-orm";
import bcrypt from "bcryptjs";

export async function getOrCreateTenant(clerkUserId: string, name: string, email: string) {
  const existing = await db
    .select()
    .from(tenantsTable)
    .where(eq(tenantsTable.clerkUserId, clerkUserId))
    .limit(1);

  if (existing.length > 0) return existing[0];

  const [created] = await db
    .insert(tenantsTable)
    .values({ clerkUserId, name, email })
    .returning();

  return created;
}

export async function syncPortalUser(name: string, email: string) {
  if (!email) return null;

  const existing = await db
    .select({
      id: usersTable.id,
      name: usersTable.name,
      email: usersTable.email,
      role: usersTable.role,
      isActive: usersTable.isActive,
      createdAt: usersTable.createdAt,
    })
    .from(usersTable)
    .where(eq(usersTable.email, email))
    .limit(1);

  if (existing.length > 0) {
    return existing[0];
  }

  const password = await bcrypt.hash(`portal-${email}`, 10);
  const [created] = await db
    .insert(usersTable)
    .values({
      name: name || email,
      email,
      password,
      role: "USER",
    })
    .returning({
      id: usersTable.id,
      name: usersTable.name,
      email: usersTable.email,
      role: usersTable.role,
      isActive: usersTable.isActive,
      createdAt: usersTable.createdAt,
    });

  return created;
}

export async function getTenantByClerkId(clerkUserId: string) {
  const rows = await db
    .select()
    .from(tenantsTable)
    .where(eq(tenantsTable.clerkUserId, clerkUserId))
    .limit(1);
  return rows[0] ?? null;
}

export async function getPricingConfig() {
  const rows = await db.select().from(pricingConfigTable).limit(1);
  if (rows.length > 0) return rows[0];
  const [seeded] = await db.insert(pricingConfigTable).values({}).returning();
  return seeded;
}

export async function incrementTrialCalls(tenantId: number) {
  const [updated] = await db
    .update(tenantsTable)
    .set({ trialCallsUsed: sql`${tenantsTable.trialCallsUsed} + 1` })
    .where(eq(tenantsTable.id, tenantId))
    .returning();
  return updated;
}

function formatSource(source: string | null): string {
  if (!source) return "Manual";
  const map: Record<string, string> = {
    manual: "Manual",
    csv_upload: "CSV Import",
    api: "API",
  };
  return map[source] ?? source.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export async function getPortalUsage(limit = 20, offset = 0) {
  const pricing = await getPricingConfig();
  const rateRupees = pricing.perMinuteRatePaise / 100;

  const [statsRow] = await db
    .select({
      totalCalls: sql<number>`COUNT(*)`,
      completedCalls: sql<number>`COUNT(CASE WHEN ${callsTable.callStatus} = 'completed' THEN 1 END)`,
      totalDurationSeconds: sql<number>`COALESCE(SUM(CASE WHEN ${callsTable.callStatus} = 'completed' THEN ${callsTable.duration} ELSE 0 END), 0)`,
    })
    .from(callsTable);

  const [countRow] = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(callsTable);

  const totalCalls = Number(statsRow?.totalCalls ?? 0);
  const completedCalls = Number(statsRow?.completedCalls ?? 0);
  const totalDurationSeconds = Number(statsRow?.totalDurationSeconds ?? 0);
  const totalMinutesBilled = Math.ceil(totalDurationSeconds / 60);
  const totalCostRupees = totalMinutesBilled * rateRupees;

  const campaignRows = await db
    .select({
      source: leadsTable.source,
      calls: sql<number>`COUNT(*)`,
      completedCalls: sql<number>`COUNT(CASE WHEN ${callsTable.callStatus} = 'completed' THEN 1 END)`,
      totalDurationSeconds: sql<number>`COALESCE(SUM(CASE WHEN ${callsTable.callStatus} = 'completed' THEN ${callsTable.duration} ELSE 0 END), 0)`,
    })
    .from(callsTable)
    .innerJoin(leadsTable, eq(callsTable.leadId, leadsTable.id))
    .groupBy(leadsTable.source);

  const byCampaign = campaignRows.map((row) => {
    const minutesBilled = Math.ceil(Number(row.totalDurationSeconds) / 60);
    return {
      source: row.source ?? "manual",
      label: formatSource(row.source),
      calls: Number(row.calls),
      completedCalls: Number(row.completedCalls),
      minutesBilled,
      costRupees: minutesBilled * rateRupees,
    };
  });

  const rows = await db
    .select({
      id: callsTable.id,
      leadId: callsTable.leadId,
      callStatus: callsTable.callStatus,
      duration: callsTable.duration,
      createdAt: callsTable.createdAt,
      leadName: leadsTable.name,
      leadPhone: leadsTable.phone,
      source: leadsTable.source,
    })
    .from(callsTable)
    .innerJoin(leadsTable, eq(callsTable.leadId, leadsTable.id))
    .orderBy(desc(callsTable.createdAt))
    .limit(limit)
    .offset(offset);

  const calls = rows.map((r) => {
    const durationSecs = r.duration ?? 0;
    const minutesBilled = r.callStatus === "completed" ? Math.ceil(durationSecs / 60) : 0;
    return {
      id: r.id,
      leadId: r.leadId,
      leadName: r.leadName,
      leadPhone: r.leadPhone,
      source: r.source ?? "manual",
      sourceLabel: formatSource(r.source),
      callStatus: r.callStatus,
      duration: durationSecs,
      minutesBilled,
      costRupees: minutesBilled * rateRupees,
      createdAt: r.createdAt,
    };
  });

  return {
    summary: {
      totalCalls,
      completedCalls,
      totalMinutesBilled,
      totalCostRupees,
      avgCallDurationSeconds: completedCalls > 0 ? Math.round(totalDurationSeconds / completedCalls) : 0,
    },
    byCampaign,
    calls,
    total: Number(countRow?.count ?? 0),
    perMinuteRateRupees: rateRupees,
  };
}

export async function getPortalUsageMonths() {
  const rows = await db
    .select({
      year: sql<number>`EXTRACT(YEAR FROM ${callsTable.createdAt})::int`,
      month: sql<number>`EXTRACT(MONTH FROM ${callsTable.createdAt})::int`,
      callCount: sql<number>`COUNT(*)`,
    })
    .from(callsTable)
    .groupBy(
      sql`EXTRACT(YEAR FROM ${callsTable.createdAt})`,
      sql`EXTRACT(MONTH FROM ${callsTable.createdAt})`,
    )
    .orderBy(
      desc(sql`EXTRACT(YEAR FROM ${callsTable.createdAt})`),
      desc(sql`EXTRACT(MONTH FROM ${callsTable.createdAt})`),
    );

  return rows.map((r) => {
    const y = Number(r.year);
    const m = Number(r.month);
    return {
      year: y,
      month: m,
      callCount: Number(r.callCount),
      label: new Date(y, m - 1, 1).toLocaleDateString("en-IN", { month: "long", year: "numeric" }),
      value: `${y}-${String(m).padStart(2, "0")}`,
    };
  });
}

export async function getPortalUsageForMonth(year: number, month: number) {
  const pricing = await getPricingConfig();
  const rateRupees = pricing.perMinuteRatePaise / 100;

  const startOfMonth = new Date(year, month - 1, 1);
  const startOfNextMonth = new Date(year, month, 1);

  const [statsRow] = await db
    .select({
      totalCalls: sql<number>`COUNT(*)`,
      completedCalls: sql<number>`COUNT(CASE WHEN ${callsTable.callStatus} = 'completed' THEN 1 END)`,
      totalDurationSeconds: sql<number>`COALESCE(SUM(CASE WHEN ${callsTable.callStatus} = 'completed' THEN ${callsTable.duration} ELSE 0 END), 0)`,
    })
    .from(callsTable)
    .where(and(gte(callsTable.createdAt, startOfMonth), lt(callsTable.createdAt, startOfNextMonth)));

  const rows = await db
    .select({
      id: callsTable.id,
      callStatus: callsTable.callStatus,
      duration: callsTable.duration,
      createdAt: callsTable.createdAt,
      leadName: leadsTable.name,
      leadPhone: leadsTable.phone,
      source: leadsTable.source,
    })
    .from(callsTable)
    .innerJoin(leadsTable, eq(callsTable.leadId, leadsTable.id))
    .where(and(gte(callsTable.createdAt, startOfMonth), lt(callsTable.createdAt, startOfNextMonth)))
    .orderBy(desc(callsTable.createdAt));

  const totalCalls = Number(statsRow?.totalCalls ?? 0);
  const completedCalls = Number(statsRow?.completedCalls ?? 0);
  const totalDurationSeconds = Number(statsRow?.totalDurationSeconds ?? 0);
  const totalMinutesBilled = Math.ceil(totalDurationSeconds / 60);

  const calls = rows.map((r) => {
    const durationSecs = r.duration ?? 0;
    const minutesBilled = r.callStatus === "completed" ? Math.ceil(durationSecs / 60) : 0;
    return {
      id: r.id,
      leadName: r.leadName,
      leadPhone: r.leadPhone,
      sourceLabel: formatSource(r.source),
      callStatus: r.callStatus,
      duration: durationSecs,
      minutesBilled,
      costRupees: minutesBilled * rateRupees,
      createdAt: r.createdAt,
    };
  });

  const monthLabel = new Date(year, month - 1, 1).toLocaleDateString("en-IN", {
    month: "long",
    year: "numeric",
  });

  return {
    year,
    month,
    monthLabel,
    summary: {
      totalCalls,
      completedCalls,
      totalMinutesBilled,
      totalCostRupees: totalMinutesBilled * rateRupees,
      avgCallDurationSeconds:
        completedCalls > 0 ? Math.round(totalDurationSeconds / completedCalls) : 0,
    },
    calls,
    perMinuteRateRupees: rateRupees,
  };
}

export async function submitKycDocument(
  tenantId: number,
  documents: Array<{
    documentType: "aadhaar" | "gst";
    objectPath: string;
    fileName: string;
  }>,
) {
  const saved = await db
    .insert(kycDocumentsTable)
    .values(
      documents.map((doc) => ({
        tenantId,
        documentType: doc.documentType,
        fileUrl: doc.objectPath,
        fileName: doc.fileName,
        status: "pending" as const,
      })),
    )
    .returning();

  await db
    .update(tenantsTable)
    .set({ kycStatus: "submitted", updatedAt: new Date() })
    .where(eq(tenantsTable.id, tenantId));

  return saved;
}
