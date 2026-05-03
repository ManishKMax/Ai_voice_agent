import { pgTable, serial, jsonb, timestamp } from "drizzle-orm/pg-core";

export interface StoredPlatformSettings {
  twilioAccountSid?: string;
  twilioAuthToken?: string;
  twilioPhoneNumber?: string;
  sarvamApiKey?: string;
  callRetries?: number;
  callHoursStart?: number;
  callHoursEnd?: number;
  retryDelay1?: number;
  retryDelay2?: number;
  retryDelay3?: number;
  webhookUrl?: string;
  webhookSecret?: string;
  smtpHost?: string;
  smtpPort?: number;
  smtpUser?: string;
  smtpPass?: string;
  smtpFrom?: string;
}

export const platformSettingsTable = pgTable("platform_settings", {
  id: serial("id").primaryKey(),
  settings: jsonb("settings").notNull().$type<StoredPlatformSettings>(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
