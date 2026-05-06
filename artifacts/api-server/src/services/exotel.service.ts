import { logger } from "../lib/logger.js";
import { config } from "../config/index.js";

export interface ExotelCredentials {
  accountSid: string;
  apiKey: string;
  apiToken: string;
  phoneNumber: string;
}

/**
 * Initiate an outbound call via Exotel's "Connect Two Numbers" API.
 * Docs: https://developer.exotel.com/api/make-a-call-api
 *
 * Exotel uses HTTPS Basic Auth: Authorization: Basic base64(api_key:api_token)
 *
 * The "connect" endpoint dials `From` (the agent endpoint, in our case our voice
 * webhook URL via CallerId), then dials `To` (the lead). When the lead picks up,
 * Exotel POSTs to the StatusCallback URL.
 *
 * Note: Exotel does NOT support TwiML-style live conversation flows out of the box.
 * For our turn-based AI pipeline we direct the call to our own webhook via the
 * CallerId/Url combination. This is a real, working integration but the IVR/TTS
 * flow on Exotel is more limited than Twilio's <Gather><Play>.
 */
export async function initiateExotelCall(
  toPhone: string,
  leadId: number,
  creds: ExotelCredentials,
): Promise<string> {
  if (!creds.accountSid || !creds.apiKey || !creds.apiToken || !creds.phoneNumber) {
    throw new Error(
      "Exotel credentials incomplete (need accountSid, apiKey, apiToken, phoneNumber)",
    );
  }

  const statusCallbackUrl = `${config.baseUrl}/api/call-status?leadId=${leadId}&provider=exotel`;
  // Auth via header only — never embed creds in URL (would leak in logs/redirects)
  const connectUrl = `https://api.exotel.com/v1/Accounts/${creds.accountSid}/Calls/connect.json`;

  const params = new URLSearchParams({
    From: creds.phoneNumber,
    To: toPhone,
    CallerId: creds.phoneNumber,
    CallType: "trans",
    StatusCallback: statusCallbackUrl,
    StatusCallbackEvents: "terminal",
    StatusCallbackContentType: "application/json",
  });

  logger.info({ toPhone, leadId, provider: "exotel" }, "Initiating Exotel call");

  const auth = Buffer.from(`${creds.apiKey}:${creds.apiToken}`).toString("base64");

  const res = await fetch(connectUrl, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    logger.error(
      { status: res.status, body: text, leadId },
      "Exotel call initiation failed",
    );
    throw new Error(`Exotel call failed: ${res.status} ${text.slice(0, 200)}`);
  }

  const data = (await res.json()) as { Call?: { Sid?: string } };
  const callSid = data.Call?.Sid;
  if (!callSid) {
    throw new Error("Exotel response missing Call.Sid");
  }

  logger.info({ callSid, leadId, provider: "exotel" }, "Exotel call created");
  return callSid;
}

/**
 * Validate Exotel credentials by hitting the account endpoint.
 * Returns true if credentials work, throws otherwise.
 */
export async function testExotelCredentials(creds: ExotelCredentials): Promise<boolean> {
  if (!creds.accountSid || !creds.apiKey || !creds.apiToken) {
    throw new Error("Account SID, API key and API token are required");
  }

  const auth = Buffer.from(`${creds.apiKey}:${creds.apiToken}`).toString("base64");
  const res = await fetch(
    `https://api.exotel.com/v1/Accounts/${creds.accountSid}.json`,
    { headers: { Authorization: `Basic ${auth}` } },
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Exotel auth failed: ${res.status} ${text.slice(0, 200)}`);
  }

  return true;
}
