import type { Request, Response } from "express";
import type { AuthRequest } from "../../middlewares/auth.js";
import { randomUUID } from "crypto";
import {
  generateInitialTwiML,
  generateFillerTwiML,
  generateRespondTwiML,
  generateEndCallTwiML,
  generateSayTwiML,
  generateMediaStreamTwiML,
} from "../../services/twilio.service.js";
import { generateSpeech, generateConversationResponse, analyzeTranscript } from "../../services/sarvam.service.js";
import { storeAudio, getAudio, consumePendingGreeting } from "../../services/audio-cache.js";
import {
  createSession,
  getSession,
  addTurn,
  addAgentOpening,
  endSession,
} from "../../services/conversation-state.js";
import { agentConfig, buildSystemPrompt, buildGreetingText } from "../../config/agent.config.js";
import { config } from "../../config/index.js";
import {
  handleCallStatusUpdate,
  getCalls,
  getCallById,
  setCallOutcome,
  triggerCallForLead,
  updateCallTranscript,
} from "./calls.service.js";
import { getLeadById } from "../leads/leads.service.js";
import { updateLeadStatus } from "../leads/leads.service.js";
import { broadcastSse } from "../../services/sse.service.js";
import { db } from "@workspace/db";
import { leadsTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { logger } from "../../lib/logger.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

function xmlResponse(res: Response, twiml: string): void {
  res.setHeader("Content-Type", "text/xml");
  res.send(twiml);
}

// ── Async Job Store ──────────────────────────────────────────────────────────
//
// When a lead speaks, we respond to Twilio IMMEDIATELY with a filler phrase
// (< 200ms) and process the AI response in the background. The /api/voice/respond
// endpoint polls this store and serves the real audio once ready.
//
// This eliminates the ~7s dead-air silence that was causing users to hang up.

interface ConversationJob {
  status: "pending" | "done" | "error";
  callSid: string;
  leadId: number;
  turn: number;
  audioId?: string;
  agentText?: string;
  isEnd?: boolean;
  createdAt: number;
}

const jobs = new Map<string, ConversationJob>();

// Clean up stale jobs every 5 minutes (TTL: 10 minutes)
setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [id, job] of jobs) {
    if (job.createdAt < cutoff) jobs.delete(id);
  }
}, 5 * 60 * 1000);

/** Poll the job store until the job is done or timeout is reached. */
async function waitForJob(jobId: string, timeoutMs: number): Promise<ConversationJob | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const job = jobs.get(jobId);
    if (job && job.status !== "pending") return job;
    await new Promise<void>(resolve => setTimeout(resolve, 200));
  }
  // Return whatever state we have (might still be pending — caller handles it)
  return jobs.get(jobId) ?? null;
}

/** Pick a natural filler phrase based on the agent's configured tone. */
function getFillerPhrase(): string {
  switch (agentConfig.tone) {
    case "friendly": return "Oh sure, let me check on that for you.";
    case "casual":   return "Sure, give me just one second.";
    default:         return "Hmm, one moment please.";
  }
}

/**
 * Background worker: generates the AI text response + Sarvam TTS audio,
 * then stores the result in the jobs Map so voiceRespondWebhook can serve it.
 */
async function processConversationJob(jobId: string, speechResult: string): Promise<void> {
  const job = jobs.get(jobId);
  if (!job) return;

  const { callSid, leadId, turn } = job;

  try {
    const session = getSession(callSid);
    const nextTurn = turn + 1;

    // Session not found or turn limit reached — say goodbye
    if (!session || nextTurn > agentConfig.maxTurns) {
      const byeText = "Thank you so much for your time. I'll follow up with more information. Have a wonderful day!";
      addTurn(callSid, speechResult, byeText);
      await finaliseCall(callSid, leadId);
      const audioBuffer = await generateSpeech(byeText, agentConfig);
      const audioId = audioBuffer ? storeAudio(audioBuffer, "audio/wav") : undefined;
      jobs.set(jobId, { ...job, status: "done", audioId, agentText: byeText, isEnd: true });
      return;
    }

    // ── Timing instrumentation ─────────────────────────────────────────
    // STT happens upstream in Twilio's <Gather> (we don't run our own STT),
    // so we log only LLM + TTS + total. `sttInferred` is the time we *waited*
    // before getting the speechResult, but Twilio doesn't tell us the actual
    // STT inference time — so we just track LLM and TTS here.
    const tStart = Date.now();

    const tLlmStart = Date.now();
    const { text: agentText, shouldEnd } = await generateConversationResponse(session.messages, speechResult);
    const llmMs = Date.now() - tLlmStart;
    addTurn(callSid, speechResult, agentText);

    const isEnd = shouldEnd || nextTurn >= agentConfig.maxTurns;

    // Generate TTS audio for the AI response
    const tTtsStart = Date.now();
    const audioBuffer = await generateSpeech(agentText, agentConfig);
    const ttsMs = Date.now() - tTtsStart;
    const audioId = audioBuffer ? storeAudio(audioBuffer, "audio/wav") : undefined;

    if (isEnd) {
      await finaliseCall(callSid, leadId);
    }

    jobs.set(jobId, { ...job, status: "done", audioId, agentText, isEnd });

    broadcastSse("call.turn", {
      callSid,
      leadId,
      leadName: session?.leadName ?? "",
      turn: nextTurn,
      userText: speechResult,
      agentText,
      isEnd,
    });

    const totalMs = Date.now() - tStart;
    logger.info(
      {
        jobId,
        leadId,
        turn: nextTurn,
        isEnd,
        llmMs,
        ttsMs,
        totalMs,
        agentChars: agentText.length,
        audioBytes: audioBuffer?.length ?? 0,
      },
      "Conversation job completed",
    );
  } catch (err) {
    logger.error({ err, jobId, leadId }, "Conversation job failed");
    jobs.set(jobId, { ...job, status: "error" });
  }
}

// ── Voice Webhook (initial call entry) ─────────────────────────────────────

export async function voiceWebhook(req: Request, res: Response): Promise<void> {
  const leadId = parseInt((req.query.leadId as string) ?? "0");
  const body = req.body as Record<string, string>;
  const callSid = body.CallSid ?? "";

  logger.info({ leadId, callSid }, "Voice webhook — generating greeting");

  try {
    const lead = leadId ? await getLeadById(leadId) : null;
    const leadName = lead?.name ?? "there";

    // Try to consume the pre-generated greeting started in triggerCallForLead.
    // If it's not present (e.g., manually-initiated call) we generate inline.
    const pending = consumePendingGreeting(leadId);
    // Always use buildGreetingText so the short-greeting tweak applies even
    // on the no-prewarm fallback path (e.g. manually-initiated calls).
    const greetingText = pending?.text ?? buildGreetingText(agentConfig, leadName);

    const systemPrompt = buildSystemPrompt(agentConfig, leadName, greetingText);

    createSession(callSid, leadId, leadName, systemPrompt);
    addAgentOpening(callSid, greetingText);

    broadcastSse("call.started", {
      callSid,
      leadId,
      leadName,
      phone: lead?.phone ?? "",
      agentText: greetingText,
      turn: 0,
      startedAt: Date.now(),
    });

    logger.info({ leadId, callSid, leadName, prewarmed: !!pending }, "Session created, resolving greeting audio");

    // Wait at most 2.5s for the pre-warmed greeting; fall back to Polly Say
    // (instant, no API call) if Sarvam TTS hasn't completed by then. This
    // guarantees /api/voice always returns TwiML in well under 3 seconds.
    let audioId: string | null = null;
    if (pending) {
      audioId = await Promise.race([
        pending.promise,
        new Promise<null>(resolve => setTimeout(() => resolve(null), 2500)),
      ]);
    } else {
      const buf = await generateSpeech(greetingText, agentConfig);
      audioId = buf ? storeAudio(buf, "audio/wav") : null;
    }

    if (!audioId) {
      logger.warn({ leadId }, "Greeting audio not ready — falling back to Polly Say");
      const twiml = generateSayTwiML(greetingText, agentConfig.language, leadId, 0, false);
      xmlResponse(res, twiml);
      return;
    }

    const twiml = generateInitialTwiML(leadId, audioId, agentConfig.language);
    xmlResponse(res, twiml);
  } catch (err) {
    logger.error({ err, leadId }, "Voice webhook error");
    xmlResponse(res, `<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`);
  }
}

// ── Voice v2 Webhook (Media Streams — Phase 1, opt-in) ─────────────────────
//
// Returns TwiML that connects the call's audio to our /api/voice/stream
// WebSocket so we can run our own STT/VAD/LLM pipeline. Phase 1 only stands
// up the plumbing — Phase 2+ will wire Sarvam STT/TTS bridges on top.

export function voiceWebhookV2(req: Request, res: Response): void {
  const leadId = parseInt((req.query["leadId"] as string) ?? "0");
  req.log.info({ leadId }, "Voice v2 webhook — connecting to media stream");
  xmlResponse(res, generateMediaStreamTwiML(leadId || undefined));
}

// ── Gather Webhook (handles lead's spoken response) ─────────────────────────
//
// KEY CHANGE: Instead of generating AI response here (7+ seconds), we:
// 1. Immediately start a background job for AI + TTS generation
// 2. Return a filler phrase TwiML within ~200ms
// 3. The filler TwiML redirects to /api/voice/respond once the job is done
//
// This prevents the 7-second dead-air silence that caused leads to hang up.

export async function voiceGatherWebhook(req: Request, res: Response): Promise<void> {
  const q = req.query as Record<string, string>;
  const body = req.body as Record<string, string>;
  const leadId = parseInt(q.leadId ?? "0");

  // Always read CallSid from the POST body — Twilio always includes it.
  // Previously we passed callSid in the URL query string which caused
  // potential encoding issues; now the URL only carries leadId and turn.
  const callSid = body.CallSid ?? "";
  const turn = parseInt(q.turn ?? "0");

  const speechResult = body.SpeechResult ?? "";
  const dtmfDigits = body.Digits ?? "";
  const confidence = parseFloat(body.Confidence ?? "0");

  // If the caller pressed DTMF instead of speaking, treat the key press as a
  // "yes/hello" signal so the conversation can still begin through Sarvam.
  const effectiveSpeech = speechResult.trim()
    || (dtmfDigits ? `[pressed ${dtmfDigits}]` : "");

  logger.info({ leadId, callSid, turn, speechResult, dtmfDigits, confidence }, "Gather webhook received");

  try {
    // No speech AND no DTMF detected — re-prompt using Polly (instant, no TTS API needed)
    if (!effectiveSpeech) {
      logger.info({ leadId, callSid, turn }, "No speech or DTMF detected — re-prompting");
      if (turn >= 2) {
        xmlResponse(res, generateSayTwiML(
          "I'm sorry I couldn't hear you. I'll try reaching you another time. Have a great day!",
          agentConfig.language
        ));
      } else {
        xmlResponse(res, generateSayTwiML(
          "I'm sorry, I didn't quite catch that. Could you please repeat?",
          agentConfig.language, leadId, turn + 1, false
        ));
      }
      return;
    }

    // Create a job and start background AI processing
    const jobId = randomUUID();
    const job: ConversationJob = { status: "pending", callSid, leadId, turn, createdAt: Date.now() };
    jobs.set(jobId, job);

    // Fire-and-forget — voiceRespondWebhook will pick up the result
    processConversationJob(jobId, effectiveSpeech).catch(err => {
      logger.error({ err, jobId }, "processConversationJob unhandled rejection");
      jobs.set(jobId, { ...job, status: "error" });
    });

    // Respond to Twilio IMMEDIATELY with a natural filler phrase
    const filler = getFillerPhrase();
    logger.info({ jobId, leadId, turn, filler }, "Returning filler — background job started");
    xmlResponse(res, generateFillerTwiML(leadId, turn, jobId, filler, agentConfig.language));
  } catch (err) {
    logger.error({ err, leadId, turn }, "Gather webhook error");
    xmlResponse(res, `<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`);
  }
}

// ── Respond Webhook (serves real AI audio after background job completes) ───
//
// Sarvam-105b can take 8–14s to respond. We CANNOT block the Twilio HTTP
// response that long — Twilio plays silence to the caller while waiting,
// which is why callers hear the filler then dead air and hang up.
//
// Pattern: poll briefly (~2s). If the job isn't ready, respond IMMEDIATELY
// with a short pause + redirect back to ourselves. Twilio plays 2s of silence
// (or a brief tone) then re-calls us. Each iteration is < 3s so the audio
// stream never goes quiet for long, and the call never approaches Twilio's
// 15s webhook timeout.

const MAX_RESPOND_WAITS = 8;       // 8 iterations × ~2.5s ≈ 20s total budget
const RESPOND_POLL_MS = 2000;       // poll the job for 2s per iteration

export async function voiceRespondWebhook(req: Request, res: Response): Promise<void> {
  const q = req.query as Record<string, string>;
  const leadId = parseInt(q.leadId ?? "0");
  const turn = parseInt(q.turn ?? "0");
  const jobId = q.jobId ?? "";
  const waitCount = parseInt(q.wait ?? "0");

  logger.info({ jobId, leadId, turn, waitCount }, "Respond webhook — checking background job");

  try {
    const job = await waitForJob(jobId, RESPOND_POLL_MS);

    // Job done — serve the real audio
    if (job && job.status === "done") {
      const nextTurn = turn + 1;

      if (job.isEnd) {
        if (job.audioId) {
          xmlResponse(res, generateEndCallTwiML(job.audioId));
        } else {
          xmlResponse(res, generateSayTwiML(
            job.agentText && job.agentText.trim()
              ? job.agentText
              : "Thank you for your time. Have a great day!",
            agentConfig.language
          ));
        }
        return;
      }

      if (job.audioId) {
        xmlResponse(res, generateRespondTwiML(leadId, nextTurn, job.audioId, agentConfig.language));
      } else {
        // Sarvam TTS failed but we have AI text — speak it via Polly so the
        // caller hears the AI's actual reply, not a generic placeholder.
        const fallbackText = job.agentText && job.agentText.trim()
          ? job.agentText
          : "I see. Could you tell me more?";
        logger.warn({ jobId, leadId, hasAgentText: !!job.agentText }, "TTS missing — falling back to Polly Say");
        xmlResponse(res, generateSayTwiML(
          fallbackText, agentConfig.language, leadId, nextTurn, false
        ));
      }

      logger.info({ jobId, leadId, turn: nextTurn }, "Respond webhook served AI audio");
      return;
    }

    // Job errored — graceful exit
    if (job && job.status === "error") {
      logger.warn({ jobId, leadId, waitCount }, "Job errored — ending call gracefully");
      xmlResponse(res, generateSayTwiML(
        "I apologize, I had a brief technical issue. I will reach out again shortly. Have a great day!",
        agentConfig.language
      ));
      return;
    }

    // Still pending — give up if we've waited too long
    if (waitCount + 1 >= MAX_RESPOND_WAITS) {
      logger.warn({ jobId, leadId, waitCount }, "Job exceeded max waits — ending call");
      xmlResponse(res, generateSayTwiML(
        "I apologize for the delay. Let me reach out to you again shortly. Have a great day!",
        agentConfig.language
      ));
      return;
    }

    // Loop: pause briefly and re-call ourselves so Twilio keeps the line open
    // without blocking on a single HTTP response.
    const nextWait = waitCount + 1;
    const respondUrl = `${config.baseUrl}/api/voice/respond?leadId=${leadId}&turn=${turn}&jobId=${jobId}&wait=${nextWait}`
      .replace(/&/g, "&amp;");

    logger.info({ jobId, leadId, waitCount: nextWait }, "Job still pending — looping with pause+redirect");
    xmlResponse(res, `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Pause length="2"/>
  <Redirect method="POST">${respondUrl}</Redirect>
</Response>`);
  } catch (err) {
    logger.error({ err, jobId, leadId }, "Respond webhook error");
    xmlResponse(res, generateSayTwiML(
      "I apologize for the interruption. I will reach out again soon.",
      agentConfig.language
    ));
  }
}

// ── finaliseCall ─────────────────────────────────────────────────────────────

async function finaliseCall(callSid: string, leadId: number): Promise<void> {
  const session = endSession(callSid);

  broadcastSse("call.ended", {
    callSid,
    leadId,
    leadName: session?.leadName ?? "",
    turns: session?.turnCount ?? 0,
    endedAt: Date.now(),
  });

  if (!session || !session.transcript) {
    logger.warn({ callSid, leadId }, "finaliseCall: no session transcript found");
    return;
  }

  logger.info({ callSid, leadId, turns: session.turnCount }, "Finalising call — running transcript analysis");

  try {
    await updateCallTranscript(callSid, session.transcript);

    const { interest, nextAction, summary } = await analyzeTranscript(session.transcript);
    logger.info({ leadId, interest, nextAction, summary }, "Transcript analysed");

    const leadStatus =
      interest === "high" || nextAction === "demo"
        ? "interested"
        : nextAction === "drop"
        ? "not_interested"
        : "completed";

    await updateLeadStatus(leadId, leadStatus);

    await db
      .update(leadsTable)
      .set({ notes: summary, updatedAt: new Date() })
      .where(eq(leadsTable.id, leadId));

    logger.info({ leadId, leadStatus, summary }, "Lead updated after call finalisation");
  } catch (err) {
    logger.error({ err, callSid, leadId }, "Error finalising call");
  }
}

// ── Audio Serving ───────────────────────────────────────────────────────────

export function serveAudio(req: Request, res: Response): void {
  const id = String(req.params.id ?? "");
  const audio = getAudio(id);
  if (!audio) {
    res.status(404).send("Audio not found or expired");
    return;
  }
  res.setHeader("Content-Type", audio.contentType);
  res.setHeader("Content-Length", audio.buffer.length);
  res.setHeader("Cache-Control", "no-store");
  res.send(audio.buffer);
}

// ── Call Status Webhook ─────────────────────────────────────────────────────

export async function callStatusWebhook(req: Request, res: Response): Promise<void> {
  const leadId = parseInt((req.query.leadId as string) ?? "0");
  const body = req.body as Record<string, string>;
  const { CallSid: callSid, CallStatus: callStatus, CallDuration: duration, AnsweredBy: answeredBy } = body;

  logger.info({ callSid, callStatus, leadId, duration, answeredBy }, "Call status webhook");

  if (!callSid || !callStatus) {
    logger.warn({ body }, "Call status webhook missing required fields");
    res.status(400).send("Missing CallSid or CallStatus");
    return;
  }

  // Respond immediately — Twilio doesn't wait
  res.status(204).send();

  setImmediate(async () => {
    try {
      await handleCallStatusUpdate(
        callSid,
        callStatus,
        leadId,
        duration ? parseInt(duration) : undefined,
        undefined,
        answeredBy
      );

      if (callStatus.toLowerCase() === "completed") {
        const session = getSession(callSid);
        if (session) {
          logger.info({ callSid, leadId }, "Status webhook: finalising orphaned session");
          await finaliseCall(callSid, leadId);
        }
      }
    } catch (err) {
      logger.error({ err, callSid, callStatus, leadId }, "Error processing call status webhook");
    }
  });
}

// ── Authenticated routes ────────────────────────────────────────────────────

export async function initiateCallManually(req: AuthRequest, res: Response): Promise<void> {
  try {
    const leadId = parseInt(req.params.leadId as string);
    if (!leadId || isNaN(leadId)) {
      res.status(400).json({ error: "Valid leadId is required" });
      return;
    }
    await triggerCallForLead(leadId);
    res.json({ message: "Call initiated", leadId });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Call initiation failed";
    res.status(500).json({ error: msg });
  }
}

export async function updateOutcome(req: AuthRequest, res: Response): Promise<void> {
  try {
    const id = parseInt(req.params.id as string);
    if (!id || isNaN(id)) {
      res.status(400).json({ error: "Valid call id is required" });
      return;
    }

    const { outcome, followUpDate, followUpTime, outcomeNotes } = req.body as {
      outcome?: string;
      followUpDate?: string;
      followUpTime?: string;
      outcomeNotes?: string;
    };

    const validOutcomes = ["INTERESTED", "NOT_INTERESTED", "NO_RESPONSE"] as const;
    if (!outcome || !validOutcomes.includes(outcome as (typeof validOutcomes)[number])) {
      res.status(400).json({ error: "outcome must be one of: INTERESTED, NOT_INTERESTED, NO_RESPONSE" });
      return;
    }

    const call = await getCallById(id);
    if (!call) {
      res.status(404).json({ error: "Call not found" });
      return;
    }

    const updated = await setCallOutcome(
      id,
      outcome as "INTERESTED" | "NOT_INTERESTED" | "NO_RESPONSE",
      followUpDate ?? null,
      followUpTime ?? null,
      outcomeNotes ?? null,
    );

    res.json({ call: updated });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Failed to update outcome";
    res.status(400).json({ error: msg });
  }
}

export async function listCalls(req: AuthRequest, res: Response): Promise<void> {
  try {
    const { status, leadId, limit, offset } = req.query as Record<string, string>;
    const calls = await getCalls({
      status,
      leadId: leadId ? parseInt(leadId) : undefined,
      limit: limit ? parseInt(limit) : undefined,
      offset: offset ? parseInt(offset) : undefined,
    });
    res.json({ calls, count: calls.length });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Failed to fetch calls";
    res.status(500).json({ error: msg });
  }
}

export async function getCall(req: AuthRequest, res: Response): Promise<void> {
  try {
    const id = parseInt(req.params.id as string);
    const call = await getCallById(id);
    if (!call) {
      res.status(404).json({ error: "Call not found" });
      return;
    }
    res.json({ call });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Failed to fetch call";
    res.status(500).json({ error: msg });
  }
}

export async function listCallsForLead(req: AuthRequest, res: Response): Promise<void> {
  try {
    const leadId = parseInt(req.params.leadId as string);
    if (!leadId || isNaN(leadId)) {
      res.status(400).json({ error: "Valid leadId is required" });
      return;
    }

    const lead = await getLeadById(leadId);
    if (!lead) {
      res.status(404).json({ error: "Lead not found" });
      return;
    }

    const calls = await getCalls({ leadId });
    res.json({ calls, count: calls.length });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Failed to fetch calls for lead";
    res.status(500).json({ error: msg });
  }
}
