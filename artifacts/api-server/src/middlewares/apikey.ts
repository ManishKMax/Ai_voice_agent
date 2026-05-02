import type { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { db } from "@workspace/db";
import { apiKeysTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";

export function hashApiKey(key: string): string {
  return crypto.createHash("sha256").update(key).digest("hex");
}

export async function apiKeyMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const raw = req.headers["x-api-key"] as string | undefined;
  if (!raw) {
    res.status(401).json({ success: false, message: "API key required (X-API-Key header)" });
    return;
  }

  const hash = hashApiKey(raw);
  const [key] = await db
    .select()
    .from(apiKeysTable)
    .where(eq(apiKeysTable.keyHash, hash))
    .limit(1);

  if (!key) {
    res.status(401).json({ success: false, message: "Invalid API key" });
    return;
  }

  await db
    .update(apiKeysTable)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiKeysTable.id, key.id));

  next();
}
