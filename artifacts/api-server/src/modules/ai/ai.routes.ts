import { Router } from "express";
import { authMiddleware } from "../../middlewares/auth.js";
import type { AuthRequest } from "../../middlewares/auth.js";
import type { Response } from "express";
import { analyzeCallAndUpdateLead } from "./ai.service.js";

const router = Router();

router.post("/ai/analyze/:callId", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const callId = parseInt(req.params.callId as string);
    await analyzeCallAndUpdateLead(callId);
    res.json({ message: "Analysis complete", callId });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Analysis failed";
    res.status(500).json({ error: msg });
  }
});

export default router;
