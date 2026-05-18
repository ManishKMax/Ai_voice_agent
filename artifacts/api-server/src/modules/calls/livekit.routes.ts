import { Router } from "express";
import { authMiddleware, requireRole } from "../../middlewares/auth.js";
import {
  mintParticipantToken,
  startAgentInRoom,
} from "./livekit.controller.js";

/**
 * LiveKit Phase 1 endpoints (Call Simulator).
 *
 * Both endpoints mint LiveKit minutes (token issuance is effectively
 * spending). Gated behind admin roles (SUPER_ADMIN / COMPANY_ADMIN) so
 * non-admin tokens can't drain quota. The Phase-2 PSTN bridge will get
 * its own SIP-trunk webhook with carrier-side auth.
 */
const router = Router();
const adminOnly = [authMiddleware, requireRole("SUPER_ADMIN", "COMPANY_ADMIN")];

router.post("/voice/livekit/token", adminOnly, mintParticipantToken);
router.post("/voice/livekit/start-agent", adminOnly, startAgentInRoom);

export default router;
