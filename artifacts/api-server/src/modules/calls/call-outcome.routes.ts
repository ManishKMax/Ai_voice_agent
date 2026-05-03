import { Router } from "express";
import { authMiddleware } from "../../middlewares/auth.js";
import { eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { callsTable, leadsTable, type CallOutcome } from "@workspace/db/schema";
import { createAuditLog } from "../audit/audit.service.js";
import type { AuthRequest } from "../../middlewares/auth.js";

const router = Router();

router.patch("/:id/outcome", authMiddleware, async (req: AuthRequest, res, next): Promise<void> => {
  try {
    const callId = parseInt(req.params["id"] as string, 10);
    if (isNaN(callId)) { res.status(400).json({ error: "Invalid call ID" }); return; }

    const { outcome, followUpDate, followUpTime, outcomeNotes } = req.body as {
      outcome: CallOutcome;
      followUpDate?: string;
      followUpTime?: string;
      outcomeNotes?: string;
    };

    const validOutcomes: CallOutcome[] = ["INTERESTED", "NOT_INTERESTED", "NO_RESPONSE"];
    if (!validOutcomes.includes(outcome)) {
      res.status(400).json({ error: `outcome must be one of: ${validOutcomes.join(", ")}` });
      return;
    }

    if (outcome === "INTERESTED" && !followUpDate) {
      res.status(400).json({ error: "followUpDate is required when outcome is INTERESTED" });
      return;
    }

    const [call] = await db
      .select()
      .from(callsTable)
      .where(eq(callsTable.id, callId))
      .limit(1);

    if (!call) { res.status(404).json({ error: "Call not found" }); return; }

    const [updated] = await db
      .update(callsTable)
      .set({
        outcome,
        followUpDate: followUpDate ?? null,
        followUpTime: followUpTime ?? null,
        outcomeNotes: outcomeNotes ?? null,
        updatedAt: new Date(),
      })
      .where(eq(callsTable.id, callId))
      .returning();

    const leadStatus =
      outcome === "INTERESTED"
        ? "interested"
        : outcome === "NOT_INTERESTED"
          ? "not_interested"
          : "no_response";

    await db
      .update(leadsTable)
      .set({ status: leadStatus, updatedAt: new Date() })
      .where(eq(leadsTable.id, call.leadId));

    await createAuditLog({
      userId: req.userId,
      action: "CALL_OUTCOME_SET",
      targetType: "call",
      targetId: callId,
      metadata: { outcome, followUpDate, followUpTime, leadId: call.leadId, newLeadStatus: leadStatus },
    });

    res.json({ call: updated });
  } catch (err) {
    next(err);
  }
});

export default router;
