import { eq, desc } from "drizzle-orm";
import { db } from "@workspace/db";
import { callsTable, leadsTable, type CallStatus } from "@workspace/db/schema";
import { initiateCall } from "../../services/twilio.service.js";
import { updateLeadStatus } from "../leads/leads.service.js";
import { enqueueLead } from "../queue/queue.service.js";
import { logger } from "../../lib/logger.js";

export async function triggerCallForLead(leadId: number): Promise<void> {
  const [lead] = await db
    .select()
    .from(leadsTable)
    .where(eq(leadsTable.id, leadId))
    .limit(1);

  if (!lead) {
    logger.warn({ leadId }, "Lead not found for call trigger");
    return;
  }

  if (lead.status !== "pending") {
    logger.info({ leadId, status: lead.status }, "Skipping call — lead not in pending state");
    return;
  }

  // Mark as calling first to prevent duplicate triggers
  await updateLeadStatus(leadId, "calling");

  const [call] = await db
    .insert(callsTable)
    .values({ leadId, callStatus: "initiated" })
    .returning();

  try {
    const callSid = await initiateCall(lead.phone, leadId);
    await db
      .update(callsTable)
      .set({ twilioCallSid: callSid, updatedAt: new Date() })
      .where(eq(callsTable.id, call.id));
    logger.info({ leadId, callSid, callDbId: call.id }, "Call record updated with Twilio SID");
  } catch (err) {
    logger.error({ err, leadId, callDbId: call.id }, "Failed to initiate Twilio call — reverting lead to pending");
    // Roll back: delete orphan call record and reset lead so queue can retry
    await db.delete(callsTable).where(eq(callsTable.id, call.id));
    await updateLeadStatus(leadId, "pending");
    throw err;
  }
}

export async function handleCallStatusUpdate(
  twilioCallSid: string,
  callStatus: string,
  leadId: number,
  duration?: number,
  recordingUrl?: string
): Promise<typeof callsTable.$inferSelect | undefined> {
  const status = callStatus.toLowerCase() as CallStatus;

  logger.info({ twilioCallSid, status, leadId }, "Handling call status update");

  // Try to find the call row by SID
  let [callRow] = await db
    .select()
    .from(callsTable)
    .where(eq(callsTable.twilioCallSid, twilioCallSid))
    .limit(1);

  // Race condition guard: "initiated" webhook may arrive before we write the SID.
  // Fall back to looking up by leadId + initiated status.
  if (!callRow && status === "initiated") {
    const [fallback] = await db
      .select()
      .from(callsTable)
      .where(eq(callsTable.leadId, leadId))
      .orderBy(desc(callsTable.createdAt))
      .limit(1);

    if (fallback && !fallback.twilioCallSid) {
      // Write the SID now that we have it
      await db
        .update(callsTable)
        .set({ twilioCallSid, updatedAt: new Date() })
        .where(eq(callsTable.id, fallback.id));
      callRow = { ...fallback, twilioCallSid };
      logger.info({ callId: fallback.id, twilioCallSid }, "Resolved race: wrote call SID from initiated webhook");
    }
  }

  if (!callRow) {
    logger.warn({ twilioCallSid, status }, "Call row not found for status update — ignoring");
    return;
  }

  // Update the call record
  const [updated] = await db
    .update(callsTable)
    .set({
      callStatus: status,
      ...(duration !== undefined && { duration }),
      ...(recordingUrl && { recordingUrl }),
      updatedAt: new Date(),
    })
    .where(eq(callsTable.id, callRow.id))
    .returning();

  // Update lead status based on terminal call states
  if (status === "completed") {
    await updateLeadStatus(leadId, "completed");
  } else if (status === "no-answer" || status === "busy") {
    const [lead] = await db
      .select({ retryCount: leadsTable.retryCount })
      .from(leadsTable)
      .where(eq(leadsTable.id, leadId))
      .limit(1);

    const retries = parseInt(lead?.retryCount ?? "0");

    if (retries < 3) {
      await db
        .update(leadsTable)
        .set({ retryCount: String(retries + 1), status: "pending", updatedAt: new Date() })
        .where(eq(leadsTable.id, leadId));

      const retryDelayMs = 2 * 60 * 60 * 1000; // 2 hours
      enqueueLead(leadId, retryDelayMs);
      logger.info({ leadId, retryCount: retries + 1 }, "Lead scheduled for retry");
    } else {
      await updateLeadStatus(leadId, "no_response");
      logger.info({ leadId }, "Lead marked no_response — max retries exhausted");
    }
  } else if (status === "failed") {
    await updateLeadStatus(leadId, "no_response");
  }

  return updated;
}

export async function getCalls(filters?: { status?: string; limit?: number; offset?: number }) {
  return db
    .select()
    .from(callsTable)
    .orderBy(desc(callsTable.createdAt))
    .limit(filters?.limit ?? 50)
    .offset(filters?.offset ?? 0);
}

export async function getCallById(id: number) {
  const [call] = await db
    .select()
    .from(callsTable)
    .where(eq(callsTable.id, id))
    .limit(1);
  return call;
}

export async function updateCallTranscript(twilioCallSid: string, transcript: string) {
  await db
    .update(callsTable)
    .set({ transcript, updatedAt: new Date() })
    .where(eq(callsTable.twilioCallSid, twilioCallSid));
}
