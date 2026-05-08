import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { authMiddleware, requireRole } from "../../middlewares/auth.js";
import {
  startAudioCapture,
  audioCaptureTwiml,
  getAudioCapture,
  getAudioCaptureFile,
} from "./audio-capture.controller.js";
import { ttsStream } from "./tts-stream.controller.js";

const router: IRouter = Router();

/**
 * Kill-switch: debug routes are 404 unless explicitly enabled. They place real
 * outbound Twilio calls and would otherwise be a toll-fraud vector if reachable
 * on the public internet.
 */
function debugEnabledGate(_req: Request, res: Response, next: NextFunction): void {
  if (process.env["ENABLE_DEBUG_ROUTES"] === "1") {
    next();
    return;
  }
  res.status(404).send("Not found");
}

// Twilio fetches /twiml/:id with no auth header — gate it on the env flag only,
// and require a non-empty captureId path segment to avoid arbitrary traversal.
router.post("/audio-capture/twiml/:id", debugEnabledGate, audioCaptureTwiml);
router.get("/audio-capture/twiml/:id", debugEnabledGate, audioCaptureTwiml);

// Mutating + read-back routes require admin JWT in addition to the env flag.
router.post(
  "/audio-capture/start",
  debugEnabledGate,
  authMiddleware,
  requireRole("COMPANY_ADMIN", "SUPER_ADMIN"),
  startAudioCapture,
);
router.get(
  "/audio-capture/:id",
  debugEnabledGate,
  authMiddleware,
  requireRole("COMPANY_ADMIN", "SUPER_ADMIN"),
  getAudioCapture,
);
router.get(
  "/audio-capture/:id/file/:kind",
  debugEnabledGate,
  authMiddleware,
  requireRole("COMPANY_ADMIN", "SUPER_ADMIN"),
  getAudioCaptureFile,
);

// Phase 2: streaming Sarvam TTS WS — synthesize text and stream MP3 back.
router.post(
  "/tts-stream",
  debugEnabledGate,
  authMiddleware,
  requireRole("COMPANY_ADMIN", "SUPER_ADMIN"),
  ttsStream,
);

export default router;
