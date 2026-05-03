import { pgTable, serial, integer, text, timestamp, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const subscriptionStatusEnum = [
  "active",
  "pending",
  "cancelled",
  "expired",
  "payment_failed",
] as const;
export type SubscriptionStatus = (typeof subscriptionStatusEnum)[number];

export const subscriptionsTable = pgTable("subscriptions", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull(),
  status: text("status").$type<SubscriptionStatus>().default("pending").notNull(),
  planName: text("plan_name").default("monthly_2000").notNull(),
  planCostPaise: integer("plan_cost_paise").default(200000).notNull(),
  includedMinutes: integer("included_minutes").default(400).notNull(),
  usedMinutes: integer("used_minutes").default(0).notNull(),
  extraMinutesPaise: integer("extra_minutes_paise").default(0).notNull(),
  razorpaySubscriptionId: text("razorpay_subscription_id"),
  razorpayOrderId: text("razorpay_order_id"),
  razorpayPaymentId: text("razorpay_payment_id"),
  periodStart: timestamp("period_start"),
  periodEnd: timestamp("period_end"),
  cancelledAt: timestamp("cancelled_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertSubscriptionSchema = createInsertSchema(subscriptionsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertSubscription = z.infer<typeof insertSubscriptionSchema>;
export type Subscription = typeof subscriptionsTable.$inferSelect;
