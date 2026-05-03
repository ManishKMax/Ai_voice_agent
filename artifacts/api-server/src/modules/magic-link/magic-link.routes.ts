import { Router } from "express";
import { authMiddleware, requireRole } from "../../middlewares/auth.js";
import { generateMagicLink, consumeMagicLink } from "./magic-link.service.js";
import type { AuthRequest } from "../../middlewares/auth.js";

const router = Router();

router.post(
  "/magic-link",
  authMiddleware,
  requireRole("SUPER_ADMIN", "COMPANY_ADMIN"),
  async (req: AuthRequest, res, next): Promise<void> => {
    try {
      const { tenantId } = req.body;
      if (!tenantId || isNaN(Number(tenantId))) {
        res.status(400).json({ error: "tenantId is required" });
        return;
      }
      const result = await generateMagicLink(req.userId!, Number(tenantId));
      res.json(result);
    } catch (err) {
      next(err);
    }
  }
);

router.get("/magic-login", async (req, res, next): Promise<void> => {
  try {
    const token = req.query.token as string;
    if (!token) { res.status(400).json({ error: "token is required" }); return; }
    const result = await consumeMagicLink(token);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

export default router;
