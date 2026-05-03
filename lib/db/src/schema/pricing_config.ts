import { pgTable, serial, integer, timestamp } from "drizzle-orm/pg-core";

export const pricingConfigTable = pgTable("pricing_config", {
  id: serial("id").primaryKey(),
  perMinuteRatePaise: integer("per_minute_rate_paise").default(500).notNull(),
  monthlyPlanCostPaise: integer("monthly_plan_cost_paise").default(200000).notNull(),
  trialCallsLimit: integer("trial_calls_limit").default(5).notNull(),
  monthlyMinutesQuota: integer("monthly_minutes_quota").default(400).notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type PricingConfig = typeof pricingConfigTable.$inferSelect;
