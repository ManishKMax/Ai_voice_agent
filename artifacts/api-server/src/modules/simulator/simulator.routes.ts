import { Router, type Request, type Response, type NextFunction } from "express";
import { authMiddleware, requireRole } from "../../middlewares/auth.js";
import {
  startSimulator,
  endSimulator,
  streamSimulatorEvents,
} from "./simulator.controller.js";

/**
 * Hydrates `Authorization: Bearer <token>` from a `?token=` query param
 * before delegating to the standard `authMiddleware`. Required because:
 *   - SSE (`EventSource`) cannot set custom request headers.
 *   - `navigator.sendBeacon` (used by the beforeunload cleanup path) also
 *     cannot set custom headers.
 * Scoped to simulator routes only — the global `authMiddleware` continues
 * to require a header for every other endpoint. If a request already
 * carries an `Authorization` header, the query param is ignored.
 */
function simulatorAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.headers.authorization && typeof req.query["token"] === "string") {
    const t = (req.query["token"] as string).trim();
    if (t) req.headers.authorization = `Bearer ${t}`;
  }
  authMiddleware(req, res, next);
}

/**
 * Task #31 — In-browser Call Simulator routes.
 *
 * Admin-only because each `start` mints LiveKit minutes (token issuance =
 * billable) and spawns an agent worker that consumes Sarvam (or whichever
 * LLM provider is selected) tokens. Same gate as the underlying
 * /api/voice/livekit/* endpoints.
 *
 * Mounted at `/simulator` in routes/index.ts so paths are:
 *   POST /api/simulator/start
 *   POST /api/simulator/:callId/end
 *   GET  /api/simulator/:callId/stream    (SSE, ?token= for EventSource)
 */
const router = Router();
const adminRole = requireRole("SUPER_ADMIN", "COMPANY_ADMIN");

router.post("/start", authMiddleware, adminRole, startSimulator);
router.post("/:callId/end", simulatorAuth, adminRole, endSimulator);
router.get("/:callId/stream", simulatorAuth, adminRole, streamSimulatorEvents);

export default router;
