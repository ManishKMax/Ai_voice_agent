import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "http";
import type { Server } from "http";
import { config } from "../config/index.js";
import { buildSarvamSessionConfig } from "../services/sarvam.service.js";
import { logger } from "../lib/logger.js";
import { updateCallTranscript } from "../modules/calls/calls.service.js";
import { analyzeCallAndUpdateLead } from "../modules/ai/ai.service.js";
import { db } from "@workspace/db";
import { callsTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";

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

    function connectToSarvam() {
      sarvamWs = new WebSocket(
        `wss://api.sarvam.ai/v1/realtime?model=sarvam-1`,
        {
          headers: { Authorization: `Bearer ${config.sarvam.apiKey}` },
        }
      );

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
          const msg = JSON.parse(data.toString());

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

          if (
            msg.type === "conversation.item.input_audio_transcription.completed" &&
            msg.transcript
          ) {
            transcript += `User: ${msg.transcript}\n`;
          }

          if (
            msg.type === "response.audio_transcript.done" &&
            msg.transcript
          ) {
            transcript += `Agent: ${msg.transcript}\n`;
          }
        } catch (err) {
          logger.error({ err }, "Error parsing Sarvam message");
        }
      });

      sarvamWs.on("close", () => {
        logger.info({ leadId }, "Sarvam WebSocket closed");
      });

      sarvamWs.on("error", (err) => {
        logger.error({ err, leadId }, "Sarvam WebSocket error");
      });
    }

    twilioWs.on("message", async (data) => {
      try {
        const msg = JSON.parse(data.toString());

        if (msg.event === "start") {
          twilioCallSid = msg.start?.callSid ?? null;
          logger.info({ twilioCallSid, leadId }, "Stream started");

          if (twilioCallSid) {
            const [call] = await db
              .select()
              .from(callsTable)
              .where(eq(callsTable.twilioCallSid, twilioCallSid))
              .limit(1);
            if (call) callDbId = call.id;
          }

          connectToSarvam();
        }

        if (msg.event === "media" && sarvamWs?.readyState === WebSocket.OPEN) {
          sarvamWs.send(
            JSON.stringify({
              type: "input_audio_buffer.append",
              audio: msg.media?.payload,
            })
          );
        }

        if (msg.event === "stop") {
          logger.info({ leadId, twilioCallSid }, "Stream stopped");
          sarvamWs?.close();

          if (twilioCallSid && transcript) {
            await updateCallTranscript(twilioCallSid, transcript);
            if (callDbId) {
              await analyzeCallAndUpdateLead(callDbId);
            }
          }
        }
      } catch (err) {
        logger.error({ err }, "Error processing Twilio media stream message");
      }
    });

    twilioWs.on("close", () => {
      logger.info({ leadId }, "Twilio WebSocket disconnected");
      sarvamWs?.close();
    });

    twilioWs.on("error", (err) => {
      logger.error({ err, leadId }, "Twilio WebSocket error");
    });
  });

  logger.info("Media stream WebSocket server attached");
}
