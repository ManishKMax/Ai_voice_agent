import { db, tenantsTable, kycDocumentsTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";

export async function listTenantsWithKyc() {
  const tenants = await db
    .select()
    .from(tenantsTable)
    .orderBy(desc(tenantsTable.createdAt));

  const docs = await db
    .select()
    .from(kycDocumentsTable)
    .orderBy(desc(kycDocumentsTable.createdAt));

  const docsByTenant = docs.reduce<Record<number, typeof docs>>(
    (acc, doc) => {
      if (!acc[doc.tenantId]) acc[doc.tenantId] = [];
      acc[doc.tenantId].push(doc);
      return acc;
    },
    {},
  );

  return tenants.map((t) => ({
    ...t,
    documents: docsByTenant[t.id] ?? [],
  }));
}

export async function getTenantWithKyc(tenantId: number) {
  const rows = await db
    .select()
    .from(tenantsTable)
    .where(eq(tenantsTable.id, tenantId))
    .limit(1);

  if (!rows[0]) return null;

  const docs = await db
    .select()
    .from(kycDocumentsTable)
    .where(eq(kycDocumentsTable.tenantId, tenantId))
    .orderBy(desc(kycDocumentsTable.createdAt));

  return { ...rows[0], documents: docs };
}

export async function updateTenantKyc(
  tenantId: number,
  decision: {
    kycStatus: "approved" | "rejected";
    adminNotes?: string;
  },
) {
  const { kycStatus, adminNotes } = decision;

  await db
    .update(tenantsTable)
    .set({ kycStatus, updatedAt: new Date() })
    .where(eq(tenantsTable.id, tenantId));

  if (adminNotes !== undefined) {
    await db
      .update(kycDocumentsTable)
      .set({ adminNotes, status: kycStatus === "approved" ? "approved" : "rejected", updatedAt: new Date() })
      .where(eq(kycDocumentsTable.tenantId, tenantId));
  }

  return getTenantWithKyc(tenantId);
}
