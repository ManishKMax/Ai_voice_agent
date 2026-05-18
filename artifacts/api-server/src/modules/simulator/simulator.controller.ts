import type { Request, Response, NextFunction } from "express";
import type { AuthRequest } from "../../middlewares/auth.js";
import { randomUUID } from "crypto";
import { eq, desc } from "drizzle-orm";
import { db } from "@workspace/db";
import { leadsTable, callsTable, callMetricsTable } from "@workspace/db/schema";
import { getSession as getConvSession } from "../../services/conversation-state.js";
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
  /** Set when the agent worker fires its onTeardown callback. The entry is
   *  intentionally kept around (not deleted) so a follow-up `/end` POST
   *  from the same operator can still authenticate against `ownerUserId`. */
  endedAt: number | null;
  /** User id (admin) who initiated this simulator session. Used to gate
   *  /stream and /end against cross-user access (IDOR). */
  ownerUserId: number | null;
}
const simulatorRooms = new Map<number, SimulatorRoomEntry>();
const ROOM_ENTRY_TTL_MS = 30 * 60 * 1000;
/** Periodically evict ended simulator entries older than the TTL so the
 *  map doesn't grow unbounded across long-lived process uptime. */
setInterval(() => {
  const now = Date.now();
  for (const [callId, entry] of simulatorRooms) {
    if (entry.endedAt && now - entry.endedAt > ROOM_ENTRY_TTL_MS) {
      simulatorRooms.delete(callId);
    }
  }
}, 5 * 60 * 1000).unref();

/** True if the request's caller is allowed to operate on this simulator
 *  call. When we have an in-memory owner record we enforce a strict match;
 *  if the record is absent (process restart, post-teardown) we fall back to
 *  the `source === "simulator"` defence-in-depth check the SSE route already
 *  performs. Returning the user id keeps the call sites symmetric. */
function isOwner(req: Request, entry: SimulatorRoomEntry | undefined): boolean {
  // Strict deny-by-default: if there's no in-memory ownership record (entry
  // evicted, process restart, brute-forced id), only the super_admin role
  // may inspect the simulator session. Same-role admins cannot read each
  // other's calls even after teardown. Cf. code-review IDOR finding.
  const auth = req as AuthRequest;
  if (!entry || entry.ownerUserId == null) {
    return auth.userRole === "SUPER_ADMIN";
  }
  const uid = auth.userId;
  return typeof uid === "number" && uid === entry.ownerUserId;
}

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
      // Spec-canonical field name. We also accept `llmProvider` as a
      // back-compat alias so older FE builds keep working during rollout.
      llmProviderOverride: rawProviderOverride,
      llmProvider: rawProviderLegacy,
      voice: rawVoice,
      language: rawLanguage,
    } = req.body as {
      leadName?: string;
      leadPhone?: string;
      llmProviderOverride?: string;
      llmProvider?: string;
      voice?: string;
      language?: string;
    };
    const rawProvider = rawProviderOverride ?? rawProviderLegacy;

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
    const voice =
      typeof rawVoice === "string" && rawVoice.trim()
        ? rawVoice.trim().slice(0, 32)
        : undefined;
    const language =
      typeof rawLanguage === "string" && rawLanguage.trim()
        ? rawLanguage.trim().slice(0, 16)
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
        voice,
        language,
        callSid,
        source: "simulator",
        // Resilient cleanup: when the agent worker tears down for ANY
        // reason (browser tab closed, network drop, last_participant
        // disconnect, call_session_closed via [DONE]), mark the room
        // entry as ended (do NOT delete) so a later `/end` POST can
        // still authenticate against `ownerUserId`. A periodic sweep
        // evicts entries older than ROOM_ENTRY_TTL_MS.
        onTeardown: (reason) => {
          const entry = simulatorRooms.get(call.id);
          if (entry) entry.endedAt = Date.now();
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

    const ownerUserId = (req as AuthRequest).userId ?? null;
    simulatorRooms.set(call.id, {
      callSid,
      roomName,
      startedAt: Date.now(),
      endedAt: null,
      ownerUserId,
    });

    logger.info(
      {
        callId: call.id,
        leadId: lead.id,
        callSid,
        roomName,
        llmProvider: llmProvider ?? "(default)",
        voice: voice ?? "(default)",
        language: language ?? "(default)",
        ownerUserId,
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

    // Defence-in-depth: confirm the call row exists and is a simulator call
    // before we touch it (prevents cross-tenant abuse via brute-forced
    // numeric IDs even when the in-memory map has been evicted).
    const [callRow] = await db
      .select({ id: callsTable.id, source: callsTable.source, sid: callsTable.twilioCallSid })
      .from(callsTable)
      .where(eq(callsTable.id, callId))
      .limit(1);
    if (!callRow) {
      res.status(404).json({ success: false, message: "Call not found" });
      return;
    }
    if (callRow.source !== "simulator") {
      res.status(403).json({ success: false, message: "Not a simulator call" });
      return;
    }
    if (!isOwner(req, entry)) {
      res.status(403).json({ success: false, message: "Not your simulator session" });
      return;
    }

    // Snapshot the live conversation transcript BEFORE we disconnect — the
    // agent worker's teardown path calls `endSession()` which evicts the
    // in-memory conversation state, so a fetch-after-disconnect would
    // return an empty transcript every time (code-review finding #2).
    const convBefore = callRow.sid ? getConvSession(callRow.sid) : undefined;
    const transcript = (convBefore?.messages ?? [])
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role, content: m.content }));

    if (entry) {
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
      // Keep the entry so any duplicate /end POST (or operator refresh)
      // can still authenticate; TTL sweeper evicts it 30 min later.
      entry.endedAt = entry.endedAt ?? Date.now();
    }
    await db
      .update(callsTable)
      .set({ callStatus: "completed" })
      .where(eq(callsTable.id, callId))
      .catch(() => undefined);

    const metricRows = await db
      .select()
      .from(callMetricsTable)
      .where(eq(callMetricsTable.callId, callId))
      .orderBy(desc(callMetricsTable.turnId));

    const median = (xs: number[]): number | null => {
      const v = xs.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
      if (v.length === 0) return null;
      const m = Math.floor(v.length / 2);
      return v.length % 2 ? v[m]! : (v[m - 1]! + v[m]!) / 2;
    };
    const pick = (k: keyof typeof metricRows[number]) =>
      median(metricRows.map((r) => r[k] as number | null).filter((n): n is number => typeof n === "number"));
    const metricsSummary = {
      turnCount: metricRows.length,
      p50: {
        sttLatencyMs: pick("sttLatencyMs"),
        llmFirstTokenMs: pick("llmFirstTokenMs"),
        llmLatencyMs: pick("llmLatencyMs"),
        ttsLatencyMs: pick("ttsLatencyMs"),
        totalRoundtripMs: pick("totalRoundtripMs"),
      },
    };

    res.json({
      success: true,
      data: {
        ended: true,
        alreadyEnded: !entry,
        callId,
        transcript,
        metrics: metricRows,
        metricsSummary,
      },
    });
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
    // IDOR guard: if we still have the in-memory owner, require a match.
    // After teardown / process restart the entry is gone; the source check
    // above is the residual guarantee for those windows.
    const entry = simulatorRooms.get(callId);
    if (!isOwner(req, entry)) {
      res.status(403).json({ success: false, message: "Not your simulator session" });
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
