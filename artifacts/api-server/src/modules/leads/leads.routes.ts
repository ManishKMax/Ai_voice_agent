import { Router } from "express";
import multer from "multer";
import { authMiddleware } from "../../middlewares/auth.js";
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

router.post("/leads", authMiddleware, addLead);
router.post("/leads/upload", authMiddleware, upload.single("file"), uploadLeads);
router.post("/leads/bulk", authMiddleware, bulkAction);
router.get("/leads", authMiddleware, listLeads);
router.get("/leads/export", authMiddleware, exportLeads);
router.get("/leads/:id", authMiddleware, getLead);
router.patch("/leads/:id", authMiddleware, patchLead);
router.delete("/leads/:id", authMiddleware, removeLead);

export default router;
