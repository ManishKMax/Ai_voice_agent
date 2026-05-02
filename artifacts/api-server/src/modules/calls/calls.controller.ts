import type { Request, Response } from "express";
import type { AuthRequest } from "../../middlewares/auth.js";
import {
  generateInitialTwiML,
  generateGatherTwiML,
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
import { db } from "@workspace/db";
import { leadsTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { logger } from "../../lib/logger.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

function xmlResponse(res: Response, twiml: string): void {
  res.setHeader("Content-Type", "text/xml");
  res.send(twiml);
}

async function makeTwimlWithAudio(
  text: string,
  leadId: number,
  callSid: string,
  turn: number,
  isEnd: boolean
): Promise<string> {
  const audioBuffer = await generateSpeech(text, agentConfig);

  if (!audioBuffer) {
    // Fallback to Twilio <Say> if TTS fails
    logger.warn({ leadId, turn }, "Sarvam TTS failed — falling back to Twilio Say");
    return generateSayTwiML(text, agentConfig.language, isEnd ? undefined : leadId, callSid, turn, isEnd);
  }

  const audioId = storeAudio(audioBuffer, "audio/wav");

  if (isEnd) {
    return generateEndCallTwiML(audioId);
  }
  return generateGatherTwiML(leadId, callSid, turn, audioId, agentConfig.language);
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
      : `Hi there! This is ${agentConfig.name} from ${agentConfig.companyName}. Am I speaking with ${leadName}?`;

    // System prompt includes the greeting so the AI has full context for turn 1
    const systemPrompt = buildSystemPrompt(agentConfig, leadName, greetingText);

    // Create conversation session
    createSession(callSid, leadId, leadName, systemPrompt);
    addAgentOpening(callSid, greetingText);

    logger.info({ leadId, callSid, leadName }, "Session created, generating greeting audio");

    const audioBuffer = await generateSpeech(greetingText, agentConfig);

    if (!audioBuffer) {
      // TTS failed — use Twilio <Say> fallback
      logger.warn({ leadId }, "TTS failed for greeting — using Twilio Say");
      const twiml = generateSayTwiML(greetingText, agentConfig.language, leadId, callSid, 0, false);
      xmlResponse(res, twiml);
      return;
    }

    const audioId = storeAudio(audioBuffer, "audio/wav");
    const twiml = generateInitialTwiML(leadId, callSid, audioId, agentConfig.language);
    xmlResponse(res, twiml);
  } catch (err) {
    logger.error({ err, leadId }, "Voice webhook error");
    xmlResponse(res, `<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`);
  }
}

// ── Gather Webhook (handles lead's speech) ──────────────────────────────────

export async function voiceGatherWebhook(req: Request, res: Response): Promise<void> {
  const q = req.query as Record<string, string>;
  const body = req.body as Record<string, string>;
  const leadId = parseInt(q.leadId ?? "0");
  const callSid = q.callSid ?? body.CallSid ?? "";
  const turn = parseInt(q.turn ?? "0");

  const speechResult = body.SpeechResult ?? "";
  const confidence = parseFloat(body.Confidence ?? "0");

  logger.info({ leadId, callSid, turn, speechResult, confidence }, "Gather webhook received");

  try {
    // If no speech was detected, re-prompt or end
    if (!speechResult.trim()) {
      const repromptText = "I'm sorry, I didn't catch that. Could you please repeat?";
      if (turn >= 1) {
        // Give up after re-prompting once
        const byeText = `Thank you for your time. I'll try reaching you another time. Have a great day!`;
        const twiml = await makeTwimlWithAudio(byeText, leadId, callSid, turn + 1, true);
        xmlResponse(res, twiml);
      } else {
        const twiml = await makeTwimlWithAudio(repromptText, leadId, callSid, turn + 1, false);
        xmlResponse(res, twiml);
      }
      return;
    }

    const session = getSession(callSid);
    const nextTurn = turn + 1;

    // Check turn limit
    if (!session || nextTurn > agentConfig.maxTurns) {
      const byeText = `Thank you so much for your time. I'll follow up with more information. Have a wonderful day!`;
      addTurn(callSid, speechResult, byeText);
      await finaliseCall(callSid, leadId);
      const twiml = await makeTwimlWithAudio(byeText, leadId, callSid, nextTurn, true);
      xmlResponse(res, twiml);
      return;
    }

    // Generate AI response
    const { text: agentText, shouldEnd } = await generateConversationResponse(
      session.messages,
      speechResult
    );

    addTurn(callSid, speechResult, agentText);
    logger.info({ leadId, turn: nextTurn, agentText, shouldEnd }, "AI response generated");

    if (shouldEnd || nextTurn >= agentConfig.maxTurns) {
      await finaliseCall(callSid, leadId);
      const twiml = await makeTwimlWithAudio(agentText, leadId, callSid, nextTurn, true);
      xmlResponse(res, twiml);
    } else {
      const twiml = await makeTwimlWithAudio(agentText, leadId, callSid, nextTurn, false);
      xmlResponse(res, twiml);
    }
  } catch (err) {
    logger.error({ err, leadId, turn }, "Gather webhook error");
    xmlResponse(res, `<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`);
  }
}

/** Save transcript, run AI analysis, update lead status. */
async function finaliseCall(callSid: string, leadId: number): Promise<void> {
  const session = endSession(callSid);
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
  const { CallSid: callSid, CallStatus: callStatus, CallDuration: duration } = body;

  logger.info({ callSid, callStatus, leadId, duration }, "Call status webhook");

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
        duration ? parseInt(duration) : undefined
      );

      // If the call completed but we still have an open session (rare edge case),
      // finalise it now.
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

