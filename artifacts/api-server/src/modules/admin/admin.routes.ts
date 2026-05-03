import { Router } from "express";
import { authMiddleware, requireRole } from "../../middlewares/auth.js";
import {
  listTenantsWithKyc,
  getTenantWithKyc,
  updateTenantKyc,
  adjustMinutes,
} from "./admin.service.js";
import { db } from "@workspace/db";
import { tenantsTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { platformSettings } from "../../config/platform.config.js";
import { createAuditLog } from "../audit/audit.service.js";
import type { AuthRequest } from "../../middlewares/auth.js";

const router = Router();

router.use(authMiddleware);
router.use(requireRole("SUPER_ADMIN", "COMPANY_ADMIN"));

router.get("/tenants", async (_req, res, next): Promise<void> => {
  try {
    const tenants = await listTenantsWithKyc();
    res.json({ tenants });
  } catch (err) {
    next(err);
  }
});

router.get("/tenants/:id", async (req, res, next): Promise<void> => {
  try {
    const id = parseInt(req.params["id"] as string, 10);
    if (isNaN(id)) { res.status(400).json({ error: "Invalid tenant ID" }); return; }
    const tenant = await getTenantWithKyc(id);
    if (!tenant) { res.status(404).json({ error: "Tenant not found" }); return; }
    res.json({ tenant });
  } catch (err) {
    next(err);
  }
});

router.patch("/tenants/:id/kyc", async (req, res, next): Promise<void> => {
  try {
    const id = parseInt(req.params["id"] as string, 10);
    if (isNaN(id)) { res.status(400).json({ error: "Invalid tenant ID" }); return; }

    const { kycStatus, adminNotes } = req.body;
    if (!["approved", "rejected"].includes(kycStatus)) {
      res.status(400).json({ error: "kycStatus must be 'approved' or 'rejected'" });
      return;
    }

    const tenant = await updateTenantKyc(id, { kycStatus, adminNotes });
    res.json({ tenant });
  } catch (err) {
    next(err);
  }
});

router.patch("/tenants/:id/minutes", async (req, res, next): Promise<void> => {
  try {
    const id = parseInt(req.params["id"] as string, 10);
    if (isNaN(id)) { res.status(400).json({ error: "Invalid tenant ID" }); return; }

    const delta = Number(req.body.delta);
    if (!Number.isFinite(delta) || delta === 0) {
      res.status(400).json({ error: "delta must be a non-zero number" });
      return;
    }

    const minutesBalance = await adjustMinutes(id, Math.round(delta));
    res.json({ minutesBalance });
  } catch (err) {
    next(err);
  }
});

router.patch(
  "/tenants/:id/sarvam",
  requireRole("SUPER_ADMIN", "COMPANY_ADMIN"),
  async (req: AuthRequest, res, next): Promise<void> => {
    try {
      const id = parseInt(req.params["id"] as string, 10);
      if (isNaN(id)) { res.status(400).json({ error: "Invalid tenant ID" }); return; }

      const { sarvamEnabled } = req.body;
      if (typeof sarvamEnabled !== "boolean") {
        res.status(400).json({ error: "sarvamEnabled must be a boolean" });
        return;
      }

      if (sarvamEnabled && platformSettings.sarvamEnabled) {
        const sarvamUsers = await db
          .select({ id: tenantsTable.id })
          .from(tenantsTable)
          .where(eq(tenantsTable.sarvamEnabled, true));

        const maxUsers = platformSettings.sarvamMaxUsers ?? 50;
        if (sarvamUsers.length >= maxUsers) {
          res.status(400).json({
            error: `Sarvam access limit reached (${maxUsers} users). Increase the platform limit in Settings.`,
          });
          return;
        }
      }

      const [updated] = await db
        .update(tenantsTable)
        .set({ sarvamEnabled, updatedAt: new Date() })
        .where(eq(tenantsTable.id, id))
        .returning({ id: tenantsTable.id, sarvamEnabled: tenantsTable.sarvamEnabled });

      if (!updated) { res.status(404).json({ error: "Tenant not found" }); return; }

      await createAuditLog({
        userId: req.userId,
        action: sarvamEnabled ? "SARVAM_ENABLED_FOR_TENANT" : "SARVAM_DISABLED_FOR_TENANT",
        targetType: "tenant",
        targetId: id,
      });

      res.json({ tenant: updated });
    } catch (err) {
      next(err);
    }
  }
);

router.get("/sarvam/stats", requireRole("SUPER_ADMIN", "COMPANY_ADMIN"), async (_req, res, next): Promise<void> => {
  try {
    const sarvamUsers = await db
      .select({ id: tenantsTable.id, name: tenantsTable.name, email: tenantsTable.email })
      .from(tenantsTable)
      .where(eq(tenantsTable.sarvamEnabled, true));

    res.json({
      enabled: sarvamUsers.length,
      maxUsers: platformSettings.sarvamMaxUsers ?? 50,
      platformEnabled: platformSettings.sarvamEnabled,
      tenants: sarvamUsers,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
