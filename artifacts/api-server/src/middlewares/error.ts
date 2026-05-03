import type { Request, Response, NextFunction } from "express";
import { logger } from "../lib/logger.js";

const VOICE_PATHS = ["/api/voice", "/api/call-status"];

function isVoiceRoute(url: string): boolean {
  return VOICE_PATHS.some((p) => url.startsWith(p));
}

export function errorMiddleware(
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  logger.error({ err, url: req.url, method: req.method }, "Unhandled error");

  // Voice webhook routes MUST return valid TwiML — returning JSON causes
  // Twilio to play "An application error has occurred" to the caller.
  if (isVoiceRoute(req.url)) {
    res.setHeader("Content-Type", "text/xml");
    res
      .status(200)
      .send(
        '<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="Polly.Aditi" language="en-IN">I\'m sorry, I had a brief issue. I\'ll call you back shortly.</Say><Hangup/></Response>'
      );
    return;
  }

  res.status(500).json({ error: err.message ?? "Internal server error" });
}
