import { Router } from "express";
import { authMiddleware, requireRole } from "../../middlewares/auth.js";
import { getCallMetrics } from "../../services/metrics.service.js";

const router = Router();

/**
 * GET /api/calls/:callId/metrics
 * Per-turn latency breakdown for a single call. Used by the Call Simulator
 * UI live panel and the per-call drill-down on the Reports page.
 */
router.get(
  "/calls/:callId/metrics",
  authMiddleware,
  requireRole("COMPANY_ADMIN", "SUPER_ADMIN"),
  async (req, res, next): Promise<void> => {
    try {
      const callId = parseInt(req.params["callId"] as string, 10);
      if (Number.isNaN(callId)) {
        res.status(400).json({ error: "Invalid call ID" });
        return;
      }
      const rows = await getCallMetrics(callId);
      res.json({
        callId,
        turns: rows.map((r) => ({
          turnId: r.turnId,
          llmProvider: r.llmProvider,
          llmModel: r.llmModel,
          sttLatencyMs: r.sttLatencyMs,
          llmFirstTokenMs: r.llmFirstTokenMs,
          llmTokensPerSec: r.llmTokensPerSec,
          firstWordTriggerMs: r.firstWordTriggerMs,
          ttsStreamStartMs: r.ttsStreamStartMs,
          firstPlaybackMs: r.firstPlaybackMs,
          firstAudioChunkMs: r.firstAudioChunkMs,
          ttsPlaybackStartAt: r.ttsPlaybackStartAt,
          ttsCompleteMs: r.ttsCompleteMs,
          llmLatencyMs: r.llmLatencyMs,
          ttsLatencyMs: r.ttsLatencyMs,
          totalRoundtripMs: r.totalRoundtripMs,
          livekitTransportMs: r.livekitTransportMs,
          createdAt: r.createdAt,
        })),
      });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
