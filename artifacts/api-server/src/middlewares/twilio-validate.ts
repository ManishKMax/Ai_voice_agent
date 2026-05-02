import type { Request, Response, NextFunction } from "express";
import { validateTwilioSignature } from "../services/twilio.service.js";
import { config } from "../config/index.js";
import { logger } from "../lib/logger.js";

/**
 * Validates incoming requests are genuinely from Twilio.
 * In development (no public URL / no auth token), validation is skipped.
 */
export function twilioValidate(req: Request, res: Response, next: NextFunction): void {
  // Skip validation if Twilio credentials aren't configured yet
  if (!config.twilio.authToken) {
    next();
    return;
  }

  const signature = req.headers["x-twilio-signature"] as string ?? "";

  // Reconstruct the full URL Twilio used to POST to this endpoint
  const protocol = req.headers["x-forwarded-proto"] ?? req.protocol;
  const host = req.headers["x-forwarded-host"] ?? req.headers.host;
  const fullUrl = `${protocol}://${host}${req.originalUrl}`;

  // Twilio signature validation uses POST body params
  const params = req.body as Record<string, string>;

  const valid = validateTwilioSignature(fullUrl, params, signature);

  if (!valid) {
    logger.warn({ url: fullUrl, signature: signature.slice(0, 10) }, "Invalid Twilio signature — rejecting request");
    res.status(403).send("Forbidden: invalid Twilio signature");
    return;
  }

  next();
}
