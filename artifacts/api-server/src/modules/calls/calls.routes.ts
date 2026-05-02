import { Router } from "express";
import { authMiddleware } from "../../middlewares/auth.js";
import {
  voiceWebhook,
  callStatusWebhook,
  initiateCallManually,
  listCalls,
  getCall,
} from "./calls.controller.js";

const router = Router();

router.post("/voice", voiceWebhook);
router.post("/call-status", callStatusWebhook);

router.post("/call/initiate/:leadId", authMiddleware, initiateCallManually);
router.get("/calls", authMiddleware, listCalls);
router.get("/calls/:id", authMiddleware, getCall);

export default router;
