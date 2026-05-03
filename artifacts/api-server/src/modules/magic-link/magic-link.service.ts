import crypto from "crypto";
import jwt from "jsonwebtoken";
import { eq, and, gt } from "drizzle-orm";
import { db } from "@workspace/db";
import { magicLinkTokensTable, tenantsTable } from "@workspace/db/schema";
import { config } from "../../config/index.js";
import { createAuditLog } from "../audit/audit.service.js";
import { logger } from "../../lib/logger.js";

const MAGIC_LINK_TTL_MS = 10 * 60 * 1000; // 10 minutes

export async function generateMagicLink(adminUserId: number, tenantId: number) {
  const [tenant] = await db
    .select({ id: tenantsTable.id, name: tenantsTable.name, email: tenantsTable.email })
    .from(tenantsTable)
    .where(eq(tenantsTable.id, tenantId))
    .limit(1);

  if (!tenant) throw new Error("Tenant not found");

  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + MAGIC_LINK_TTL_MS);

  await db.insert(magicLinkTokensTable).values({
    token,
    tenantId,
    createdByUserId: adminUserId,
    expiresAt,
  });

  await createAuditLog({
    userId: adminUserId,
    action: "ADMIN_GENERATED_MAGIC_LINK",
    targetType: "tenant",
    targetId: tenantId,
    metadata: { tenantName: tenant.name, tenantEmail: tenant.email, expiresAt },
  });

  logger.info({ adminUserId, tenantId }, "Magic link generated");

  return { token, expiresAt, tenantId, tenantName: tenant.name };
}

export async function consumeMagicLink(token: string) {
  const now = new Date();

  const [row] = await db
    .select()
    .from(magicLinkTokensTable)
    .where(
      and(
        eq(magicLinkTokensTable.token, token),
        eq(magicLinkTokensTable.used, false),
        gt(magicLinkTokensTable.expiresAt, now)
      )
    )
    .limit(1);

  if (!row) throw new Error("Invalid or expired magic link token");

  // Mark token as used
  await db
    .update(magicLinkTokensTable)
    .set({ used: true, usedAt: now })
    .where(eq(magicLinkTokensTable.id, row.id));

  const [tenant] = await db
    .select()
    .from(tenantsTable)
    .where(eq(tenantsTable.id, row.tenantId))
    .limit(1);

  if (!tenant) throw new Error("Tenant not found");

  // Issue a short-lived portal JWT that wraps Clerk user context
  // We embed the tenantId + clerkUserId so the portal can use it
  const portalToken = jwt.sign(
    {
      tenantId: tenant.id,
      clerkUserId: tenant.clerkUserId,
      email: tenant.email,
      magicLinkLogin: true,
    },
    config.jwtSecret,
    { expiresIn: "4h" }
  );

  await createAuditLog({
    userId: row.createdByUserId,
    action: "MAGIC_LINK_CONSUMED",
    targetType: "tenant",
    targetId: tenant.id,
    metadata: { tenantEmail: tenant.email },
  });

  logger.info({ tenantId: tenant.id }, "Magic link consumed — portal token issued");

  return {
    portalToken,
    tenant: {
      id: tenant.id,
      name: tenant.name,
      email: tenant.email,
      clerkUserId: tenant.clerkUserId,
    },
    expiresIn: "4h",
  };
}
