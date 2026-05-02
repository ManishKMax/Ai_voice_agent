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
 *
 * Changes vs old version:
 * - callSid removed from action URL (Twilio always sends CallSid in POST body)
 * - enhanced="true" removed (adds latency, hurts Indian accent recognition)
 * - speechTimeout="auto" (ML-based end-of-speech, better for Indian accents)
 * - timeout="15" (more time for lead to start speaking after greeting)
 */
export function generateInitialTwiML(
  leadId: number,
  audioId: string,
  language: string
): string {
  const audioUrl = `${config.baseUrl}/api/voice/audio/${audioId}`;
  const gatherAction = escapeUrl(
    `${config.baseUrl}/api/voice/gather?leadId=${leadId}&turn=0`
  );

  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" action="${gatherAction}" method="POST"
          language="${language}" speechTimeout="auto" timeout="15"
          maxSpeechTime="15">
    <Play>${audioUrl}</Play>
  </Gather>
  <Hangup/>
</Response>`;
}

/**
 * Immediate filler TwiML — returned within milliseconds of receiving speech.
 * Plays a natural acknowledgement using Twilio's built-in Polly voice (no API call),
 * then redirects to /api/voice/respond where the real AI response is waiting.
 *
 * This eliminates dead-air silence during the 5-7 second AI + TTS processing window.
 */
export function generateFillerTwiML(
  leadId: number,
  turn: number,
  jobId: string,
  fillerText: string,
  language: string
): string {
  // Use Polly.Aditi for all Indian languages — she handles both English and Hindi
  const voice = "Polly.Aditi";

  const respondUrl = escapeUrl(
    `${config.baseUrl}/api/voice/respond?leadId=${leadId}&turn=${turn}&jobId=${jobId}`
  );

  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="${voice}" language="${language}">${escapeXml(fillerText)}</Say>
  <Redirect method="POST">${respondUrl}</Redirect>
</Response>`;
}

/**
 * Respond TwiML — served after the background AI job has finished.
 * Plays the Sarvam TTS audio then gathers the next speech turn.
 */
export function generateRespondTwiML(
  leadId: number,
  turn: number,
  audioId: string,
  language: string
): string {
  const audioUrl = `${config.baseUrl}/api/voice/audio/${audioId}`;
  const gatherAction = escapeUrl(
    `${config.baseUrl}/api/voice/gather?leadId=${leadId}&turn=${turn}`
  );

  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" action="${gatherAction}" method="POST"
          language="${language}" speechTimeout="auto" timeout="15"
          maxSpeechTime="15">
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
  turn?: number,
  isEnd = false
): string {
  const voice = "Polly.Aditi";

  if (isEnd || leadId === undefined) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="${voice}" language="${language}">${escapeXml(text)}</Say>
  <Hangup/>
</Response>`;
  }

  const gatherAction = escapeUrl(
    `${config.baseUrl}/api/voice/gather?leadId=${leadId}&turn=${turn ?? 0}`
  );

  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" action="${gatherAction}" method="POST"
          language="${language}" speechTimeout="auto" timeout="15"
          maxSpeechTime="15">
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
