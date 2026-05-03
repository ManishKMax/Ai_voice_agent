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
  updateOutcome,
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

// Call outcome update
router.patch("/calls/:id/outcome", authMiddleware, updateOutcome);

export default router;
