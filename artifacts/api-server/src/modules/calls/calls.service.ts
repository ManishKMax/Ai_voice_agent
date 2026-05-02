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
    logger.info({ leadId, status: lead.status }, "Skipping call — lead not pending");
    return;
  }

  await updateLeadStatus(leadId, "calling");

  const [call] = await db
    .insert(callsTable)
    .values({ leadId, callStatus: "initiated" })
    .returning();

  try {
    const callSid = await initiateCall(lead.phone, leadId);
    await db
      .update(callsTable)
      .set({ twilioCallSid: callSid })
      .where(eq(callsTable.id, call.id));
    logger.info({ leadId, callSid }, "Call record updated with Twilio SID");
  } catch (err) {
    logger.error({ err, leadId }, "Failed to initiate Twilio call");
    await updateLeadStatus(leadId, "pending");
    await db.delete(callsTable).where(eq(callsTable.id, call.id));
    throw err;
  }
}

export async function handleCallStatusUpdate(
  twilioCallSid: string,
  callStatus: string,
  leadId: number,
  duration?: number,
  recordingUrl?: string
) {
  const status = callStatus.toLowerCase() as CallStatus;

  const [callRow] = await db
    .update(callsTable)
    .set({ callStatus: status, duration, recordingUrl, updatedAt: new Date() })
    .where(eq(callsTable.twilioCallSid, twilioCallSid))
    .returning();

  if (!callRow) {
    logger.warn({ twilioCallSid }, "Call row not found for status update");
    return;
  }

  if (status === "completed") {
    await updateLeadStatus(leadId, "completed");
  } else if (status === "no-answer" || status === "busy") {
    const [lead] = await db.select().from(leadsTable).where(eq(leadsTable.id, leadId)).limit(1);
    const retries = parseInt(lead?.retryCount ?? "0");
    if (retries < 3) {
      await db
        .update(leadsTable)
        .set({ retryCount: String(retries + 1), status: "pending", updatedAt: new Date() })
        .where(eq(leadsTable.id, leadId));
      const retryDelayMs = 2 * 60 * 60 * 1000;
      enqueueLead(leadId, retryDelayMs);
      logger.info({ leadId, retries: retries + 1 }, "Lead scheduled for retry");
    } else {
      await updateLeadStatus(leadId, "no_response");
      logger.info({ leadId }, "Lead marked no_response after max retries");
    }
  } else if (status === "failed") {
    await updateLeadStatus(leadId, "no_response");
  }

  return callRow;
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
  const [call] = await db.select().from(callsTable).where(eq(callsTable.id, id)).limit(1);
  return call;
}

export async function updateCallTranscript(twilioCallSid: string, transcript: string) {
  await db
    .update(callsTable)
    .set({ transcript, updatedAt: new Date() })
    .where(eq(callsTable.twilioCallSid, twilioCallSid));
}
