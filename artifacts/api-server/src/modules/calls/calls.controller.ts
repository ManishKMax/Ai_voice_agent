import type { Request, Response } from "express";
import type { AuthRequest } from "../../middlewares/auth.js";
import { generateTwiML } from "../../services/twilio.service.js";
import {
  handleCallStatusUpdate,
  getCalls,
  getCallById,
  triggerCallForLead,
} from "./calls.service.js";
import { logger } from "../../lib/logger.js";

export async function voiceWebhook(req: Request, res: Response): Promise<void> {
  const leadId = parseInt((req.query.leadId as string) ?? "0");
  logger.info({ leadId, callSid: req.body?.CallSid }, "Twilio voice webhook");

  // Always respond with TwiML — never leave Twilio hanging
  try {
    const twiml = generateTwiML(leadId);
    res.setHeader("Content-Type", "text/xml");
    res.send(twiml);
  } catch (err) {
    logger.error({ err, leadId }, "Failed to generate TwiML");
    // Return a safe fallback that ends the call gracefully
    res.setHeader("Content-Type", "text/xml");
    res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`);
  }
}

export async function callStatusWebhook(req: Request, res: Response): Promise<void> {
  const leadId = parseInt((req.query.leadId as string) ?? "0");

  const {
    CallSid: callSid,
    CallStatus: callStatus,
    CallDuration: duration,
    RecordingUrl: recordingUrl,
  } = req.body as Record<string, string>;

  logger.info({ callSid, callStatus, leadId, duration }, "Twilio call status webhook");

  if (!callSid || !callStatus) {
    logger.warn({ body: req.body }, "Call status webhook missing required fields");
    res.status(400).send("Missing CallSid or CallStatus");
    return;
  }

  // Respond immediately — Twilio does not wait for processing
  res.status(204).send();

  // Process asynchronously so we never block Twilio's retry logic
  setImmediate(async () => {
    try {
      await handleCallStatusUpdate(
        callSid,
        callStatus,
        leadId,
        duration ? parseInt(duration) : undefined,
        recordingUrl
      );
    } catch (err) {
      logger.error({ err, callSid, callStatus, leadId }, "Error processing call status webhook");
    }
  });
}

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
    const { status, limit, offset } = req.query as Record<string, string>;
    const calls = await getCalls({
      status,
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
