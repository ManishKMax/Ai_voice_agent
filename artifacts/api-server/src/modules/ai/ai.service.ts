import { eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { callsTable, callAnalysisTable, leadsTable } from "@workspace/db/schema";
import { analyzeTranscript } from "../../services/sarvam.service.js";
import { dequeueLeadJobs } from "../queue/queue.service.js";
import { broadcastSse } from "../../services/sse.service.js";
import { logger } from "../../lib/logger.js";

function interestLevelToScore(interest: string, nextAction: string): number {
  if (interest === "high" || nextAction === "demo") return 85;
  if (interest === "medium" || nextAction === "follow_up") return 55;
  if (interest === "low" && nextAction !== "drop") return 30;
  return 10;
}

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
    logger.info({ callId }, "No transcript available — marking lead completed without analysis");
    await db
      .update(leadsTable)
      .set({ status: "completed", updatedAt: new Date() })
      .where(eq(leadsTable.id, call.leadId));
    return;
  }

  logger.info({ callId, leadId: call.leadId }, "Starting Sarvam AI transcript analysis");

  const result = await analyzeTranscript(call.transcript);

  const interestScore = interestLevelToScore(result.interest, result.nextAction);

  await db
    .update(callsTable)
    .set({ interestScore, updatedAt: new Date() })
    .where(eq(callsTable.id, callId));

  await db
    .insert(callAnalysisTable)
    .values({
      callId: call.id,
      leadId: call.leadId,
      interest: result.interest,
      nextAction: result.nextAction,
      summary: result.summary,
    })
    .onConflictDoNothing();

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

  broadcastSse("lead.analyzed", {
    leadId: call.leadId,
    callId,
    interestScore,
    interest: result.interest,
    newStatus,
  });

  if (newStatus === "interested" || newStatus === "not_interested") {
    dequeueLeadJobs(call.leadId);
  }

  logger.info(
    { callId, leadId: call.leadId, interest: result.interest, nextAction: result.nextAction, newStatus, interestScore },
    "AI analysis complete — lead status updated"
  );
}
