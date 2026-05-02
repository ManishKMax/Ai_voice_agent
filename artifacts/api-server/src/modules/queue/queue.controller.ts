import type { Response } from "express";
import type { AuthRequest } from "../../middlewares/auth.js";
import { inArray, eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { leadsTable } from "@workspace/db/schema";
import { getQueueStats, enqueueLead } from "./queue.service.js";
import { logger } from "../../lib/logger.js";

/**
 * GET /api/queue
 * Returns queue stats and each job enriched with the lead's current DB status.
 */
export async function getQueue(req: AuthRequest, res: Response): Promise<void> {
  try {
    const stats = getQueueStats();

    const leadMap = new Map<number, { id: number; name: string; phone: string; status: string; retryCount: string }>();

    if (stats.jobs.length > 0) {
      const leadIds = [...new Set(stats.jobs.map((j) => j.leadId))];
      const rows = await db
        .select({
          id: leadsTable.id,
          name: leadsTable.name,
          phone: leadsTable.phone,
          status: leadsTable.status,
          retryCount: leadsTable.retryCount,
        })
        .from(leadsTable)
        .where(inArray(leadsTable.id, leadIds));

      for (const row of rows) {
        leadMap.set(row.id, row);
      }
    }

    const enrichedJobs = stats.jobs.map((job) => ({
      id: job.id,
      leadId: job.leadId,
      attempts: job.attempts,
      scheduledAt: job.scheduledAt,
      lead: leadMap.get(job.leadId) ?? null,
    }));

    res.json({
      stats: {
        total: stats.total,
        pending: stats.pending,
        scheduled: stats.scheduled,
      },
      jobs: enrichedJobs,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Failed to get queue";
    res.status(500).json({ error: msg });
  }
}

/**
 * POST /api/queue/:leadId/retry
 * Re-queues a lead. Only allowed when lead status is "no_response".
 */
export async function retryLead(req: AuthRequest, res: Response): Promise<void> {
  try {
    const leadId = parseInt(req.params.leadId as string);
    if (!leadId || isNaN(leadId)) {
      res.status(400).json({ error: "Valid leadId is required" });
      return;
    }

    const [lead] = await db
      .select()
      .from(leadsTable)
      .where(eq(leadsTable.id, leadId))
      .limit(1);

    if (!lead) {
      res.status(404).json({ error: "Lead not found" });
      return;
    }

    if (lead.status !== "no_response") {
      res.status(422).json({
        error: `Cannot retry lead with status "${lead.status}". Only leads with status "no_response" can be manually retried.`,
        currentStatus: lead.status,
      });
      return;
    }

    // Reset retry counter and status so the full budget is available again
    await db
      .update(leadsTable)
      .set({ status: "pending", retryCount: "0", updatedAt: new Date() })
      .where(eq(leadsTable.id, leadId));

    enqueueLead(leadId);

    logger.info({ leadId }, "Lead manually re-queued via retry endpoint");

    res.json({
      message: "Lead re-queued for retry",
      leadId,
      previousStatus: lead.status,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Failed to retry lead";
    res.status(500).json({ error: msg });
  }
}
