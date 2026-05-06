import twilio from "twilio";
import { config } from "../config/index.js";
import { logger } from "../lib/logger.js";

let _client: ReturnType<typeof twilio> | null = null;

export interface TwilioCredentials {
  accountSid: string;
  authToken: string;
  phoneNumber: string;
}

export function resetClient() {
  _client = null;
}

function getClient(creds?: TwilioCredentials) {
  if (creds) {
    return twilio(creds.accountSid, creds.authToken);
  }
  if (!_client) {
    if (!config.twilio.accountSid || !config.twilio.authToken) {
      throw new Error("Twilio credentials are not configured (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN)");
    }
    _client = twilio(config.twilio.accountSid, config.twilio.authToken);
  }
  return _client;
}

export async function initiateCall(
  toPhone: string,
  leadId: number,
  creds?: TwilioCredentials,
): Promise<string> {
  const fromNumber = creds?.phoneNumber || config.twilio.phoneNumber;
  if (!fromNumber) {
    throw new Error("TWILIO_PHONE_NUMBER is not configured");
  }

  const voiceUrl = `${config.baseUrl}/api/voice?leadId=${leadId}`;
  const statusCallbackUrl = `${config.baseUrl}/api/call-status?leadId=${leadId}`;

  logger.info(
    { toPhone, leadId, voiceUrl, perTenant: !!creds },
    "Initiating Twilio call",
  );

  // NOTE: Machine detection is intentionally DISABLED.
  // Twilio's AMD frequently false-positives on real humans who answer with
  // a short "hello" (especially Indian numbers), causing the AI to abandon
  // a real conversation. We rely on the conversation flow to detect end
  // of call instead.
  const call = await getClient(creds).calls.create({
    to: toPhone,
    from: fromNumber,
    url: voiceUrl,
    statusCallback: statusCallbackUrl,
    statusCallbackMethod: "POST",
    statusCallbackEvent: ["initiated", "ringing", "answered", "completed", "no-answer", "busy", "failed"],
  });

  logger.info({ callSid: call.sid, leadId }, "Twilio call created");
  return call.sid;
}

export function generateInitialTwiML(
  leadId: number,
  audioId: string,
  language: string
): string {
  const audioUrl = `${config.baseUrl}/api/voice/audio/${audioId}`;
  const gatherAction = escapeUrl(
    `${config.baseUrl}/api/voice/gather?leadId=${leadId}&turn=0`
  );

  // CRITICAL: actionOnEmptyResult="true" so the gather webhook is invoked
  // even when the caller stays silent past the timeout. Without it, Twilio
  // silently falls through to the next verb (which used to be <Hangup/>),
  // cutting the call instead of giving us a chance to re-prompt.
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech dtmf" action="${gatherAction}" method="POST"
          language="${language}" speechTimeout="auto" timeout="10"
          maxSpeechTime="20" finishOnKey=""
          speechModel="phone_call" enhanced="true"
          actionOnEmptyResult="true"
          hints="${SPEECH_HINTS}">
    <Play>${audioUrl}</Play>
  </Gather>
</Response>`;
}

export function generateFillerTwiML(
  leadId: number,
  turn: number,
  jobId: string,
  fillerText: string,
  language: string
): string {
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
  <Gather input="speech dtmf" action="${gatherAction}" method="POST"
          language="${language}" speechTimeout="auto" timeout="10"
          maxSpeechTime="20" finishOnKey=""
          speechModel="phone_call" enhanced="true"
          actionOnEmptyResult="true"
          hints="${SPEECH_HINTS}">
    <Play>${audioUrl}</Play>
  </Gather>
</Response>`;
}

export function generateEndCallTwiML(audioId: string): string {
  const audioUrl = `${config.baseUrl}/api/voice/audio/${audioId}`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${audioUrl}</Play>
  <Hangup/>
</Response>`;
}

export function generateVoicemailTwiML(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Hangup/>
</Response>`;
}

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
  <Gather input="speech dtmf" action="${gatherAction}" method="POST"
          language="${language}" speechTimeout="auto" timeout="10"
          maxSpeechTime="20" finishOnKey=""
          speechModel="phone_call" enhanced="true"
          actionOnEmptyResult="true"
          hints="${SPEECH_HINTS}">
    <Say voice="${voice}" language="${language}">${escapeXml(text)}</Say>
  </Gather>
</Response>`;
}

const SPEECH_HINTS = [
  "yes", "no", "haan", "nahi", "interested", "not interested",
  "tell me more", "send details", "call me later", "busy", "okay", "sure",
  "CRM", "demo", "price", "cost", "trial", "schedule", "meeting",
  "WhatsApp", "email", "rupees", "lakh", "crore",
].join(",");

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function escapeUrl(url: string): string {
  return url.replace(/&/g, "&amp;");
}

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
