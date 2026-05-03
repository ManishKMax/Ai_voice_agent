import type { Request, Response } from "express";
import type { AuthRequest } from "../../middlewares/auth.js";
import { randomUUID } from "crypto";
import {
  generateInitialTwiML,
  generateFillerTwiML,
  generateRespondTwiML,
  generateEndCallTwiML,
  generateSayTwiML,
} from "../../services/twilio.service.js";
import { generateSpeech, generateConversationResponse, analyzeTranscript } from "../../services/sarvam.service.js";
import { storeAudio, getAudio } from "../../services/audio-cache.js";
import {
  createSession,
  getSession,
  addTurn,
  addAgentOpening,
  endSession,
} from "../../services/conversation-state.js";
import { agentConfig, buildSystemPrompt } from "../../config/agent.config.js";
import {
  handleCallStatusUpdate,
  getCalls,
  getCallById,
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

    // Generate AI response text
    const { text: agentText, shouldEnd } = await generateConversationResponse(session.messages, speechResult);
    addTurn(callSid, speechResult, agentText);

    const isEnd = shouldEnd || nextTurn >= agentConfig.maxTurns;

    // Generate TTS audio for the AI response
    const audioBuffer = await generateSpeech(agentText, agentConfig);
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

    logger.info({ jobId, leadId, turn: nextTurn, isEnd }, "Conversation job completed");
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

    // Build the opening line
    const greetingText = agentConfig.tone === "professional"
      ? `Hello, this is ${agentConfig.name} calling from ${agentConfig.companyName}. May I speak with ${leadName}?`
      : agentConfig.tone === "casual"
      ? `Hey! This is ${agentConfig.name} from ${agentConfig.companyName}. Is this ${leadName}?`
      : `Hi there! This is ${agentConfig.name} from ${agentConfig.companyName}. Am I speaking with ${leadName}?`;

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

    logger.info({ leadId, callSid, leadName }, "Session created, generating greeting audio");

    const audioBuffer = await generateSpeech(greetingText, agentConfig);

    if (!audioBuffer) {
      logger.warn({ leadId }, "TTS failed for greeting — using Twilio Say");
      const twiml = generateSayTwiML(greetingText, agentConfig.language, leadId, 0, false);
      xmlResponse(res, twiml);
      return;
    }

    const audioId = storeAudio(audioBuffer, "audio/wav");
    const twiml = generateInitialTwiML(leadId, audioId, agentConfig.language);
    xmlResponse(res, twiml);
  } catch (err) {
    logger.error({ err, leadId }, "Voice webhook error");
    xmlResponse(res, `<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`);
  }
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

export async function voiceRespondWebhook(req: Request, res: Response): Promise<void> {
  const q = req.query as Record<string, string>;
  const leadId = parseInt(q.leadId ?? "0");
  const turn = parseInt(q.turn ?? "0");
  const jobId = q.jobId ?? "";

  logger.info({ jobId, leadId, turn }, "Respond webhook — waiting for background job");

  try {
    // Poll for up to 12 seconds.
    // The filler phrase takes ~0.5–1s to play before Twilio calls this endpoint,
    // so we effectively have ~11 more seconds of budget before Twilio's 15s timeout.
    const job = await waitForJob(jobId, 12000);

    if (!job || job.status === "error") {
      logger.warn({ jobId, leadId }, "Job failed or timed out — ending call gracefully");
      xmlResponse(res, generateSayTwiML(
        "I apologize, I had a brief technical issue. I'll call you back shortly. Have a great day!",
        agentConfig.language
      ));
      return;
    }

    const nextTurn = turn + 1;

    if (job.isEnd) {
      if (job.audioId) {
        xmlResponse(res, generateEndCallTwiML(job.audioId));
      } else {
        xmlResponse(res, generateSayTwiML(
          job.agentText ?? "Thank you for your time. Have a great day!",
          agentConfig.language
        ));
      }
      return;
    }

    if (job.audioId) {
      xmlResponse(res, generateRespondTwiML(leadId, nextTurn, job.audioId, agentConfig.language));
    } else {
      // TTS failed — fall back to Polly so the conversation doesn't drop
      xmlResponse(res, generateSayTwiML(
        job.agentText ?? "I see. Could you tell me more?",
        agentConfig.language, leadId, nextTurn, false
      ));
    }

    logger.info({ jobId, leadId, turn: nextTurn }, "Respond webhook served AI audio");
  } catch (err) {
    logger.error({ err, jobId, leadId }, "Respond webhook error");
    xmlResponse(res, generateSayTwiML(
      "I apologize for the interruption. I'll reach out again soon.",
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
