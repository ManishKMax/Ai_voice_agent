import { Router } from "express";
import { authMiddleware, requireRole } from "../../middlewares/auth.js";
import { getAuth } from "@clerk/express";
import {
  createSubscription,
  getCurrentSubscription,
  listSubscriptions,
  getAllSubscriptions,
} from "./subscriptions.service.js";
import { getTenantByClerkId } from "../portal/portal.service.js";
import type { AuthRequest } from "../../middlewares/auth.js";

const router = Router();

router.get(
  "/admin/subscriptions",
  authMiddleware,
  requireRole("SUPER_ADMIN", "COMPANY_ADMIN"),
  async (_req, res, next): Promise<void> => {
    try {
      const subscriptions = await getAllSubscriptions();
      res.json({ subscriptions });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  "/admin/subscriptions",
  authMiddleware,
  requireRole("SUPER_ADMIN", "COMPANY_ADMIN"),
  async (req: AuthRequest, res, next): Promise<void> => {
    try {
      const { tenantId } = req.body;
      if (!tenantId) { res.status(400).json({ error: "tenantId is required" }); return; }
      const sub = await createSubscription(Number(tenantId), req.userId);
      res.status(201).json({ subscription: sub });
    } catch (err) {
      next(err);
    }
  }
);

const requireClerkAuth = (req: any, res: any, next: any) => {
  const auth = getAuth(req);
  if (!auth?.userId) { res.status(401).json({ error: "Unauthorized" }); return; }
  (req as any).clerkUserId = auth.userId;
  next();
};

router.get("/portal/subscription", requireClerkAuth, async (req: any, res, next): Promise<void> => {
  try {
    const tenant = await getTenantByClerkId(req.clerkUserId);
    if (!tenant) { res.status(404).json({ error: "Tenant not found" }); return; }
    const sub = await getCurrentSubscription(tenant.id);
    const history = await listSubscriptions(tenant.id);
    res.json({ subscription: sub, history });
  } catch (err) {
    next(err);
  }
});

router.post("/portal/subscription", requireClerkAuth, async (req: any, res, next): Promise<void> => {
  try {
    const tenant = await getTenantByClerkId(req.clerkUserId);
    if (!tenant) { res.status(404).json({ error: "Tenant not found" }); return; }
    const sub = await createSubscription(tenant.id);
    res.status(201).json({ subscription: sub });
  } catch (err) {
    next(err);
  }
});

export default router;
