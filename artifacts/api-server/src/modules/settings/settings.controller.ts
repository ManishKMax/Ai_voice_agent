import type { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import twilio from "twilio";
import { db } from "@workspace/db";
import { apiKeysTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { config } from "../../config/index.js";
import {
  getMaskedSettings,
  updatePlatformSettings,
  platformSettings,
} from "../../config/platform.config.js";
import { hashApiKey } from "../../middlewares/apikey.js";
import { sendTestEmail } from "../../services/email.service.js";

export async function getSettings(req: Request, res: Response, next: NextFunction) {
  try {
    res.json({ success: true, data: getMaskedSettings() });
  } catch (err) {
    next(err);
  }
}

export async function patchSettings(req: Request, res: Response, next: NextFunction) {
  try {
    const {
      twilioAccountSid,
      twilioAuthToken,
      twilioPhoneNumber,
      sarvamApiKey,
      callRetries,
      callHoursStart,
      callHoursEnd,
      retryDelay1,
      retryDelay2,
      retryDelay3,
      webhookUrl,
      webhookSecret,
    } = req.body;

    const patch: Record<string, unknown> = {};
    const {
      smtpHost,
      smtpPort,
      smtpUser,
      smtpPass,
      smtpFrom,
    } = req.body;

    if (twilioAccountSid !== undefined && twilioAccountSid !== "") patch.twilioAccountSid = twilioAccountSid;
    if (twilioAuthToken  !== undefined && twilioAuthToken  !== "") patch.twilioAuthToken  = twilioAuthToken;
    if (twilioPhoneNumber !== undefined)                           patch.twilioPhoneNumber = twilioPhoneNumber;
    if (sarvamApiKey     !== undefined && sarvamApiKey     !== "") patch.sarvamApiKey     = sarvamApiKey;
    if (callRetries      !== undefined) patch.callRetries     = Number(callRetries);
    if (callHoursStart   !== undefined) patch.callHoursStart  = Number(callHoursStart);
    if (callHoursEnd     !== undefined) patch.callHoursEnd    = Number(callHoursEnd);
    if (retryDelay1      !== undefined) patch.retryDelay1     = Number(retryDelay1);
    if (retryDelay2      !== undefined) patch.retryDelay2     = Number(retryDelay2);
    if (retryDelay3      !== undefined) patch.retryDelay3     = Number(retryDelay3);
    if (webhookUrl       !== undefined) patch.webhookUrl      = webhookUrl;
    if (webhookSecret    !== undefined && webhookSecret !== "") patch.webhookSecret = webhookSecret;
    if (smtpHost !== undefined) patch.smtpHost = smtpHost;
    if (smtpPort !== undefined) patch.smtpPort = Number(smtpPort);
    if (smtpUser !== undefined) patch.smtpUser = smtpUser;
    if (smtpPass !== undefined && smtpPass !== "") patch.smtpPass = smtpPass;
    if (smtpFrom !== undefined) patch.smtpFrom = smtpFrom;

    await updatePlatformSettings(patch as Parameters<typeof updatePlatformSettings>[0]);
    res.json({ success: true, data: getMaskedSettings() });
  } catch (err) {
    next(err);
  }
}

export async function testTwilio(req: Request, res: Response, next: NextFunction) {
  try {
    const sid   = (req.body.twilioAccountSid  as string | undefined) || platformSettings.twilioAccountSid;
    const token = (req.body.twilioAuthToken   as string | undefined) || platformSettings.twilioAuthToken;

    if (!sid || !token) {
      res.status(400).json({ success: false, message: "Twilio Account SID and Auth Token are required" });
      return;
    }

    const client = twilio(sid, token);
    const account = await client.api.accounts(sid).fetch();

    res.json({
      success: true,
      message: `Connected to Twilio account: ${account.friendlyName}`,
      accountName: account.friendlyName,
      accountStatus: account.status,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Connection failed";
    res.status(400).json({ success: false, message: `Twilio connection failed: ${msg}` });
  }
}

export async function testSarvam(req: Request, res: Response, next: NextFunction) {
  try {
    const apiKey = (req.body.sarvamApiKey as string | undefined) || platformSettings.sarvamApiKey;

    if (!apiKey) {
      res.status(400).json({ success: false, message: "Sarvam API Key is required" });
      return;
    }

    const response = await fetch("https://api.sarvam.ai/text-to-speech", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-subscription-key": apiKey,
      },
      body: JSON.stringify({
        inputs: ["Test"],
        target_language_code: "en-IN",
        speaker: "priya",
        model: "bulbul:v3",
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      res.status(400).json({ success: false, message: `Sarvam API error (${response.status}): ${body.slice(0, 200)}` });
      return;
    }

    res.json({ success: true, message: "Sarvam AI connected successfully" });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Connection failed";
    res.status(400).json({ success: false, message: `Sarvam connection failed: ${msg}` });
  }
}

export async function getTwilioNumbers(req: Request, res: Response, next: NextFunction) {
  try {
    const sid   = platformSettings.twilioAccountSid;
    const token = platformSettings.twilioAuthToken;

    if (!sid || !token) {
      res.status(400).json({ success: false, message: "Twilio credentials not configured" });
      return;
    }

    const client = twilio(sid, token);
    const numbers = await client.incomingPhoneNumbers.list({ limit: 20 });

    res.json({
      success: true,
      data: numbers.map((n) => ({
        phoneNumber: n.phoneNumber,
        friendlyName: n.friendlyName,
        sid: n.sid,
      })),
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Failed to fetch numbers";
    res.status(400).json({ success: false, message: msg });
  }
}

export async function getWebhookInfo(_req: Request, res: Response) {
  res.json({
    success: true,
    data: {
      baseUrl: config.baseUrl,
      voiceWebhookUrl: `${config.baseUrl}/api/voice`,
      statusCallbackUrl: `${config.baseUrl}/api/call-status`,
      note: "Configure your Twilio phone number's Voice webhook to this URL for inbound calls. Outbound calls configure the webhook automatically.",
    },
  });
}

export async function testWebhook(req: Request, res: Response, next: NextFunction) {
  try {
    const url = (req.body.webhookUrl as string | undefined) || platformSettings.webhookUrl;
    if (!url) {
      res.status(400).json({ success: false, message: "No webhook URL configured" });
      return;
    }

    const payload = JSON.stringify({
      event: "webhook.test",
      timestamp: new Date().toISOString(),
      message: "This is a test payload from Lead Caller",
    });

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": "LeadCaller-Webhook/1.0",
      "X-Webhook-Event": "webhook.test",
    };

    const secret = platformSettings.webhookSecret;
    if (secret) {
      const sig = crypto.createHmac("sha256", secret).update(payload).digest("hex");
      headers["X-Webhook-Signature"] = `sha256=${sig}`;
    }

    const resp = await fetch(url, {
      method: "POST",
      headers,
      body: payload,
      signal: AbortSignal.timeout(8000),
    });

    res.json({
      success: resp.ok,
      message: resp.ok
        ? `Webhook delivered successfully (HTTP ${resp.status})`
        : `Webhook returned HTTP ${resp.status}`,
      statusCode: resp.status,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Delivery failed";
    res.status(400).json({ success: false, message: `Webhook test failed: ${msg}` });
  }
}

export async function testEmail(req: Request, res: Response, next: NextFunction) {
  try {
    const to = req.body.to as string | undefined;
    if (!to || !to.includes("@")) {
      res.status(400).json({ success: false, message: "A valid recipient email address is required" });
      return;
    }
    await sendTestEmail(to);
    res.json({ success: true, message: `Test email sent to ${to}` });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Failed to send test email";
    res.status(400).json({ success: false, message: msg });
  }
}

export async function listApiKeys(_req: Request, res: Response, next: NextFunction) {
  try {
    const keys = await db
      .select({
        id: apiKeysTable.id,
        name: apiKeysTable.name,
        keyPrefix: apiKeysTable.keyPrefix,
        createdAt: apiKeysTable.createdAt,
        lastUsedAt: apiKeysTable.lastUsedAt,
      })
      .from(apiKeysTable)
      .orderBy(apiKeysTable.createdAt);
    res.json({ success: true, data: keys });
  } catch (err) {
    next(err);
  }
}

export async function createApiKey(req: Request, res: Response, next: NextFunction) {
  try {
    const { name } = req.body;
    if (!name || typeof name !== "string") {
      res.status(400).json({ success: false, message: "name is required" });
      return;
    }

    const rawKey = `lc_${crypto.randomBytes(24).toString("hex")}`;
    const keyHash = hashApiKey(rawKey);
    const keyPrefix = rawKey.slice(0, 8);

    const [key] = await db
      .insert(apiKeysTable)
      .values({ name, keyHash, keyPrefix })
      .returning();

    res.status(201).json({
      success: true,
      data: {
        id: key.id,
        name: key.name,
        keyPrefix: key.keyPrefix,
        createdAt: key.createdAt,
        key: rawKey,
      },
      message: "Copy this key now — it will not be shown again.",
    });
  } catch (err) {
    next(err);
  }
}

export async function deleteApiKey(req: Request, res: Response, next: NextFunction) {
  try {
    const id = parseInt(req.params.keyId as string);
    await db.delete(apiKeysTable).where(eq(apiKeysTable.id, id));
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
}
