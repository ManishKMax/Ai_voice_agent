import { db, tenantsTable, kycDocumentsTable } from "@workspace/db";
import { eq, desc, sql } from "drizzle-orm";
import { sendKycDecisionEmail, sendLowBalanceEmail, LOW_BALANCE_THRESHOLD } from "../../services/email.service.js";

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

export async function adjustMinutes(tenantId: number, delta: number) {
  const before = await db
    .select({ minutesBalance: tenantsTable.minutesBalance, email: tenantsTable.email, name: tenantsTable.name })
    .from(tenantsTable)
    .where(eq(tenantsTable.id, tenantId))
    .limit(1);

  const oldBalance = before[0]?.minutesBalance ?? 0;

  const rows = await db
    .update(tenantsTable)
    .set({
      minutesBalance: sql`GREATEST(0, ${tenantsTable.minutesBalance} + ${delta})`,
      updatedAt: new Date(),
    })
    .where(eq(tenantsTable.id, tenantId))
    .returning({ minutesBalance: tenantsTable.minutesBalance });

  const newBalance = rows[0]?.minutesBalance ?? 0;

  if (before[0] && delta < 0) {
    const { email, name } = before[0];
    const crossedEmpty = oldBalance > 0 && newBalance === 0;
    const crossedLow = !crossedEmpty && oldBalance >= LOW_BALANCE_THRESHOLD && newBalance < LOW_BALANCE_THRESHOLD;
    if (crossedEmpty || crossedLow) {
      sendLowBalanceEmail(email, name, newBalance).catch(() => {});
    }
  }

  return newBalance;
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

  const tenant = await getTenantWithKyc(tenantId);
  if (tenant) {
    sendKycDecisionEmail(tenant.email, tenant.name, kycStatus, adminNotes).catch(() => {});
  }
  return tenant;
}
