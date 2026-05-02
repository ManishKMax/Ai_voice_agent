import type { Server } from "http";

/**
 * Media-stream WebSocket server — removed.
 * The Sarvam realtime WebSocket endpoint (wss://api.sarvam.ai/v1/realtime)
 * is not publicly available. Voice conversations now use a Gather-based
 * turn loop: Twilio <Gather input="speech"> → Sarvam Chat → Sarvam TTS → <Play>.
 *
 * This stub is kept only to satisfy any lingering imports; it does nothing.
 */
export function attachMediaStreamServer(_httpServer: Server): void {
  // No-op — media stream approach replaced by Gather-based pipeline.
}
