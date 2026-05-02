import { Router } from "express";
import multer from "multer";
import type { Request, Response, NextFunction } from "express";
import { authMiddleware } from "../../middlewares/auth.js";
import { apiKeyMiddleware } from "../../middlewares/apikey.js";
import {
  addLead,
  uploadLeads,
  listLeads,
  getLead,
  exportLeads,
  patchLead,
  removeLead,
  bulkAction,
} from "./leads.controller.js";

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

function jwtOrApiKey(req: Request, res: Response, next: NextFunction) {
  const hasBearer = typeof req.headers.authorization === "string" && req.headers.authorization.startsWith("Bearer ");
  const hasApiKey = typeof req.headers["x-api-key"] === "string";

  if (hasBearer) {
    return authMiddleware(req, res, next);
  }
  if (hasApiKey) {
    return apiKeyMiddleware(req, res, next);
  }
  return authMiddleware(req, res, next);
}

router.post("/leads", jwtOrApiKey, addLead);
router.post("/leads/upload", authMiddleware, upload.single("file"), uploadLeads);
router.post("/leads/bulk", authMiddleware, bulkAction);
router.get("/leads", authMiddleware, listLeads);
router.get("/leads/export", authMiddleware, exportLeads);
router.get("/leads/:id", authMiddleware, getLead);
router.patch("/leads/:id", authMiddleware, patchLead);
router.delete("/leads/:id", authMiddleware, removeLead);

export default router;
