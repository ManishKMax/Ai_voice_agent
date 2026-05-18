import { Router, type IRouter, type Request, type Response } from "express";
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
 * Signature verification needs the *raw* request body bytes (the JWT
 * payload includes the SHA256 of the body). The global `express.json()`
 * middleware in `app.ts` already captures the raw bytes into
 * `req.rawBody` via its `verify` hook, so we consume that buffer here
 * rather than installing a second body parser (which would race with
 * the JSON parser and yield either an empty buffer or a parsed object,
 * silently failing every signature check). If `rawBody` is missing —
 * non-JSON content type, or app.ts changes — we fall back to
 * re-serialising `req.body`, which works because LiveKit's JWT
 * canonicalises the body before hashing.
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
  async (req: Request & { rawBody?: Buffer }, res: Response): Promise<void> => {
    // Always 200 — LiveKit retries non-2xx aggressively and we don't want
    // a parsing error to wedge their delivery queue. Failures are logged.
    try {
      const creds = getLiveKitWebhookCreds();
      if (!creds) {
        logger.warn("livekit_webhook_received_but_unconfigured");
        res.status(200).send("ok");
        return;
      }

      // Prefer raw bytes captured by the global express.json() verify hook
      // in app.ts. Fall back to re-stringifying req.body if missing (e.g.
      // non-JSON content type, or middleware order changed).
      let bodyStr: string;
      if (req.rawBody && req.rawBody.length > 0) {
        bodyStr = req.rawBody.toString("utf8");
      } else if (req.body && Object.keys(req.body as object).length > 0) {
        bodyStr = JSON.stringify(req.body);
        logger.warn("livekit_webhook_using_reserialized_body");
      } else {
        res.status(200).send("ok");
        return;
      }
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
