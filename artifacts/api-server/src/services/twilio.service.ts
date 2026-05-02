import twilio from "twilio";
import { config } from "../config/index.js";
import { logger } from "../lib/logger.js";

let _client: ReturnType<typeof twilio> | null = null;

function getClient() {
  if (!_client) {
    if (!config.twilio.accountSid || !config.twilio.authToken) {
      throw new Error("Twilio credentials are not configured (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN)");
    }
    _client = twilio(config.twilio.accountSid, config.twilio.authToken);
  }
  return _client;
}

export async function initiateCall(toPhone: string, leadId: number): Promise<string> {
  if (!config.twilio.phoneNumber) {
    throw new Error("TWILIO_PHONE_NUMBER is not configured");
  }

  const voiceUrl = `${config.baseUrl}/api/voice?leadId=${leadId}`;
  const statusCallbackUrl = `${config.baseUrl}/api/call-status?leadId=${leadId}`;

  logger.info({ toPhone, leadId, voiceUrl }, "Initiating Twilio call");

  const call = await getClient().calls.create({
    to: toPhone,
    from: config.twilio.phoneNumber,
    url: voiceUrl,
    statusCallback: statusCallbackUrl,
    statusCallbackMethod: "POST",
    // Include all terminal and intermediate statuses
    statusCallbackEvent: ["initiated", "ringing", "answered", "completed", "no-answer", "busy", "failed"],
  });

  logger.info({ callSid: call.sid, leadId }, "Twilio call created");
  return call.sid;
}

export function generateTwiML(leadId: number): string {
  const wsUrl = config.baseUrl
    .replace("https://", "wss://")
    .replace("http://", "ws://");

  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}/api/media-stream?leadId=${leadId}" />
  </Connect>
</Response>`;
}

/**
 * Validate that an incoming request is genuinely from Twilio.
 * Returns true if valid, false if the signature check fails.
 * In dev (no auth token) this always returns true.
 */
export function validateTwilioSignature(
  url: string,
  params: Record<string, string>,
  signature: string
): boolean {
  if (!config.twilio.authToken) return true; // can't validate without token
  try {
    return twilio.validateRequest(config.twilio.authToken, signature, url, params);
  } catch (err) {
    logger.warn({ err }, "Twilio signature validation threw");
    return false;
  }
}
