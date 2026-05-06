import { Router } from "express";
import { authMiddleware } from "../../middlewares/auth.js";
import { twilioValidate } from "../../middlewares/twilio-validate.js";
import {
  voiceWebhook,
  voiceGatherWebhook,
  voiceRespondWebhook,
  serveAudio,
  callStatusWebhook,
  initiateCallManually,
  listCalls,
  getCall,
  listCallsForLead,
} from "./calls.controller.js";

const router = Router();

// Twilio webhooks — signature-validated, no user auth
router.post("/voice", twilioValidate, voiceWebhook);
router.post("/voice/gather", twilioValidate, voiceGatherWebhook);
router.post("/voice/respond", twilioValidate, voiceRespondWebhook);
router.post("/call-status", twilioValidate, callStatusWebhook);

// Serve TTS audio blobs for Twilio <Play> — public, no auth (Twilio downloads these)
router.get("/voice/audio/:id", serveAudio);

// Authenticated call management
router.post("/call/initiate/:leadId", authMiddleware, initiateCallManually);
router.get("/calls", authMiddleware, listCalls);
router.get("/calls/:id", authMiddleware, getCall);

// Call history by lead
router.get("/leads/:leadId/calls", authMiddleware, listCallsForLead);

// NOTE: PATCH /calls/:id/outcome lives in `call-outcome.routes.ts` — that
// router has the full implementation (audit logging + lead-status update).
// Do NOT redefine it here, otherwise the first match wins and the audited
// version becomes unreachable.

export default router;
