import { eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { callsTable, callAnalysisTable, leadsTable } from "@workspace/db/schema";
import { analyzeTranscript } from "../../services/sarvam.service.js";
import { logger } from "../../lib/logger.js";

export async function analyzeCallAndUpdateLead(callId: number): Promise<void> {
  const [call] = await db
    .select()
    .from(callsTable)
    .where(eq(callsTable.id, callId))
    .limit(1);

  if (!call) {
    logger.warn({ callId }, "Call not found for analysis");
    return;
  }

  if (!call.transcript) {
    logger.info({ callId }, "No transcript available, skipping analysis");
    return;
  }

  logger.info({ callId, leadId: call.leadId }, "Starting AI analysis");

  const result = await analyzeTranscript(call.transcript);

  await db.insert(callAnalysisTable).values({
    callId: call.id,
    leadId: call.leadId,
    interest: result.interest,
    nextAction: result.nextAction,
    summary: result.summary,
  });

  const newStatus =
    result.interest === "high" || result.nextAction === "demo"
      ? "interested"
      : result.nextAction === "drop"
        ? "not_interested"
        : "completed";

  await db
    .update(leadsTable)
    .set({ status: newStatus, updatedAt: new Date() })
    .where(eq(leadsTable.id, call.leadId));

  logger.info({ callId, leadId: call.leadId, interest: result.interest, newStatus }, "AI analysis complete");
}
