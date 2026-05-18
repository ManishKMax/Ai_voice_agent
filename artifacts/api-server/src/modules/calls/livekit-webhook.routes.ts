import { Router, type IRouter, raw, type Request, type Response } from "express";
import { WebhookReceiver } from "livekit-server-sdk";
import { logger } from "../../lib/logger.js";
import { getLiveKitWebhookCreds } from "../../services/livekit.service.js";
import { handleCallStatusUpdate } from "./calls.service.js";

/**
 * LiveKit Cloud webhook receiver (Phase 2).
 *
 * LiveKit Cloud posts JSON-encoded `WebhookEvent` bodies signed via an
 * `Authorization` JWT header. We translate the lifecycle of a SIP
 * participant (the lead's PSTN leg, identity `sip-lead-<id>-...`) into
 * our existing CallStatus enum:
 *
 *   participant_joined  → "answered"
 *   participant_left    → "completed"   (then leadId is recovered from
 *                                        the participant metadata blob
 *                                        we set at dispatch time)
 *
 * Room-level events (room_started / room_finished) are logged for ops
 * but don't drive lead-state changes — those are participant-scoped.
 *
 * We accept raw bodies (Express `raw()` middleware here, since the
 * `WebhookReceiver` verifies the body bytes against the signature). The
 * route is mounted *before* the global JSON body parser at the
 * application level, but we also locally `raw()` here for safety.
 *
 * Configure in the LiveKit Cloud project console:
 *   Settings → Webhooks → URL = https://<host>/api/livekit/webhook
 * The signing key pair defaults to LIVEKIT_API_KEY/LIVEKIT_API_SECRET;
 * override via LIVEKIT_WEBHOOK_API_KEY / LIVEKIT_WEBHOOK_API_SECRET
 * if your project uses a dedicated webhook key.
 */
const router: IRouter = Router();

router.post(
  "/livekit/webhook",
  raw({ type: "*/*", limit: "1mb" }),
  async (req: Request, res: Response): Promise<void> => {
    // Always 200 — LiveKit retries non-2xx aggressively and we don't want
    // a parsing error to wedge their delivery queue. Failures are logged.
    try {
      const creds = getLiveKitWebhookCreds();
      if (!creds) {
        logger.warn("livekit_webhook_received_but_unconfigured");
        res.status(200).send("ok");
        return;
      }

      const bodyBuf = req.body as Buffer | undefined;
      if (!bodyBuf || bodyBuf.length === 0) {
        res.status(200).send("ok");
        return;
      }
      const bodyStr = bodyBuf.toString("utf8");
      const authHeader = req.header("authorization") ?? req.header("Authorization");

      const receiver = new WebhookReceiver(creds.apiKey, creds.apiSecret);
      let evt: Awaited<ReturnType<typeof receiver.receive>>;
      try {
        evt = await receiver.receive(bodyStr, authHeader);
      } catch (err) {
        logger.warn(
          { err: (err as Error).message },
          "livekit_webhook_signature_invalid",
        );
        res.status(200).send("ok");
        return;
      }

      const event = (evt as { event?: string }).event ?? "unknown";
      const room = (evt as { room?: { name?: string } }).room?.name ?? null;
      const participant = (evt as { participant?: { identity?: string; metadata?: string } }).participant;
      const identity = participant?.identity ?? null;

      // Only SIP participants drive lead-status updates. Identity prefix
      // is set in LiveKitProvider.initiateCall.
      const isSipLead = typeof identity === "string" && identity.startsWith("sip-lead-");

      logger.info(
        { event, room, identity, isSipLead },
        "livekit_webhook_event",
      );

      if (!isSipLead || !identity) {
        res.status(200).send("ok");
        return;
      }

      let leadId: number | null = null;
      if (participant?.metadata) {
        try {
          const meta = JSON.parse(participant.metadata) as { leadId?: number };
          if (typeof meta.leadId === "number") leadId = meta.leadId;
        } catch { /* metadata may not be JSON — ignore */ }
      }
      if (leadId == null) {
        // Fall back to parsing leadId from the identity (`sip-lead-<id>-<rand>`).
        const m = identity.match(/^sip-lead-(\d+)-/);
        if (m) leadId = Number(m[1]);
      }
      if (leadId == null) {
        logger.warn({ identity, event }, "livekit_webhook_no_lead_id");
        res.status(200).send("ok");
        return;
      }

      if (event === "participant_joined") {
        await handleCallStatusUpdate(identity, "answered", leadId);
      } else if (event === "participant_left" || event === "participant_connection_aborted") {
        // Duration is not in the participant_left payload; CallSession's
        // own end-of-call analytics row carries it. Pass 0 to keep the
        // call row schema-valid.
        await handleCallStatusUpdate(identity, "completed", leadId, 0);
      }

      res.status(200).send("ok");
    } catch (err) {
      logger.error(
        { err: (err as Error).message },
        "livekit_webhook_handler_failed",
      );
      res.status(200).send("ok");
    }
  },
);

export default router;
