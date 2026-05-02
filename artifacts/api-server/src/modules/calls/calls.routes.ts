import { Router } from "express";
import { authMiddleware } from "../../middlewares/auth.js";
import { twilioValidate } from "../../middlewares/twilio-validate.js";
import {
  voiceWebhook,
  callStatusWebhook,
  initiateCallManually,
  listCalls,
  getCall,
  listCallsForLead,
} from "./calls.controller.js";

const router = Router();

// Twilio webhooks — validated but unauthenticated (Twilio posts these)
router.post("/voice", twilioValidate, voiceWebhook);
router.post("/call-status", twilioValidate, callStatusWebhook);

// Authenticated call management
router.post("/call/initiate/:leadId", authMiddleware, initiateCallManually);
router.get("/calls", authMiddleware, listCalls);
router.get("/calls/:id", authMiddleware, getCall);

// Call history by lead
router.get("/leads/:leadId/calls", authMiddleware, listCallsForLead);

export default router;
