import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "http";
import type { Server } from "http";
import { eq } from "drizzle-orm";
import { config } from "../config/index.js";
import { buildSarvamSessionConfig } from "../services/sarvam.service.js";
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
    const urlParams = new URL(req.url ?? "", "http://localhost");
    const leadId = parseInt(urlParams.searchParams.get("leadId") ?? "0");
    logger.info({ leadId }, "Twilio media stream connected");

    let sarvamWs: WebSocket | null = null;
    let twilioCallSid: string | null = null;
    let transcript = "";
    let callDbId: number | null = null;
    let streamStopped = false;

    function connectToSarvam() {
      if (!config.sarvam.apiKey) {
        logger.warn({ leadId }, "SARVAM_API_KEY not set — skipping AI connection");
        return;
      }

      sarvamWs = new WebSocket(`wss://api.sarvam.ai/v1/realtime?model=sarvam-1`, {
        headers: { Authorization: `Bearer ${config.sarvam.apiKey}` },
      });

      sarvamWs.on("open", () => {
        logger.info({ leadId }, "Sarvam WebSocket connected");
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
            logger.error({ leadId, error: msg.error }, "Sarvam session error");
          }
        } catch (err) {
          logger.error({ err }, "Error parsing Sarvam message");
        }
      });

      sarvamWs.on("close", (code, reason) => {
        logger.info({ leadId, code, reason: reason.toString() }, "Sarvam WebSocket closed");
      });

      sarvamWs.on("error", (err) => {
        logger.error({ err, leadId }, "Sarvam WebSocket error");
      });
    }

    async function finalizeStream() {
      if (streamStopped) return; // Guard: run once even if both "stop" and "close" fire
      streamStopped = true;

      sarvamWs?.close();

      logger.info({ leadId, twilioCallSid, transcriptLength: transcript.length }, "Finalizing stream");

      try {
        if (twilioCallSid && transcript.trim()) {
          // Save transcript to the call record
          await updateCallTranscript(twilioCallSid, transcript.trim());
          logger.info({ leadId, twilioCallSid }, "Transcript saved");
        }

        if (callDbId) {
          // Run AI analysis — this sets the final lead status
          await analyzeCallAndUpdateLead(callDbId);
        } else if (leadId) {
          // callDbId wasn't resolved from the start event — mark lead completed as fallback
          logger.warn({ leadId }, "No callDbId resolved — marking lead completed as fallback");
          await db
            .update(leadsTable)
            .set({ status: "completed", updatedAt: new Date() })
            .where(eq(leadsTable.id, leadId));
        }
      } catch (err) {
        logger.error({ err, leadId, callDbId }, "Error finalizing stream");
      }
    }

    twilioWs.on("message", async (data) => {
      try {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        const event = msg.event as string;

        if (event === "start") {
          const startData = msg.start as Record<string, unknown> | undefined;
          twilioCallSid = (startData?.callSid as string) ?? null;
          logger.info({ twilioCallSid, leadId }, "Media stream started");

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
          logger.info({ leadId, twilioCallSid }, "Media stream stopped");
          await finalizeStream();
        }
      } catch (err) {
        logger.error({ err }, "Error processing Twilio media stream message");
      }
    });

    twilioWs.on("close", async () => {
      logger.info({ leadId }, "Twilio WebSocket disconnected");
      // Ensure finalization runs if "stop" event wasn't received
      await finalizeStream();
    });

    twilioWs.on("error", (err) => {
      logger.error({ err, leadId }, "Twilio WebSocket error");
    });
  });

  logger.info("Media stream WebSocket server attached");
}
