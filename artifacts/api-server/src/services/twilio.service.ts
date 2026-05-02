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
    statusCallbackEvent: ["initiated", "ringing", "answered", "completed", "no-answer", "busy", "failed"],
  });

  logger.info({ callSid: call.sid, leadId }, "Twilio call created");
  return call.sid;
}

/**
 * Initial TwiML — plays the agent's greeting then gathers speech.
 * audioId: key into the in-memory audio cache.
 */
export function generateInitialTwiML(
  leadId: number,
  callSid: string,
  audioId: string,
  language: string
): string {
  const audioUrl = `${config.baseUrl}/api/voice/audio/${audioId}`;
  const gatherAction = escapeUrl(
    `${config.baseUrl}/api/voice/gather?leadId=${leadId}&callSid=${encodeURIComponent(callSid)}&turn=0`
  );

  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" action="${gatherAction}" method="POST"
          language="${language}" speechTimeout="3" timeout="10"
          enhanced="true">
    <Play>${audioUrl}</Play>
  </Gather>
  <Hangup/>
</Response>`;
}

/**
 * Mid-conversation TwiML — plays agent response then gathers next speech.
 */
export function generateGatherTwiML(
  leadId: number,
  callSid: string,
  turn: number,
  audioId: string,
  language: string
): string {
  const audioUrl = `${config.baseUrl}/api/voice/audio/${audioId}`;
  const gatherAction = escapeUrl(
    `${config.baseUrl}/api/voice/gather?leadId=${leadId}&callSid=${encodeURIComponent(callSid)}&turn=${turn}`
  );

  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" action="${gatherAction}" method="POST"
          language="${language}" speechTimeout="3" timeout="10"
          enhanced="true">
    <Play>${audioUrl}</Play>
  </Gather>
  <Hangup/>
</Response>`;
}

/**
 * End-of-call TwiML — plays farewell and hangs up.
 */
export function generateEndCallTwiML(audioId: string): string {
  const audioUrl = `${config.baseUrl}/api/voice/audio/${audioId}`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${audioUrl}</Play>
  <Hangup/>
</Response>`;
}

/**
 * Fallback TwiML using Twilio <Say> when Sarvam TTS is unavailable.
 */
export function generateSayTwiML(
  text: string,
  language: string,
  leadId?: number,
  callSid?: string,
  turn?: number,
  isEnd = false
): string {
  const voice = language.startsWith("hi") ? "Polly.Aditi" : "Polly.Aditi";

  if (isEnd || leadId === undefined) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="${voice}" language="${language}">${escapeXml(text)}</Say>
  <Hangup/>
</Response>`;
  }

  const gatherAction = escapeUrl(
    `${config.baseUrl}/api/voice/gather?leadId=${leadId}&callSid=${encodeURIComponent(callSid ?? "")}&turn=${turn ?? 0}`
  );

  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" action="${gatherAction}" method="POST"
          language="${language}" speechTimeout="3" timeout="10"
          enhanced="true">
    <Say voice="${voice}" language="${language}">${escapeXml(text)}</Say>
  </Gather>
  <Hangup/>
</Response>`;
}

/** Escape text content for XML. */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Escape a URL for use in an XML attribute (& → &amp;). */
function escapeUrl(url: string): string {
  return url.replace(/&/g, "&amp;");
}

/**
 * Validate that an incoming request is genuinely from Twilio.
 */
export function validateTwilioSignature(
  url: string,
  params: Record<string, string>,
  signature: string
): boolean {
  if (!config.twilio.authToken) return true;
  try {
    return twilio.validateRequest(config.twilio.authToken, signature, url, params);
  } catch (err) {
    logger.warn({ err }, "Twilio signature validation threw");
    return false;
  }
}
