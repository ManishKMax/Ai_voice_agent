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
  const leadId = parseInt(req.query.leadId as string ?? "0");
  logger.info({ leadId }, "Twilio voice webhook received");
  const twiml = generateTwiML(leadId);
  res.setHeader("Content-Type", "text/xml");
  res.send(twiml);
}

export async function callStatusWebhook(req: Request, res: Response): Promise<void> {
  try {
    const leadId = parseInt(req.query.leadId as string ?? "0");
    const {
      CallSid: callSid,
      CallStatus: callStatus,
      CallDuration: duration,
      RecordingUrl: recordingUrl,
    } = req.body;

    logger.info({ callSid, callStatus, leadId }, "Call status webhook");
    await handleCallStatusUpdate(
      callSid,
      callStatus,
      leadId,
      duration ? parseInt(duration) : undefined,
      recordingUrl
    );
    res.status(204).send();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Failed to handle call status";
    res.status(500).json({ error: msg });
  }
}

export async function initiateCallManually(req: AuthRequest, res: Response): Promise<void> {
  try {
    const leadId = parseInt(req.params.leadId as string);
    if (!leadId) {
      res.status(400).json({ error: "leadId is required" });
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
