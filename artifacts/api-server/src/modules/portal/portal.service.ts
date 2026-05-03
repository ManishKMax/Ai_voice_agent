import { db, tenantsTable, pricingConfigTable, kycDocumentsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";

export async function getOrCreateTenant(clerkUserId: string, name: string, email: string) {
  const existing = await db
    .select()
    .from(tenantsTable)
    .where(eq(tenantsTable.clerkUserId, clerkUserId))
    .limit(1);

  if (existing.length > 0) return existing[0];

  const [created] = await db
    .insert(tenantsTable)
    .values({ clerkUserId, name, email })
    .returning();

  return created;
}

export async function getTenantByClerkId(clerkUserId: string) {
  const rows = await db
    .select()
    .from(tenantsTable)
    .where(eq(tenantsTable.clerkUserId, clerkUserId))
    .limit(1);
  return rows[0] ?? null;
}

export async function getPricingConfig() {
  const rows = await db.select().from(pricingConfigTable).limit(1);
  if (rows.length > 0) return rows[0];
  const [seeded] = await db.insert(pricingConfigTable).values({}).returning();
  return seeded;
}

export async function incrementTrialCalls(tenantId: number) {
  const [updated] = await db
    .update(tenantsTable)
    .set({ trialCallsUsed: sql`${tenantsTable.trialCallsUsed} + 1` })
    .where(eq(tenantsTable.id, tenantId))
    .returning();
  return updated;
}

export async function submitKycDocument(
  tenantId: number,
  documents: Array<{
    documentType: "aadhaar" | "gst";
    objectPath: string;
    fileName: string;
  }>,
) {
  const saved = await db
    .insert(kycDocumentsTable)
    .values(
      documents.map((doc) => ({
        tenantId,
        documentType: doc.documentType,
        fileUrl: doc.objectPath,
        fileName: doc.fileName,
        status: "pending" as const,
      })),
    )
    .returning();

  await db
    .update(tenantsTable)
    .set({ kycStatus: "submitted", updatedAt: new Date() })
    .where(eq(tenantsTable.id, tenantId));

  return saved;
}
