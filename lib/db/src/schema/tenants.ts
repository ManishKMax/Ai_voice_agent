import { pgTable, serial, text, integer, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const tenantKycStatusEnum = ["pending", "submitted", "approved", "rejected"] as const;
export type TenantKycStatus = (typeof tenantKycStatusEnum)[number];

export const tenantTypeEnum = ["individual", "business"] as const;
export type TenantType = (typeof tenantTypeEnum)[number];

export const tenantsTable = pgTable("tenants", {
  id: serial("id").primaryKey(),
  clerkUserId: text("clerk_user_id").notNull().unique(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  type: text("type").$type<TenantType>().default("individual").notNull(),
  kycStatus: text("kyc_status").$type<TenantKycStatus>().default("pending").notNull(),
  trialCallsUsed: integer("trial_calls_used").default(0).notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  telephonyProvider: text("telephony_provider"),
  twilioAccountSid: text("twilio_account_sid"),
  twilioAuthToken: text("twilio_auth_token"),
  twilioPhoneNumber: text("twilio_phone_number"),
  exotelAccountSid: text("exotel_account_sid"),
  exotelApiKey: text("exotel_api_key"),
  exotelApiToken: text("exotel_api_token"),
  exotelPhoneNumber: text("exotel_phone_number"),
  minutesBalance: integer("minutes_balance").default(0).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertTenantSchema = createInsertSchema(tenantsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  kycStatus: true,
  trialCallsUsed: true,
  isActive: true,
  minutesBalance: true,
});

export type InsertTenant = z.infer<typeof insertTenantSchema>;
export type Tenant = typeof tenantsTable.$inferSelect;
