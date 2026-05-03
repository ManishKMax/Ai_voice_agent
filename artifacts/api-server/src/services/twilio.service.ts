import twilio from "twilio";
import { config } from "../config/index.js";
import { logger } from "../lib/logger.js";

let _client: ReturnType<typeof twilio> | null = null;

export function resetClient() {
  _client = null;
}

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
    machineDetection: "Enable",
    machineDetectionTimeout: 5,
    asyncAmdStatusCallback: statusCallbackUrl,
    asyncAmdStatusCallbackMethod: "POST",
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

  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech dtmf" action="${gatherAction}" method="POST"
          language="${language}" speechTimeout="auto" timeout="15"
          maxSpeechTime="15" finishOnKey="">
    <Play>${audioUrl}</Play>
  </Gather>
  <Hangup/>
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
          language="${language}" speechTimeout="auto" timeout="15"
          maxSpeechTime="15" finishOnKey="">
    <Play>${audioUrl}</Play>
  </Gather>
  <Hangup/>
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
          language="${language}" speechTimeout="auto" timeout="15"
          maxSpeechTime="15" finishOnKey="">
    <Say voice="${voice}" language="${language}">${escapeXml(text)}</Say>
  </Gather>
  <Hangup/>
</Response>`;
}

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
