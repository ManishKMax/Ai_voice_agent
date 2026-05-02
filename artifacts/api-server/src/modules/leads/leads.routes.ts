import { Router } from "express";
import multer from "multer";
import { authMiddleware } from "../../middlewares/auth.js";
import {
  addLead,
  uploadLeads,
  listLeads,
  getLead,
  exportLeads,
} from "./leads.controller.js";

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

router.post("/leads", authMiddleware, addLead);
router.post("/leads/upload", authMiddleware, upload.single("file"), uploadLeads);
router.get("/leads", authMiddleware, listLeads);
router.get("/leads/export", authMiddleware, exportLeads);
router.get("/leads/:id", authMiddleware, getLead);

export default router;
