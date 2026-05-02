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
}

/** Current runtime settings — loaded from DB on startup, updated on PATCH. */
export let platformSettings: PlatformSettings = buildDefaults();

function buildDefaults(): PlatformSettings {
  return {
    twilioAccountSid: config.twilio.accountSid,
    twilioAuthToken: config.twilio.authToken,
    twilioPhoneNumber: config.twilio.phoneNumber,
    sarvamApiKey: config.sarvam.apiKey,
    callRetries: 1,
    callHoursStart: 9,
    callHoursEnd: 20,
  };
}

/** Sync the live config object so all services pick up new credentials. */
function applyToLiveConfig(s: PlatformSettings) {
  if (s.twilioAccountSid)  config.twilio.accountSid  = s.twilioAccountSid;
  if (s.twilioAuthToken)   config.twilio.authToken   = s.twilioAuthToken;
  if (s.twilioPhoneNumber) config.twilio.phoneNumber = s.twilioPhoneNumber;
  if (s.sarvamApiKey)      config.sarvam.apiKey      = s.sarvamApiKey;
  resetClient();
}

/**
 * Load persisted platform settings from DB on startup.
 * Overrides env-var defaults wherever a DB value exists.
 */
export async function loadPlatformSettings(): Promise<void> {
  try {
    const rows = await db.select().from(platformSettingsTable).limit(1);
    if (rows.length > 0 && rows[0].settings) {
      const s = rows[0].settings;
      platformSettings = {
        twilioAccountSid:  s.twilioAccountSid  ?? platformSettings.twilioAccountSid,
        twilioAuthToken:   s.twilioAuthToken   ?? platformSettings.twilioAuthToken,
        twilioPhoneNumber: s.twilioPhoneNumber ?? platformSettings.twilioPhoneNumber,
        sarvamApiKey:      s.sarvamApiKey      ?? platformSettings.sarvamApiKey,
        callRetries:       s.callRetries       ?? platformSettings.callRetries,
        callHoursStart:    s.callHoursStart    ?? platformSettings.callHoursStart,
        callHoursEnd:      s.callHoursEnd      ?? platformSettings.callHoursEnd,
      };
      applyToLiveConfig(platformSettings);
      logger.info(
        { twilioConfigured: !!platformSettings.twilioAccountSid, sarvamConfigured: !!platformSettings.sarvamApiKey },
        "Platform settings loaded from DB"
      );
    }
  } catch (err) {
    logger.warn({ err }, "Failed to load platform settings from DB — using env defaults");
  }
}

/**
 * Persist updated settings to DB and apply immediately to all running services.
 */
export async function updatePlatformSettings(patch: Partial<PlatformSettings>): Promise<PlatformSettings> {
  platformSettings = { ...platformSettings, ...patch };

  const toStore: StoredPlatformSettings = {
    twilioAccountSid:  platformSettings.twilioAccountSid  || undefined,
    twilioAuthToken:   platformSettings.twilioAuthToken   || undefined,
    twilioPhoneNumber: platformSettings.twilioPhoneNumber || undefined,
    sarvamApiKey:      platformSettings.sarvamApiKey      || undefined,
    callRetries:       platformSettings.callRetries,
    callHoursStart:    platformSettings.callHoursStart,
    callHoursEnd:      platformSettings.callHoursEnd,
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

/** Mask a sensitive string: show only last 4 chars. */
export function maskSecret(value: string): string {
  if (!value) return "";
  if (value.length <= 4) return "•".repeat(value.length);
  return "•".repeat(Math.min(value.length - 4, 16)) + value.slice(-4);
}

/** Return settings with sensitive values masked for API responses. */
export function getMaskedSettings() {
  return {
    twilioAccountSid:  platformSettings.twilioAccountSid  ? maskSecret(platformSettings.twilioAccountSid)  : "",
    twilioAuthToken:   platformSettings.twilioAuthToken   ? maskSecret(platformSettings.twilioAuthToken)   : "",
    twilioPhoneNumber: platformSettings.twilioPhoneNumber ?? "",
    sarvamApiKey:      platformSettings.sarvamApiKey      ? maskSecret(platformSettings.sarvamApiKey)      : "",
    callRetries:       platformSettings.callRetries,
    callHoursStart:    platformSettings.callHoursStart,
    callHoursEnd:      platformSettings.callHoursEnd,
    twilioConnected:   !!(platformSettings.twilioAccountSid && platformSettings.twilioAuthToken),
    sarvamConnected:   !!platformSettings.sarvamApiKey,
  };
}
