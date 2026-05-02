import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "http";
import type { Server } from "http";
import { eq } from "drizzle-orm";
import { config } from "../config/index.js";
import { buildSarvamSessionConfig, SARVAM_WS_URL } from "../services/sarvam.service.js";
import { logger } from "../lib/logger.js";
import { updateCallTranscript } from "../modules/calls/calls.service.js";
import { analyzeCallAndUpdateLead } from "../modules/ai/ai.service.js";
import { db } from "@workspace/db";
import { callsTable, leadsTable } from "@workspace/db/schema";

export function attachMediaStreamServer(httpServer: Server): void {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (req: IncomingMessage, socket, head) => {
    const url = req.url ?? "";
    if (url.startsWith("/api/media-stream")) {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    } else {
      socket.destroy();
    }
  });

  wss.on("connection", (twilioWs: WebSocket, req: IncomingMessage) => {
    // Try URL params first (fallback); real leadId comes from Twilio customParameters in "start"
    const urlParams = new URL(req.url ?? "", "http://localhost");
    const urlLeadId = parseInt(urlParams.searchParams.get("leadId") ?? "0");
    logger.info({ urlLeadId }, "Twilio media stream connected");

    let sarvamWs: WebSocket | null = null;
    let twilioCallSid: string | null = null;
    let transcript = "";
    let callDbId: number | null = null;
    let streamStopped = false;
    let resolvedLeadId = urlLeadId; // overridden from customParameters on "start"

    function connectToSarvam() {
      if (!config.sarvam.apiKey) {
        logger.warn({ leadId: resolvedLeadId }, "SARVAM_API_KEY not set — skipping AI connection");
        return;
      }

      sarvamWs = new WebSocket(SARVAM_WS_URL, {
        headers: { Authorization: `Bearer ${config.sarvam.apiKey}` },
      });

      sarvamWs.on("open", () => {
        logger.info({ leadId: resolvedLeadId }, "Sarvam WebSocket connected");
        sarvamWs?.send(
          JSON.stringify({
            type: "session.update",
            session: buildSarvamSessionConfig(),
          })
        );
      });

      sarvamWs.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString()) as Record<string, unknown>;

          // Forward AI audio back to Twilio
          if (msg.type === "response.audio.delta" && msg.delta) {
            if (twilioWs.readyState === WebSocket.OPEN) {
              twilioWs.send(
                JSON.stringify({
                  event: "media",
                  streamSid: twilioCallSid,
                  media: { payload: msg.delta },
                })
              );
            }
          }

          // Accumulate transcript: user speech
          if (
            msg.type === "conversation.item.input_audio_transcription.completed" &&
            msg.transcript
          ) {
            transcript += `User: ${msg.transcript}\n`;
          }

          // Accumulate transcript: agent speech
          if (msg.type === "response.audio_transcript.done" && msg.transcript) {
            transcript += `Agent: ${msg.transcript}\n`;
          }

          // Sarvam session error
          if (msg.type === "error") {
            logger.error({ leadId: resolvedLeadId, error: msg.error }, "Sarvam session error");
          }
        } catch (err) {
          logger.error({ err }, "Error parsing Sarvam message");
        }
      });

      sarvamWs.on("close", (code, reason) => {
        logger.info({ leadId: resolvedLeadId, code, reason: reason.toString() }, "Sarvam WebSocket closed");
      });

      sarvamWs.on("error", (err) => {
        logger.error({ err, leadId: resolvedLeadId }, "Sarvam WebSocket error");
      });
    }

    async function finalizeStream() {
      if (streamStopped) return; // Guard: run once even if both "stop" and "close" fire
      streamStopped = true;

      sarvamWs?.close();

      logger.info({ leadId: resolvedLeadId, twilioCallSid, transcriptLength: transcript.length }, "Finalizing stream");

      try {
        if (twilioCallSid && transcript.trim()) {
          await updateCallTranscript(twilioCallSid, transcript.trim());
          logger.info({ leadId: resolvedLeadId, twilioCallSid }, "Transcript saved");
        }

        if (callDbId) {
          await analyzeCallAndUpdateLead(callDbId);
        } else if (resolvedLeadId) {
          logger.warn({ leadId: resolvedLeadId }, "No callDbId resolved — marking lead completed as fallback");
          await db
            .update(leadsTable)
            .set({ status: "completed", updatedAt: new Date() })
            .where(eq(leadsTable.id, resolvedLeadId));
        }
      } catch (err) {
        logger.error({ err, leadId: resolvedLeadId, callDbId }, "Error finalizing stream");
      }
    }

    twilioWs.on("message", async (data) => {
      try {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        const event = msg.event as string;

        if (event === "start") {
          const startData = msg.start as Record<string, unknown> | undefined;
          twilioCallSid = (startData?.callSid as string) ?? null;

          // Read leadId from Twilio <Parameter> customParameters (most reliable method)
          const customParams = startData?.customParameters as Record<string, string> | undefined;
          const paramLeadId = parseInt(customParams?.leadId ?? "0");
          if (paramLeadId) {
            resolvedLeadId = paramLeadId;
          }

          logger.info({ twilioCallSid, leadId: resolvedLeadId }, "Media stream started");

          // Look up the call DB record by Twilio SID
          if (twilioCallSid) {
            const [call] = await db
              .select({ id: callsTable.id })
              .from(callsTable)
              .where(eq(callsTable.twilioCallSid, twilioCallSid))
              .limit(1);
            if (call) {
              callDbId = call.id;
              logger.info({ callDbId, twilioCallSid }, "Resolved callDbId");
            } else {
              logger.warn({ twilioCallSid }, "Call record not found by SID at stream start");
            }
          }

          connectToSarvam();
        }

        if (event === "media" && sarvamWs?.readyState === WebSocket.OPEN) {
          const mediaData = msg.media as Record<string, unknown> | undefined;
          sarvamWs.send(
            JSON.stringify({
              type: "input_audio_buffer.append",
              audio: mediaData?.payload,
            })
          );
        }

        if (event === "stop") {
          logger.info({ leadId: resolvedLeadId, twilioCallSid }, "Media stream stopped");
          await finalizeStream();
        }
      } catch (err) {
        logger.error({ err }, "Error processing Twilio media stream message");
      }
    });

    twilioWs.on("close", async () => {
      logger.info({ leadId: resolvedLeadId }, "Twilio WebSocket disconnected");
      await finalizeStream();
    });

    twilioWs.on("error", (err) => {
      logger.error({ err, leadId: resolvedLeadId }, "Twilio WebSocket error");
    });
  });

  logger.info("Media stream WebSocket server attached");
}
