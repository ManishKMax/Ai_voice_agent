import { Router } from "express";
import { authMiddleware } from "../../middlewares/auth.js";
import {
  listTenantsWithKyc,
  getTenantWithKyc,
  updateTenantKyc,
  adjustMinutes,
} from "./admin.service.js";

const router = Router();

router.use(authMiddleware);

router.get("/tenants", async (req, res, next) => {
  try {
    const tenants = await listTenantsWithKyc();
    res.json({ tenants });
  } catch (err) {
    next(err);
  }
});

router.get("/tenants/:id", async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid tenant ID" });
    const tenant = await getTenantWithKyc(id);
    if (!tenant) return res.status(404).json({ error: "Tenant not found" });
    res.json({ tenant });
  } catch (err) {
    next(err);
  }
});

router.patch("/tenants/:id/kyc", async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid tenant ID" });

    const { kycStatus, adminNotes } = req.body;
    if (!["approved", "rejected"].includes(kycStatus)) {
      return res.status(400).json({ error: "kycStatus must be 'approved' or 'rejected'" });
    }

    const tenant = await updateTenantKyc(id, { kycStatus, adminNotes });
    res.json({ tenant });
  } catch (err) {
    next(err);
  }
});

router.patch("/tenants/:id/minutes", async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid tenant ID" });

    const delta = Number(req.body.delta);
    if (!Number.isFinite(delta) || delta === 0) {
      return res.status(400).json({ error: "delta must be a non-zero number" });
    }

    const minutesBalance = await adjustMinutes(id, Math.round(delta));
    res.json({ minutesBalance });
  } catch (err) {
    next(err);
  }
});

export default router;
