import { Router } from "express";
import { authMiddleware } from "../../middlewares/auth.js";
import { getQueue, retryLead } from "./queue.controller.js";

const router = Router();

router.get("/queue", authMiddleware, getQueue);
router.post("/queue/:leadId/retry", authMiddleware, retryLead);

export default router;
