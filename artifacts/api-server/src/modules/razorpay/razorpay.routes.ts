import { Router, type Request } from "express";
import crypto from "crypto";
import { activateSubscriptionAfterPayment } from "../subscriptions/subscriptions.service.js";
import { db } from "@workspace/db";
import { tenantsTable, subscriptionsTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { createAuditLog } from "../audit/audit.service.js";
import { logger } from "../../lib/logger.js";
import { platformSettings } from "../../config/platform.config.js";

const router = Router();

function verifyRazorpaySignature(payload: Buffer | string, signature: string, secret: string): boolean {
  if (!secret) {
    // Only allow empty-secret bypass in development; in production always require signing.
    return process.env.NODE_ENV !== "production";
  }
  if (!signature) return false;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("hex");
  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length) return false;
  return crypto.timingSafeEqual(expBuf, sigBuf);
}

router.post("/razorpay/webhook", async (req, res, next): Promise<void> => {
  try {
    const signature = (req.headers["x-razorpay-signature"] as string) ?? "";
    // Razorpay signs the EXACT raw bytes — JSON.stringify(req.body) re-serializes
    // and changes whitespace/key order, so HMAC will not match. Use the raw buffer
    // captured by the express.json `verify` hook in app.ts.
    const rawBody: Buffer | string =
      (req as Request & { rawBody?: Buffer }).rawBody ?? JSON.stringify(req.body);
    const secret = platformSettings.razorpayWebhookSecret || process.env.RAZORPAY_WEBHOOK_SECRET || "";

    if (!verifyRazorpaySignature(rawBody, signature, secret)) {
      logger.warn("Razorpay webhook signature mismatch");
      res.status(400).json({ error: "Invalid signature" });
      return;
    }

    const event = req.body;
    const eventType = event?.event as string;

    logger.info({ eventType }, "Razorpay webhook received");

    if (eventType === "payment.captured" || eventType === "subscription.charged") {
      const payment = event?.payload?.payment?.entity ?? event?.payload?.subscription?.entity;
      const notes = payment?.notes ?? {};
      const tenantId = notes?.tenantId ? Number(notes.tenantId) : null;

      if (!tenantId) {
        logger.warn({ event }, "Razorpay webhook: no tenantId in notes");
        res.json({ received: true });
        return;
      }

      const [tenant] = await db
        .select({ id: tenantsTable.id })
        .from(tenantsTable)
        .where(eq(tenantsTable.id, tenantId))
        .limit(1);

      if (!tenant) {
        logger.warn({ tenantId }, "Razorpay webhook: tenant not found");
        res.json({ received: true });
        return;
      }

      await activateSubscriptionAfterPayment(tenantId, {
        razorpaySubscriptionId: event?.payload?.subscription?.entity?.id,
        razorpayOrderId: payment?.order_id,
        razorpayPaymentId: payment?.id,
      });

      logger.info({ tenantId, eventType }, "Subscription activated via Razorpay webhook");
    } else if (eventType === "payment.failed" || eventType === "subscription.halted") {
      const payment = event?.payload?.payment?.entity ?? event?.payload?.subscription?.entity;
      const notes = payment?.notes ?? {};
      const tenantId = notes?.tenantId ? Number(notes.tenantId) : null;

      if (tenantId) {
        await db
          .update(subscriptionsTable)
          .set({ status: "payment_failed", updatedAt: new Date() })
          .where(eq(subscriptionsTable.tenantId, tenantId));

        await createAuditLog({
          action: "SUBSCRIPTION_PAYMENT_FAILED",
          targetType: "tenant",
          targetId: tenantId,
          metadata: { eventType, paymentId: payment?.id },
        });

        logger.warn({ tenantId, eventType }, "Subscription payment failed");
      }
    } else if (eventType === "subscription.cancelled") {
      const sub = event?.payload?.subscription?.entity;
      const notes = sub?.notes ?? {};
      const tenantId = notes?.tenantId ? Number(notes.tenantId) : null;

      if (tenantId) {
        await db
          .update(subscriptionsTable)
          .set({ status: "cancelled", cancelledAt: new Date(), updatedAt: new Date() })
          .where(eq(subscriptionsTable.tenantId, tenantId));

        logger.info({ tenantId }, "Subscription cancelled via Razorpay webhook");
      }
    }

    res.json({ received: true });
  } catch (err) {
    next(err);
  }
});

export default router;
