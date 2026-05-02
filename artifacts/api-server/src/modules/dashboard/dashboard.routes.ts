import { Router } from "express";
import { authMiddleware } from "../../middlewares/auth.js";
import { getDashboardStats } from "./dashboard.controller.js";

const router = Router();

router.get("/dashboard/stats", authMiddleware, getDashboardStats);

export default router;
