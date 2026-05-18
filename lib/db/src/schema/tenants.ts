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
  // LiveKit SIP outbound (Phase 2). When telephonyProvider="livekit",
  // outbound PSTN calls are placed via LiveKit SIP trunks instead of Twilio.
  // Trunk provisioning is done by ops in the LiveKit Cloud dashboard; this
  // table only stores the resulting trunk ID + the "from" number to dial out
  // from. Both fields are optional — if unset, the platform-wide
  // LIVEKIT_SIP_TRUNK_ID / LIVEKIT_SIP_OUTBOUND_NUMBER env vars are used.
  livekitSipTrunkId: text("livekit_sip_trunk_id"),
  livekitSipOutboundNumber: text("livekit_sip_outbound_number"),
  minutesBalance: integer("minutes_balance").default(0).notNull(),
  sarvamEnabled: boolean("sarvam_enabled").default(false).notNull(),
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
  sarvamEnabled: true,
});

export type InsertTenant = z.infer<typeof insertTenantSchema>;
export type Tenant = typeof tenantsTable.$inferSelect;
