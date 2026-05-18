import type { Request, Response, NextFunction } from "express";
import { randomUUID } from "crypto";
import {
  mintLiveKitToken,
  getLiveKitCreds,
} from "../../services/livekit.service.js";
import { startLiveKitAgent } from "../../voice/livekit/agent-worker.js";
import { isLlmProviderId } from "../../services/llm/index.js";

/**
 * POST /api/voice/livekit/token
 *
 * Mints a participant join token for the in-browser Call Simulator. The
 * caller (browser) sends an identity (typically the logged-in user's
 * email or a generated guest id) and an optional room name. If room name
 * is omitted, a fresh per-call room is generated server-side.
 *
 * Response shape mirrors what the LiveKit JS client SDK expects: `url`,
 * `token`, `roomName`, `identity`. The browser hands `url` and `token`
 * straight to `Room.connect()`.
 */
export async function mintParticipantToken(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const creds = getLiveKitCreds();
    if (!creds) {
      res.status(503).json({
        success: false,
        message:
          "LiveKit is not configured. Set LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LIVEKIT_URL.",
      });
      return;
    }
    const { identity: rawIdentity, roomName: rawRoom, name } = req.body as {
      identity?: string;
      roomName?: string;
      name?: string;
    };
    const identity =
      typeof rawIdentity === "string" && rawIdentity.trim() !== ""
        ? rawIdentity.trim()
        : `sim-${randomUUID().slice(0, 8)}`;
    const roomName =
      typeof rawRoom === "string" && rawRoom.trim() !== ""
        ? rawRoom.trim()
        : `sim-${randomUUID().slice(0, 12)}`;
    const token = await mintLiveKitToken({
      roomName,
      identity,
      name: typeof name === "string" && name ? name : identity,
      ttlSeconds: 60 * 60,
    });
    res.json({
      success: true,
      data: {
        url: creds.url,
        token,
        roomName,
        identity,
      },
    });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/voice/livekit/start-agent
 *
 * Spawn an in-process LiveKit agent worker that joins the given room,
 * subscribes to the browser participant's audio track, and runs the
 * existing CallSession brain over the WebRTC transport.
 *
 * Browser flow:
 *   1) POST /api/voice/livekit/token   → join the room as participant
 *   2) Once Room.connect resolves and the mic is published,
 *      POST /api/voice/livekit/start-agent { roomName, llmProvider? }
 *   3) Listen on the room for the agent's audio track; play through
 *      <audio> element. CallSession greeting is the first thing heard.
 */
export async function startAgentInRoom(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!getLiveKitCreds()) {
      res.status(503).json({
        success: false,
        message:
          "LiveKit is not configured. Set LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LIVEKIT_URL.",
      });
      return;
    }
    const { roomName, leadId, llmProvider, callSid } = req.body as {
      roomName?: string;
      leadId?: number | string;
      llmProvider?: string;
      callSid?: string;
    };
    if (!roomName || typeof roomName !== "string") {
      res.status(400).json({ success: false, message: "roomName is required" });
      return;
    }
    const leadIdNum =
      typeof leadId === "number"
        ? leadId
        : typeof leadId === "string" && leadId !== ""
          ? Number(leadId) || undefined
          : undefined;
    const provider =
      typeof llmProvider === "string" && isLlmProviderId(llmProvider)
        ? llmProvider
        : undefined;
    const handle = await startLiveKitAgent({
      roomName,
      leadId: leadIdNum,
      llmProvider: provider,
      callSid: typeof callSid === "string" && callSid ? callSid : undefined,
    });
    res.json({
      success: true,
      data: {
        roomName: handle.roomName,
        callSid: handle.callSid,
      },
    });
  } catch (err) {
    next(err);
  }
}
