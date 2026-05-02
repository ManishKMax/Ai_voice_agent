import { Router } from "express";
import { authMiddleware } from "../../middlewares/auth.js";
import {
  getAgentConfigHandler,
  updateAgentConfigHandler,
  voicePreviewHandler,
} from "./agent.controller.js";

const router = Router();

router.get("/agent-config", authMiddleware, getAgentConfigHandler);
router.patch("/agent-config", authMiddleware, updateAgentConfigHandler);
router.post("/agent-config/voice-preview", authMiddleware, voicePreviewHandler);

export default router;
