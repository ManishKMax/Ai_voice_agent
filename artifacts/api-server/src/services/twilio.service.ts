import twilio from "twilio";
import { config } from "../config/index.js";
import { logger } from "../lib/logger.js";

const client = twilio(config.twilio.accountSid, config.twilio.authToken);

export async function initiateCall(toPhone: string, leadId: number): Promise<string> {
  const voiceUrl = `${config.baseUrl}/api/voice?leadId=${leadId}`;
  const statusCallbackUrl = `${config.baseUrl}/api/call-status?leadId=${leadId}`;

  logger.info({ toPhone, leadId, voiceUrl }, "Initiating Twilio call");

  const call = await client.calls.create({
    to: toPhone,
    from: config.twilio.phoneNumber,
    url: voiceUrl,
    statusCallback: statusCallbackUrl,
    statusCallbackMethod: "POST",
    statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
  });

  logger.info({ callSid: call.sid, leadId }, "Call initiated");
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
