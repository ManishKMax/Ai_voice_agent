import type { Request, Response, NextFunction } from "express";
import { validateTwilioSignature } from "../services/twilio.service.js";
import { config } from "../config/index.js";
import { logger } from "../lib/logger.js";

/**
 * Validates incoming requests are genuinely from Twilio.
 * In development (no auth token configured), validation is skipped.
 */
export function twilioValidate(req: Request, res: Response, next: NextFunction): void {
  if (!config.twilio.authToken) {
    next();
    return;
  }

  const signature = (req.headers["x-twilio-signature"] as string) ?? "";

  // Normalize headers that may come as string | string[]
  const proto = Array.isArray(req.headers["x-forwarded-proto"])
    ? req.headers["x-forwarded-proto"][0]
    : (req.headers["x-forwarded-proto"] ?? req.protocol);

  const host = Array.isArray(req.headers["x-forwarded-host"])
    ? req.headers["x-forwarded-host"][0]
    : (req.headers["x-forwarded-host"] ?? req.headers.host ?? "");

  const fullUrl = `${proto}://${host}${req.originalUrl}`;
  const params = req.body as Record<string, string>;

  const valid = validateTwilioSignature(fullUrl, params, signature);

  if (!valid) {
    logger.warn({ url: fullUrl }, "Invalid Twilio signature — rejecting request");
    res.status(403).send("Forbidden: invalid Twilio signature");
    return;
  }

  next();
}
