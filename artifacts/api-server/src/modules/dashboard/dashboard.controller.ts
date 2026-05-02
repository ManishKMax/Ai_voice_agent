import type { Response } from "express";
import type { AuthRequest } from "../../middlewares/auth.js";
import { db } from "@workspace/db";
import { leadsTable, callsTable } from "@workspace/db/schema";
import { sql, desc } from "drizzle-orm";
import { getQueueStats } from "../queue/queue.service.js";

export async function getDashboardStats(_req: AuthRequest, res: Response): Promise<void> {
  try {
    // Run all DB queries in parallel — no sequential awaits
    const [leadsStats, callStats, recentLeads, recentCalls] = await Promise.all([
      db
        .select({ status: leadsTable.status, count: sql<number>`count(*)` })
        .from(leadsTable)
        .groupBy(leadsTable.status),

      db
        .select({ callStatus: callsTable.callStatus, count: sql<number>`count(*)` })
        .from(callsTable)
        .groupBy(callsTable.callStatus),

      db
        .select()
        .from(leadsTable)
        .orderBy(desc(leadsTable.createdAt))
        .limit(5),

      db
        .select()
        .from(callsTable)
        .orderBy(desc(callsTable.createdAt))
        .limit(5),
    ]);

    const totalLeads = leadsStats.reduce((acc, s) => acc + Number(s.count), 0);
    const totalCalls = callStats.reduce((acc, s) => acc + Number(s.count), 0);

    const statusMap: Record<string, number> = {};
    for (const s of leadsStats) statusMap[s.status] = Number(s.count);

    const callStatusMap: Record<string, number> = {};
    for (const s of callStats) callStatusMap[s.callStatus] = Number(s.count);

    const queueStats = getQueueStats();

    res.json({
      leads: { total: totalLeads, byStatus: statusMap, recent: recentLeads },
      calls: { total: totalCalls, byStatus: callStatusMap, recent: recentCalls },
      queue: queueStats,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Failed to fetch stats";
    res.status(500).json({ error: msg });
  }
}
