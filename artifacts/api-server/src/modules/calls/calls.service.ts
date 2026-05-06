import { eq, desc } from "drizzle-orm";
import { db } from "@workspace/db";
import { callsTable, leadsTable, tenantsTable, type CallStatus } from "@workspace/db/schema";
import { initiateCall } from "../../services/twilio.service.js";
import { initiateExotelCall } from "../../services/exotel.service.js";
import { updateLeadStatus } from "../leads/leads.service.js";
import { enqueueLead, dequeueLeadJobs } from "../queue/queue.service.js";
import { platformSettings } from "../../config/platform.config.js";
import { logger } from "../../lib/logger.js";

async function dispatchCall(
  toPhone: string,
  leadId: number,
  tenantId: number | null,
): Promise<string> {
  // Platform-level call (admin dashboard, no tenant) — uses platform Twilio creds
  if (!tenantId) {
    return initiateCall(toPhone, leadId);
  }

  // Tenant-level call — load tenant creds and route by provider
  const [tenant] = await db
    .select()
    .from(tenantsTable)
    .where(eq(tenantsTable.id, tenantId))
    .limit(1);

  if (!tenant) {
    logger.warn({ tenantId, leadId }, "Tenant not found, falling back to platform Twilio");
    return initiateCall(toPhone, leadId);
  }

  const provider = tenant.telephonyProvider ?? "twilio";

  if (provider === "exotel") {
    if (!tenant.exotelAccountSid || !tenant.exotelApiKey || !tenant.exotelApiToken || !tenant.exotelPhoneNumber) {
      throw new Error("Exotel credentials are not configured for this tenant");
    }
    return initiateExotelCall(toPhone, leadId, {
      accountSid: tenant.exotelAccountSid,
      apiKey: tenant.exotelApiKey,
      apiToken: tenant.exotelApiToken,
      phoneNumber: tenant.exotelPhoneNumber,
    });
  }

  // Twilio path: per-tenant creds if available, else platform fallback
  if (tenant.twilioAccountSid && tenant.twilioAuthToken && tenant.twilioPhoneNumber) {
    return initiateCall(toPhone, leadId, {
      accountSid: tenant.twilioAccountSid,
      authToken: tenant.twilioAuthToken,
      phoneNumber: tenant.twilioPhoneNumber,
    });
  }

  return initiateCall(toPhone, leadId);
}

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

  if (lead.dnc) {
    logger.info({ leadId }, "Skipping call — lead is on DNC list");
    dequeueLeadJobs(leadId);
    return;
  }

  // T007: Sarvam access control — if the lead belongs to a tenant, the tenant
  // must have sarvamEnabled. Platform-level kill-switch also applies.
  if (lead.tenantId) {
    const [tenant] = await db
      .select({ sarvamEnabled: tenantsTable.sarvamEnabled })
      .from(tenantsTable)
      .where(eq(tenantsTable.id, lead.tenantId))
      .limit(1);

    if (!platformSettings.sarvamEnabled) {
      logger.warn({ leadId, tenantId: lead.tenantId }, "Skipping call — Sarvam disabled platform-wide");
      await updateLeadStatus(leadId, "no_response");
      return;
    }
    if (!tenant?.sarvamEnabled) {
      logger.warn({ leadId, tenantId: lead.tenantId }, "Skipping call — Sarvam not enabled for this tenant");
      await updateLeadStatus(leadId, "no_response");
      return;
    }
  }

  await updateLeadStatus(leadId, "calling");

  const [call] = await db
    .insert(callsTable)
    .values({ leadId, callStatus: "initiated" })
    .returning();

  try {
    const callSid = await dispatchCall(lead.phone, leadId, lead.tenantId ?? null);
    await db
      .update(callsTable)
      .set({ twilioCallSid: callSid, updatedAt: new Date() })
      .where(eq(callsTable.id, call.id));
    logger.info({ leadId, callSid, callDbId: call.id }, "Call record updated with Twilio SID");
  } catch (err) {
    const twilioCode = (err as Record<string, unknown>)?.code as number | undefined;

    if (twilioCode === 21219) {
      logger.warn({ leadId, callDbId: call.id }, "Twilio error 21219: unverified destination — resetting lead to pending for retry");
      await db.delete(callsTable).where(eq(callsTable.id, call.id));
      // Reset to pending (not permanent no_response) so admin can retry
      // after verifying the number in Twilio console
      await db
        .update(leadsTable)
        .set({
          status: "pending",
          notes: "Call blocked: phone number not verified in Twilio trial account. Verify at twilio.com/console then click Retry Call.",
          updatedAt: new Date(),
        })
        .where(eq(leadsTable.id, leadId));
      dequeueLeadJobs(leadId);
      return;
    }

    logger.error({ err, leadId, callDbId: call.id }, "Failed to initiate Twilio call — reverting lead to pending");
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
  recordingUrl?: string,
  answeredBy?: string
): Promise<typeof callsTable.$inferSelect | undefined> {
  const status = callStatus.toLowerCase() as CallStatus;

  logger.info({ twilioCallSid, status, leadId }, "Handling call status update");

  let [callRow] = await db
    .select()
    .from(callsTable)
    .where(eq(callsTable.twilioCallSid, twilioCallSid))
    .limit(1);

  if (!callRow && status === "initiated") {
    const [fallback] = await db
      .select()
      .from(callsTable)
      .where(eq(callsTable.leadId, leadId))
      .orderBy(desc(callsTable.createdAt))
      .limit(1);

    if (fallback && !fallback.twilioCallSid) {
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

  const [updated] = await db
    .update(callsTable)
    .set({
      callStatus: status,
      ...(duration !== undefined && { duration }),
      ...(recordingUrl && { recordingUrl }),
      ...(answeredBy && { answeredBy }),
      updatedAt: new Date(),
    })
    .where(eq(callsTable.id, callRow.id))
    .returning();

  if (status === "completed") {
    // Check if voicemail — but ONLY trust AMD if no real conversation happened.
    // Twilio's AMD often misclassifies a human's brief "hello" as machine_start;
    // if we already exchanged turns the call was definitely with a human.
    const hadConversation = (callRow.transcript ?? "").trim().length > 0;
    if (answeredBy && answeredBy.startsWith("machine") && !hadConversation) {
      logger.info({ leadId, answeredBy }, "Voicemail detected — scheduling retry");
      const [lead] = await db
        .select({ retryCount: leadsTable.retryCount, priority: leadsTable.priority })
        .from(leadsTable)
        .where(eq(leadsTable.id, leadId))
        .limit(1);

      const retries = parseInt(lead?.retryCount ?? "0");
      const maxRetries = platformSettings.callRetries;

      if (retries < maxRetries) {
        await db
          .update(leadsTable)
          .set({ retryCount: String(retries + 1), status: "pending", updatedAt: new Date() })
          .where(eq(leadsTable.id, leadId));

        const delayMins = [
          platformSettings.retryDelay1,
          platformSettings.retryDelay2,
          platformSettings.retryDelay3,
        ][retries] ?? 120;

        enqueueLead(leadId, delayMins * 60_000, lead?.priority ?? 2);
        logger.info({ leadId, retryCount: retries + 1, delayMins }, "Voicemail — lead scheduled for retry");
      } else {
        dequeueLeadJobs(leadId);
        await updateLeadStatus(leadId, "no_response");
        logger.info({ leadId }, "Voicemail — max retries exhausted, marked no_response");
      }
      return updated;
    }

    const [lead] = await db
      .select({ status: leadsTable.status })
      .from(leadsTable)
      .where(eq(leadsTable.id, leadId))
      .limit(1);

    if (lead?.status === "calling") {
      await updateLeadStatus(leadId, "completed");
      logger.info({ leadId }, "Call completed with no stream analysis — lead marked completed");
    }
  } else if (status === "no-answer" || status === "busy") {
    const [lead] = await db
      .select({ retryCount: leadsTable.retryCount, priority: leadsTable.priority })
      .from(leadsTable)
      .where(eq(leadsTable.id, leadId))
      .limit(1);

    const retries = parseInt(lead?.retryCount ?? "0");
    const maxRetries = platformSettings.callRetries;

    if (retries < maxRetries) {
      await db
        .update(leadsTable)
        .set({ retryCount: String(retries + 1), status: "pending", updatedAt: new Date() })
        .where(eq(leadsTable.id, leadId));

      const delayMins = [
        platformSettings.retryDelay1,
        platformSettings.retryDelay2,
        platformSettings.retryDelay3,
      ][retries] ?? 120;

      enqueueLead(leadId, delayMins * 60_000, lead?.priority ?? 2);
      logger.info({ leadId, retryCount: retries + 1, delayMins }, "Lead scheduled for retry");
    } else {
      dequeueLeadJobs(leadId);
      await updateLeadStatus(leadId, "no_response");
      logger.info({ leadId }, "Lead marked no_response — max retries exhausted");
    }
  } else if (status === "failed") {
    dequeueLeadJobs(leadId);
    await updateLeadStatus(leadId, "no_response");
  }

  return updated;
}

export async function getCalls(filters?: {
  status?: string;
  leadId?: number;
  limit?: number;
  offset?: number;
}) {
  const whereClause = filters?.leadId
    ? eq(callsTable.leadId, filters.leadId)
    : undefined;

  const base = db
    .select()
    .from(callsTable)
    .orderBy(desc(callsTable.createdAt))
    .limit(filters?.limit ?? 50)
    .offset(filters?.offset ?? 0);

  return whereClause ? base.where(whereClause) : base;
}

export async function getCallById(id: number) {
  const [call] = await db
    .select()
    .from(callsTable)
    .where(eq(callsTable.id, id))
    .limit(1);
  return call;
}

export async function setCallOutcome(
  id: number,
  outcome: "INTERESTED" | "NOT_INTERESTED" | "NO_RESPONSE",
  followUpDate?: string | null,
  followUpTime?: string | null,
  outcomeNotes?: string | null,
): Promise<typeof callsTable.$inferSelect | undefined> {
  if (outcome === "INTERESTED" && !followUpDate) {
    throw new Error("followUpDate is required when outcome is INTERESTED");
  }

  const [updated] = await db
    .update(callsTable)
    .set({
      outcome,
      followUpDate: followUpDate ?? null,
      followUpTime: followUpTime ?? null,
      outcomeNotes: outcomeNotes ?? null,
      updatedAt: new Date(),
    })
    .where(eq(callsTable.id, id))
    .returning();

  return updated;
}

export async function updateCallTranscript(twilioCallSid: string, transcript: string) {
  await db
    .update(callsTable)
    .set({ transcript, updatedAt: new Date() })
    .where(eq(callsTable.twilioCallSid, twilioCallSid));
}

export async function updateCallOutcome(
  twilioCallSid: string,
  interest: string,
  summary: string
) {
  await db
    .update(callsTable)
    .set({
      transcript: summary,
      updatedAt: new Date(),
    })
    .where(eq(callsTable.twilioCallSid, twilioCallSid));
}

export async function getActiveCalls() {
  return db
    .select()
    .from(callsTable)
    .where(eq(callsTable.callStatus, "answered"))
    .orderBy(desc(callsTable.createdAt));
}
