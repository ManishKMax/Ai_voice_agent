import type { Request, Response, NextFunction } from "express";
import type { AuthRequest } from "../../middlewares/auth.js";
import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { leadsTable, callsTable } from "@workspace/db/schema";
import {
  mintLiveKitToken,
  getLiveKitCreds,
} from "../../services/livekit.service.js";
import {
  startLiveKitAgent,
  getLiveKitAgent,
} from "../../voice/livekit/agent-worker.js";
import { isLlmProviderId } from "../../services/llm/index.js";
import { subscribeSimulator } from "../../services/simulator-bus.js";
import { logger } from "../../lib/logger.js";

/**
 * Task #31 — In-browser Call Simulator backend.
 *
 * Flow:
 *   POST /api/simulator/start
 *     → creates a tagged lead+call row, mints a LiveKit join token, spawns
 *       the in-process agent worker (same CallSession code path prod uses).
 *   POST /api/simulator/:callId/end
 *     → tears down the agent worker for this call's room.
 *   GET  /api/simulator/:callId/stream  (SSE)
 *     → streams per-call events: `log` (every call_session_* pino line),
 *       `metrics` (per-turn 13-field row), `transcript` (per-turn user +
 *       agent text). Heartbeats every 25s.
 *
 * Simulator-sourced rows are tagged `calls.source = "simulator"` and
 * `leads.source = "simulator"` so analytics / Reports can exclude them.
 */

// Per-callId mapping kept in-process so /end can find the room name we
// gave to the agent worker. Cleared on teardown. Restart-safe because
// simulator calls are ephemeral by design.
interface SimulatorRoomEntry {
  callSid: string;
  roomName: string;
  startedAt: number;
}
const simulatorRooms = new Map<number, SimulatorRoomEntry>();

export async function startSimulator(
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

    const {
      leadName: rawName,
      leadPhone: rawPhone,
      llmProvider: rawProvider,
    } = req.body as {
      leadName?: string;
      leadPhone?: string;
      llmProvider?: string;
    };

    const leadName =
      typeof rawName === "string" && rawName.trim()
        ? rawName.trim().slice(0, 100)
        : "Simulator Lead";
    const leadPhone =
      typeof rawPhone === "string" && rawPhone.trim()
        ? rawPhone.trim().slice(0, 20)
        : "+0000000000";
    const llmProvider =
      typeof rawProvider === "string" && isLlmProviderId(rawProvider)
        ? rawProvider
        : undefined;

    // Pre-generate the LiveKit-style simulator call sid; CallSession will
    // log every line with `call_id = this.session.callSid`, so persisting
    // it as `twilioCallSid` is what lets `findCallIdBySid` resolve metrics
    // to a DB row without any code changes.
    const callSid = `LKSIM${randomUUID().replace(/-/g, "").slice(0, 28)}`;
    const roomName = `sim-${randomUUID().slice(0, 12)}`;
    const userIdentity = `user-${randomUUID().slice(0, 8)}`;

    // 1) Create the simulator lead. Status stays "pending" — the enum
    //    doesn't include a "simulator" value and we don't want to evict
    //    it from the regular Leads table; analytics filters on source.
    const [lead] = await db
      .insert(leadsTable)
      .values({
        name: leadName,
        phone: leadPhone,
        source: "simulator",
        sourceId: callSid,
        notes: "Created by in-browser Call Simulator (Task #31)",
      })
      .returning();
    if (!lead) {
      res.status(500).json({ success: false, message: "Failed to create simulator lead" });
      return;
    }

    // 2) Create the call row tagged source="simulator". The agent worker
    //    will start emitting metrics tagged with this callSid; the
    //    metrics service's findCallIdBySid join keys on twilioCallSid.
    const [call] = await db
      .insert(callsTable)
      .values({
        leadId: lead.id,
        twilioCallSid: callSid,
        callStatus: "initiated",
        source: "simulator",
      })
      .returning();
    if (!call) {
      res.status(500).json({ success: false, message: "Failed to create simulator call" });
      return;
    }

    // 3) Mint the browser-side participant token. Identity goes on the
    //    token so the LiveKit SFU can route audio properly. TTL is 1h —
    //    typical simulator session is < 5 min, this is safe headroom.
    const token = await mintLiveKitToken({
      roomName,
      identity: userIdentity,
      name: (req as AuthRequest).userEmail ?? userIdentity,
      ttlSeconds: 60 * 60,
      isAgent: false,
    });

    // 4) Start the in-process agent worker that joins the room and runs
    //    CallSession against the browser's audio track. The callSid we
    //    pass is the same one we wrote to calls.twilio_call_sid so every
    //    downstream log line / metric row / transcript event lines up.
    try {
      await startLiveKitAgent({
        roomName,
        leadId: lead.id,
        llmProvider,
        callSid,
        // Resilient cleanup: when the agent worker tears down for ANY
        // reason (browser tab closed, network drop, last_participant
        // disconnect, call_session_closed via [DONE]), evict the room map
        // and finalise the call row so we don't rely on the browser
        // managing to fire `/end` before exit.
        onTeardown: (reason) => {
          simulatorRooms.delete(call.id);
          void db
            .update(callsTable)
            .set({ callStatus: "completed" })
            .where(eq(callsTable.id, call.id))
            .catch((err: unknown) => {
              logger.warn(
                { err: (err as Error).message, callId: call.id },
                "simulator_finalize_call_status_failed",
              );
            });
          logger.info(
            { callId: call.id, callSid, roomName, reason },
            "simulator_auto_cleanup",
          );
        },
      });
    } catch (err) {
      logger.warn(
        { err: (err as Error).message, callSid, callId: call.id, roomName },
        "simulator_start_agent_failed",
      );
      // Best-effort cleanup of the call row so the row doesn't dangle in
      // "initiated" status forever.
      await db
        .update(callsTable)
        .set({ callStatus: "failed" })
        .where(eq(callsTable.id, call.id))
        .catch(() => undefined);
      res.status(500).json({
        success: false,
        message: `Failed to start LiveKit agent: ${(err as Error).message}`,
      });
      return;
    }

    simulatorRooms.set(call.id, {
      callSid,
      roomName,
      startedAt: Date.now(),
    });

    logger.info(
      {
        callId: call.id,
        leadId: lead.id,
        callSid,
        roomName,
        llmProvider: llmProvider ?? "(default)",
      },
      "simulator_started",
    );

    res.json({
      success: true,
      data: {
        callId: call.id,
        leadId: lead.id,
        callSid,
        roomName,
        identity: userIdentity,
        token,
        url: creds.url,
      },
    });
  } catch (err) {
    next(err);
  }
}

export async function endSimulator(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const callId = Number(req.params["callId"]);
    if (!Number.isFinite(callId)) {
      res.status(400).json({ success: false, message: "Invalid callId" });
      return;
    }
    const entry = simulatorRooms.get(callId);
    if (!entry) {
      // Idempotent — return 200 so the browser's beforeunload cleanup
      // doesn't fight with the user clicking End first.
      res.json({ success: true, data: { alreadyEnded: true } });
      return;
    }
    const handle = getLiveKitAgent(entry.roomName);
    if (handle) {
      try {
        await handle.disconnect();
      } catch (err) {
        logger.warn(
          { err: (err as Error).message, callId, roomName: entry.roomName },
          "simulator_disconnect_failed",
        );
      }
    }
    simulatorRooms.delete(callId);
    await db
      .update(callsTable)
      .set({ callStatus: "completed" })
      .where(eq(callsTable.id, callId))
      .catch(() => undefined);
    res.json({ success: true, data: { ended: true } });
  } catch (err) {
    next(err);
  }
}

/**
 * SSE: streams per-call events to the simulator browser UI.
 *
 * Auth is done via `?token=` because the EventSource API doesn't allow
 * custom headers; the route is wrapped by `authMiddleware` upstream which
 * already accepts the query param.
 */
export async function streamSimulatorEvents(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const callId = Number(req.params["callId"]);
    if (!Number.isFinite(callId)) {
      res.status(400).json({ success: false, message: "Invalid callId" });
      return;
    }
    // Resolve callSid from DB so a freshly-reloaded browser tab can
    // resubscribe even if `simulatorRooms` doesn't have the entry yet
    // (e.g. server restart between start and stream).
    const [row] = await db
      .select({ sid: callsTable.twilioCallSid, source: callsTable.source })
      .from(callsTable)
      .where(eq(callsTable.id, callId))
      .limit(1);
    if (!row || !row.sid) {
      res.status(404).json({ success: false, message: "Call not found" });
      return;
    }
    if (row.source !== "simulator") {
      // Defence in depth — production call events should never be
      // streamable via this endpoint (would leak across tenants).
      res.status(403).json({ success: false, message: "Not a simulator call" });
      return;
    }
    const callSid = row.sid;

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    res.write(
      `event: connected\ndata: ${JSON.stringify({ callId, callSid, ts: Date.now() })}\n\n`,
    );

    const unsubscribe = subscribeSimulator(callSid, (e) => {
      // Generic event envelope: `event: <name>\n` + JSON-encoded body.
      try {
        res.write(`event: ${e.event}\ndata: ${JSON.stringify({ ts: e.ts, ...(e.data as Record<string, unknown>) })}\n\n`);
      } catch {
        // Write failed — peer probably disconnected; close handler will
        // unsubscribe in a moment.
      }
    });

    const heartbeat = setInterval(() => {
      try {
        res.write(`:heartbeat\n\n`);
      } catch {
        // ignore — close handler runs next tick
      }
    }, 25_000);

    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  } catch (err) {
    next(err);
  }
}
