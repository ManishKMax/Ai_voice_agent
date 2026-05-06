import { Router } from "express";
import { authMiddleware, requireRole } from "../../middlewares/auth.js";
import { db } from "@workspace/db";
import {
  leadsTable,
  callsTable,
  tenantsTable,
  subscriptionsTable,
} from "@workspace/db/schema";
import { sql, desc, and, gte, eq } from "drizzle-orm";

const router = Router();

router.get("/reports/overview", authMiddleware, requireRole("COMPANY_ADMIN", "SUPER_ADMIN"), async (_req, res, next): Promise<void> => {
  try {
    const [leadsStats, durationStats, outcomeStats] = await Promise.all([
      db
        .select({ status: leadsTable.status, count: sql<number>`count(*)` })
        .from(leadsTable)
        .groupBy(leadsTable.status),

      db.select({
        totalCalls: sql<number>`count(*)`,
        completedCalls: sql<number>`count(case when ${callsTable.callStatus} = 'completed' then 1 end)`,
        totalDurationSeconds: sql<number>`coalesce(sum(case when ${callsTable.callStatus} = 'completed' then ${callsTable.duration} else 0 end), 0)`,
        avgInterestScore: sql<number>`round(avg(${callsTable.interestScore}))`,
      }).from(callsTable),

      db
        .select({ outcome: callsTable.outcome, count: sql<number>`count(*)` })
        .from(callsTable)
        .where(sql`${callsTable.outcome} IS NOT NULL`)
        .groupBy(callsTable.outcome),
    ]);

    const totalLeads = leadsStats.reduce((a, s) => a + Number(s.count), 0);
    const statusMap: Record<string, number> = {};
    for (const s of leadsStats) statusMap[s.status] = Number(s.count);

    const interestedCount   = statusMap["interested"]     ?? 0;
    const notInterestedCount = statusMap["not_interested"] ?? 0;
    const noResponseCount   = statusMap["no_response"]    ?? 0;
    const totalContacted    = interestedCount + notInterestedCount + noResponseCount;
    const conversionRate    = totalContacted > 0 ? Math.round((interestedCount / totalContacted) * 100) : 0;

    const totalCallsN        = Number(durationStats[0]?.totalCalls ?? 0);
    const completedCallsN    = Number(durationStats[0]?.completedCalls ?? 0);
    const totalDurationSeconds = Number(durationStats[0]?.totalDurationSeconds ?? 0);
    const totalMinutesBilled = Math.ceil(totalDurationSeconds / 60);

    const outcomeMap: Record<string, number> = {};
    for (const o of outcomeStats) if (o.outcome) outcomeMap[o.outcome] = Number(o.count);

    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

    const monthlyVolume = await db
      .select({
        year:  sql<number>`extract(year from ${callsTable.createdAt})::int`,
        month: sql<number>`extract(month from ${callsTable.createdAt})::int`,
        calls: sql<number>`count(*)`,
        completedCalls:  sql<number>`count(case when ${callsTable.callStatus} = 'completed' then 1 end)`,
        interestedLeads: sql<number>`count(case when ${callsTable.outcome} = 'INTERESTED' then 1 end)`,
        totalMinutes:    sql<number>`ceil(coalesce(sum(case when ${callsTable.callStatus} = 'completed' then ${callsTable.duration} else 0 end), 0) / 60.0)`,
      })
      .from(callsTable)
      .where(gte(callsTable.createdAt, sixMonthsAgo))
      .groupBy(
        sql`extract(year from ${callsTable.createdAt})`,
        sql`extract(month from ${callsTable.createdAt})`
      )
      .orderBy(
        sql`extract(year from ${callsTable.createdAt})`,
        sql`extract(month from ${callsTable.createdAt})`
      );

    const monthlyData = monthlyVolume.map((r) => {
      const y = Number(r.year);
      const m = Number(r.month);
      return {
        year: y, month: m,
        label: new Date(y, m - 1, 1).toLocaleDateString("en-IN", { month: "short", year: "numeric" }),
        calls: Number(r.calls),
        completedCalls: Number(r.completedCalls),
        interestedLeads: Number(r.interestedLeads),
        totalMinutes: Number(r.totalMinutes),
      };
    });

    const [tenantsCount] = await db.select({ count: sql<number>`count(*)` }).from(tenantsTable);
    const [activeSubsCount] = await db
      .select({ count: sql<number>`count(*)` })
      .from(subscriptionsTable)
      .where(eq(subscriptionsTable.status, "active"));

    res.json({
      leads: {
        total: totalLeads,
        byStatus: statusMap,
        interestedCount,
        notInterestedCount,
        noResponseCount,
        conversionRate,
      },
      calls: {
        total: totalCallsN,
        completed: completedCallsN,
        totalMinutesBilled,
        totalDurationSeconds,
        avgInterestScore: Number(durationStats[0]?.avgInterestScore ?? 0),
        byOutcome: outcomeMap,
      },
      monthly: monthlyData,
      tenants: {
        total: Number(tenantsCount?.count ?? 0),
        activeSubscriptions: Number(activeSubsCount?.count ?? 0),
      },
    });
  } catch (err) {
    next(err);
  }
});

router.get("/reports/tenant/:tenantId", authMiddleware, requireRole("COMPANY_ADMIN", "SUPER_ADMIN"), async (req, res, next): Promise<void> => {
  try {
    const tenantId = parseInt(req.params["tenantId"] as string, 10);
    if (isNaN(tenantId)) { res.status(400).json({ error: "Invalid tenant ID" }); return; }

    const [tenant] = await db
      .select()
      .from(tenantsTable)
      .where(eq(tenantsTable.id, tenantId))
      .limit(1);

    if (!tenant) { res.status(404).json({ error: "Tenant not found" }); return; }

    const [activeSub] = await db
      .select()
      .from(subscriptionsTable)
      .where(and(eq(subscriptionsTable.tenantId, tenantId), eq(subscriptionsTable.status, "active")))
      .orderBy(desc(subscriptionsTable.createdAt))
      .limit(1);

    res.json({
      tenant: {
        id: tenant.id,
        name: tenant.name,
        email: tenant.email,
        kycStatus: tenant.kycStatus,
        minutesBalance: tenant.minutesBalance,
        isActive: tenant.isActive,
      },
      subscription: activeSub ?? null,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
