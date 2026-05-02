import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import authRouter from "../modules/auth/auth.routes.js";
import leadsRouter from "../modules/leads/leads.routes.js";
import callsRouter from "../modules/calls/calls.routes.js";
import queueRouter from "../modules/queue/queue.routes.js";
import dashboardRouter from "../modules/dashboard/dashboard.routes.js";
import aiRouter from "../modules/ai/ai.routes.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(leadsRouter);
router.use(callsRouter);
router.use(queueRouter);
router.use(dashboardRouter);
router.use(aiRouter);

export default router;
