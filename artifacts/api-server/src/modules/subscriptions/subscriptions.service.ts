import { eq, desc, and, gte, lt, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { subscriptionsTable, tenantsTable, pricingConfigTable } from "@workspace/db/schema";
import { createAuditLog } from "../audit/audit.service.js";
import { logger } from "../../lib/logger.js";

export async function getActiveSubscription(tenantId: number) {
  const now = new Date();
  const [sub] = await db
    .select()
    .from(subscriptionsTable)
    .where(
      and(
        eq(subscriptionsTable.tenantId, tenantId),
        eq(subscriptionsTable.status, "active"),
        gte(subscriptionsTable.periodEnd, now)
      )
    )
    .orderBy(desc(subscriptionsTable.createdAt))
    .limit(1);

  return sub ?? null;
}

export async function getCurrentSubscription(tenantId: number) {
  const [sub] = await db
    .select()
    .from(subscriptionsTable)
    .where(eq(subscriptionsTable.tenantId, tenantId))
    .orderBy(desc(subscriptionsTable.createdAt))
    .limit(1);

  return sub ?? null;
}

export async function createSubscription(tenantId: number, adminUserId?: number) {
  const pricing = await db.select().from(pricingConfigTable).limit(1);
  const config = pricing[0];
  if (!config) throw new Error("Pricing config not found");

  const periodStart = new Date();
  const periodEnd = new Date(periodStart);
  periodEnd.setMonth(periodEnd.getMonth() + 1);

  // Expire any current active subscription for this tenant
  await db
    .update(subscriptionsTable)
    .set({ status: "expired", updatedAt: new Date() })
    .where(
      and(
        eq(subscriptionsTable.tenantId, tenantId),
        eq(subscriptionsTable.status, "active")
      )
    );

  const [sub] = await db
    .insert(subscriptionsTable)
    .values({
      tenantId,
      status: "active",
      planName: "monthly_2000",
      planCostPaise: config.monthlyPlanCostPaise,
      includedMinutes: config.monthlyMinutesQuota,
      usedMinutes: 0,
      extraMinutesPaise: 0,
      periodStart,
      periodEnd,
    })
    .returning();

  // Credit minutes to tenant balance
  await db
    .update(tenantsTable)
    .set({
      minutesBalance: sql`${tenantsTable.minutesBalance} + ${config.monthlyMinutesQuota}`,
      updatedAt: new Date(),
    })
    .where(eq(tenantsTable.id, tenantId));

  if (adminUserId) {
    await createAuditLog({
      userId: adminUserId,
      action: "SUBSCRIPTION_CREATED",
      targetType: "tenant",
      targetId: tenantId,
      metadata: { planCostPaise: config.monthlyPlanCostPaise, includedMinutes: config.monthlyMinutesQuota },
    });
  }

  logger.info({ tenantId, subscriptionId: sub.id }, "Subscription created and minutes credited");
  return sub;
}

export async function activateSubscriptionAfterPayment(
  tenantId: number,
  paymentDetails: {
    razorpaySubscriptionId?: string;
    razorpayOrderId?: string;
    razorpayPaymentId?: string;
  }
) {
  const pricing = await db.select().from(pricingConfigTable).limit(1);
  const config = pricing[0];
  if (!config) throw new Error("Pricing config not found");

  const periodStart = new Date();
  const periodEnd = new Date(periodStart);
  periodEnd.setMonth(periodEnd.getMonth() + 1);

  // Expire current active subscriptions
  await db
    .update(subscriptionsTable)
    .set({ status: "expired", updatedAt: new Date() })
    .where(
      and(
        eq(subscriptionsTable.tenantId, tenantId),
        eq(subscriptionsTable.status, "active")
      )
    );

  const [sub] = await db
    .insert(subscriptionsTable)
    .values({
      tenantId,
      status: "active",
      planName: "monthly_2000",
      planCostPaise: config.monthlyPlanCostPaise,
      includedMinutes: config.monthlyMinutesQuota,
      usedMinutes: 0,
      extraMinutesPaise: 0,
      razorpaySubscriptionId: paymentDetails.razorpaySubscriptionId,
      razorpayOrderId: paymentDetails.razorpayOrderId,
      razorpayPaymentId: paymentDetails.razorpayPaymentId,
      periodStart,
      periodEnd,
    })
    .returning();

  await db
    .update(tenantsTable)
    .set({
      minutesBalance: sql`${tenantsTable.minutesBalance} + ${config.monthlyMinutesQuota}`,
      updatedAt: new Date(),
    })
    .where(eq(tenantsTable.id, tenantId));

  await createAuditLog({
    action: "SUBSCRIPTION_ACTIVATED_AFTER_PAYMENT",
    targetType: "tenant",
    targetId: tenantId,
    metadata: {
      ...paymentDetails,
      planCostPaise: config.monthlyPlanCostPaise,
      includedMinutes: config.monthlyMinutesQuota,
    },
  });

  logger.info({ tenantId, subscriptionId: sub.id, ...paymentDetails }, "Subscription activated after Razorpay payment");
  return sub;
}

export async function listSubscriptions(tenantId: number) {
  return db
    .select()
    .from(subscriptionsTable)
    .where(eq(subscriptionsTable.tenantId, tenantId))
    .orderBy(desc(subscriptionsTable.createdAt));
}

export async function getAllSubscriptions() {
  return db
    .select({
      id: subscriptionsTable.id,
      tenantId: subscriptionsTable.tenantId,
      tenantName: tenantsTable.name,
      tenantEmail: tenantsTable.email,
      status: subscriptionsTable.status,
      planName: subscriptionsTable.planName,
      planCostPaise: subscriptionsTable.planCostPaise,
      includedMinutes: subscriptionsTable.includedMinutes,
      usedMinutes: subscriptionsTable.usedMinutes,
      periodStart: subscriptionsTable.periodStart,
      periodEnd: subscriptionsTable.periodEnd,
      createdAt: subscriptionsTable.createdAt,
    })
    .from(subscriptionsTable)
    .leftJoin(tenantsTable, eq(subscriptionsTable.tenantId, tenantsTable.id))
    .orderBy(desc(subscriptionsTable.createdAt));
}
