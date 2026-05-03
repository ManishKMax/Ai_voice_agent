import { db } from "@workspace/db";
import { platformSettingsTable, type StoredPlatformSettings } from "@workspace/db/schema";
import { config } from "./index.js";
import { logger } from "../lib/logger.js";
import { resetClient } from "../services/twilio.service.js";

export interface PlatformSettings {
  twilioAccountSid: string;
  twilioAuthToken: string;
  twilioPhoneNumber: string;
  sarvamApiKey: string;
  callRetries: number;
  callHoursStart: number;
  callHoursEnd: number;
  retryDelay1: number;
  retryDelay2: number;
  retryDelay3: number;
  webhookUrl: string;
  webhookSecret: string;
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPass: string;
  smtpFrom: string;
  sarvamEnabled: boolean;
  sarvamMaxUsers: number;
  razorpayKeyId: string;
  razorpayKeySecret: string;
  razorpayWebhookSecret: string;
}

export let platformSettings: PlatformSettings = buildDefaults();

function buildDefaults(): PlatformSettings {
  return {
    twilioAccountSid: config.twilio.accountSid,
    twilioAuthToken: config.twilio.authToken,
    twilioPhoneNumber: config.twilio.phoneNumber,
    sarvamApiKey: config.sarvam.apiKey,
    callRetries: 3,
    callHoursStart: 9,
    callHoursEnd: 20,
    retryDelay1: 30,
    retryDelay2: 120,
    retryDelay3: 1440,
    webhookUrl: "",
    webhookSecret: "",
    smtpHost: "",
    smtpPort: 587,
    smtpUser: "",
    smtpPass: "",
    smtpFrom: "",
    sarvamEnabled: true,
    sarvamMaxUsers: 50,
    razorpayKeyId: "",
    razorpayKeySecret: "",
    razorpayWebhookSecret: "",
  };
}

function applyToLiveConfig(s: PlatformSettings) {
  if (s.twilioAccountSid)  config.twilio.accountSid  = s.twilioAccountSid;
  if (s.twilioAuthToken)   config.twilio.authToken   = s.twilioAuthToken;
  if (s.twilioPhoneNumber) config.twilio.phoneNumber = s.twilioPhoneNumber;
  if (s.sarvamApiKey)      config.sarvam.apiKey      = s.sarvamApiKey;
  resetClient();
}

export async function loadPlatformSettings(): Promise<void> {
  try {
    const rows = await db.select().from(platformSettingsTable).limit(1);
    if (rows.length > 0 && rows[0].settings) {
      const s = rows[0].settings;
      platformSettings = {
        twilioAccountSid:       s.twilioAccountSid       ?? platformSettings.twilioAccountSid,
        twilioAuthToken:        s.twilioAuthToken        ?? platformSettings.twilioAuthToken,
        twilioPhoneNumber:      s.twilioPhoneNumber      ?? platformSettings.twilioPhoneNumber,
        sarvamApiKey:           s.sarvamApiKey           ?? platformSettings.sarvamApiKey,
        callRetries:            s.callRetries            ?? platformSettings.callRetries,
        callHoursStart:         s.callHoursStart         ?? platformSettings.callHoursStart,
        callHoursEnd:           s.callHoursEnd           ?? platformSettings.callHoursEnd,
        retryDelay1:            s.retryDelay1            ?? platformSettings.retryDelay1,
        retryDelay2:            s.retryDelay2            ?? platformSettings.retryDelay2,
        retryDelay3:            s.retryDelay3            ?? platformSettings.retryDelay3,
        webhookUrl:             s.webhookUrl             ?? platformSettings.webhookUrl,
        webhookSecret:          s.webhookSecret          ?? platformSettings.webhookSecret,
        smtpHost:               s.smtpHost               ?? platformSettings.smtpHost,
        smtpPort:               s.smtpPort               ?? platformSettings.smtpPort,
        smtpUser:               s.smtpUser               ?? platformSettings.smtpUser,
        smtpPass:               s.smtpPass               ?? platformSettings.smtpPass,
        smtpFrom:               s.smtpFrom               ?? platformSettings.smtpFrom,
        sarvamEnabled:          s.sarvamEnabled          ?? platformSettings.sarvamEnabled,
        sarvamMaxUsers:         s.sarvamMaxUsers         ?? platformSettings.sarvamMaxUsers,
        razorpayKeyId:          s.razorpayKeyId          ?? platformSettings.razorpayKeyId,
        razorpayKeySecret:      s.razorpayKeySecret      ?? platformSettings.razorpayKeySecret,
        razorpayWebhookSecret:  s.razorpayWebhookSecret  ?? platformSettings.razorpayWebhookSecret,
      };
      applyToLiveConfig(platformSettings);
      logger.info(
        {
          twilioConfigured: !!platformSettings.twilioAccountSid,
          sarvamConfigured: !!platformSettings.sarvamApiKey,
          sarvamEnabled: platformSettings.sarvamEnabled,
          sarvamMaxUsers: platformSettings.sarvamMaxUsers,
        },
        "Platform settings loaded from DB"
      );
    }
  } catch (err) {
    logger.warn({ err }, "Failed to load platform settings from DB — using env defaults");
  }
}

export async function updatePlatformSettings(patch: Partial<PlatformSettings>): Promise<PlatformSettings> {
  platformSettings = { ...platformSettings, ...patch };

  const toStore: StoredPlatformSettings = {
    twilioAccountSid:       platformSettings.twilioAccountSid       || undefined,
    twilioAuthToken:        platformSettings.twilioAuthToken        || undefined,
    twilioPhoneNumber:      platformSettings.twilioPhoneNumber      || undefined,
    sarvamApiKey:           platformSettings.sarvamApiKey           || undefined,
    callRetries:            platformSettings.callRetries,
    callHoursStart:         platformSettings.callHoursStart,
    callHoursEnd:           platformSettings.callHoursEnd,
    retryDelay1:            platformSettings.retryDelay1,
    retryDelay2:            platformSettings.retryDelay2,
    retryDelay3:            platformSettings.retryDelay3,
    webhookUrl:             platformSettings.webhookUrl             || undefined,
    webhookSecret:          platformSettings.webhookSecret          || undefined,
    smtpHost:               platformSettings.smtpHost               || undefined,
    smtpPort:               platformSettings.smtpPort               || undefined,
    smtpUser:               platformSettings.smtpUser               || undefined,
    smtpPass:               platformSettings.smtpPass               || undefined,
    smtpFrom:               platformSettings.smtpFrom               || undefined,
    sarvamEnabled:          platformSettings.sarvamEnabled,
    sarvamMaxUsers:         platformSettings.sarvamMaxUsers,
    razorpayKeyId:          platformSettings.razorpayKeyId          || undefined,
    razorpayKeySecret:      platformSettings.razorpayKeySecret      || undefined,
    razorpayWebhookSecret:  platformSettings.razorpayWebhookSecret  || undefined,
  };

  const rows = await db.select({ id: platformSettingsTable.id }).from(platformSettingsTable).limit(1);
  if (rows.length > 0) {
    await db.update(platformSettingsTable).set({ settings: toStore, updatedAt: new Date() });
  } else {
    await db.insert(platformSettingsTable).values({ settings: toStore });
  }

  applyToLiveConfig(platformSettings);
  logger.info("Platform settings updated and applied");
  return platformSettings;
}

export function maskSecret(value: string): string {
  if (!value) return "";
  if (value.length <= 4) return "•".repeat(value.length);
  return "•".repeat(Math.min(value.length - 4, 16)) + value.slice(-4);
}

export function getMaskedSettings() {
  return {
    twilioAccountSid:       platformSettings.twilioAccountSid       ? maskSecret(platformSettings.twilioAccountSid)       : "",
    twilioAuthToken:        platformSettings.twilioAuthToken        ? maskSecret(platformSettings.twilioAuthToken)        : "",
    twilioPhoneNumber:      platformSettings.twilioPhoneNumber      ?? "",
    sarvamApiKey:           platformSettings.sarvamApiKey           ? maskSecret(platformSettings.sarvamApiKey)           : "",
    callRetries:            platformSettings.callRetries,
    callHoursStart:         platformSettings.callHoursStart,
    callHoursEnd:           platformSettings.callHoursEnd,
    retryDelay1:            platformSettings.retryDelay1,
    retryDelay2:            platformSettings.retryDelay2,
    retryDelay3:            platformSettings.retryDelay3,
    webhookUrl:             platformSettings.webhookUrl             ?? "",
    webhookSecret:          platformSettings.webhookSecret          ? maskSecret(platformSettings.webhookSecret)          : "",
    smtpHost:               platformSettings.smtpHost               ?? "",
    smtpPort:               platformSettings.smtpPort               ?? 587,
    smtpUser:               platformSettings.smtpUser               ?? "",
    smtpPass:               platformSettings.smtpPass               ? maskSecret(platformSettings.smtpPass)               : "",
    smtpFrom:               platformSettings.smtpFrom               ?? "",
    sarvamEnabled:          platformSettings.sarvamEnabled,
    sarvamMaxUsers:         platformSettings.sarvamMaxUsers,
    razorpayKeyId:          platformSettings.razorpayKeyId          ? maskSecret(platformSettings.razorpayKeyId)          : "",
    razorpayKeySecret:      platformSettings.razorpayKeySecret      ? maskSecret(platformSettings.razorpayKeySecret)      : "",
    razorpayWebhookSecret:  platformSettings.razorpayWebhookSecret  ? maskSecret(platformSettings.razorpayWebhookSecret)  : "",
    twilioConnected:        !!(platformSettings.twilioAccountSid && platformSettings.twilioAuthToken),
    sarvamConnected:        !!platformSettings.sarvamApiKey,
    webhookConfigured:      !!platformSettings.webhookUrl,
    smtpConfigured:         !!(platformSettings.smtpHost && platformSettings.smtpUser && platformSettings.smtpPass),
    razorpayConfigured:     !!(platformSettings.razorpayKeyId && platformSettings.razorpayKeySecret),
  };
}
