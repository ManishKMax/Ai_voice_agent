import type { Request, Response, NextFunction } from "express";
import twilio from "twilio";
import { config } from "../../config/index.js";
import {
  getMaskedSettings,
  updatePlatformSettings,
  platformSettings,
} from "../../config/platform.config.js";

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
    } = req.body;

    const patch: Record<string, unknown> = {};
    if (twilioAccountSid !== undefined && twilioAccountSid !== "") patch.twilioAccountSid = twilioAccountSid;
    if (twilioAuthToken  !== undefined && twilioAuthToken  !== "") patch.twilioAuthToken  = twilioAuthToken;
    if (twilioPhoneNumber !== undefined)                           patch.twilioPhoneNumber = twilioPhoneNumber;
    if (sarvamApiKey    !== undefined && sarvamApiKey    !== "") patch.sarvamApiKey     = sarvamApiKey;
    if (callRetries     !== undefined) patch.callRetries     = Number(callRetries);
    if (callHoursStart  !== undefined) patch.callHoursStart  = Number(callHoursStart);
    if (callHoursEnd    !== undefined) patch.callHoursEnd    = Number(callHoursEnd);

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
      return res.status(400).json({ success: false, message: "Twilio Account SID and Auth Token are required" });
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
      return res.status(400).json({ success: false, message: "Sarvam API Key is required" });
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
      return res.status(400).json({ success: false, message: `Sarvam API error (${response.status}): ${body.slice(0, 200)}` });
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
      return res.status(400).json({ success: false, message: "Twilio credentials not configured" });
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
