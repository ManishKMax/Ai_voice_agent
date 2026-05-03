import { db } from "@workspace/db";
import { auditLogsTable } from "@workspace/db/schema";

interface AuditEntry {
  userId?: number;
  action: string;
  targetType?: string;
  targetId?: number;
  metadata?: Record<string, unknown>;
  ipAddress?: string;
}

export async function createAuditLog(entry: AuditEntry): Promise<void> {
  try {
    await db.insert(auditLogsTable).values({
      userId: entry.userId,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId,
      metadata: entry.metadata ?? null,
      ipAddress: entry.ipAddress,
    });
  } catch {
    // Non-blocking — audit failures should never break main flow
  }
}
