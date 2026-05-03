import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import authRouter from "../modules/auth/auth.routes.js";
import leadsRouter from "../modules/leads/leads.routes.js";
import callsRouter from "../modules/calls/calls.routes.js";
import queueRouter from "../modules/queue/queue.routes.js";
import dashboardRouter from "../modules/dashboard/dashboard.routes.js";
import aiRouter from "../modules/ai/ai.routes.js";
import agentRouter from "../modules/agent/agent.routes.js";
import settingsRouter from "../modules/settings/settings.routes.js";
import sseRouter from "../modules/sse/sse.routes.js";
import portalRouter from "../modules/portal/portal.routes.js";
import storageRouter from "./storage.js";
import adminRouter from "../modules/admin/admin.routes.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(leadsRouter);
router.use(callsRouter);
router.use(queueRouter);
router.use(dashboardRouter);
router.use(aiRouter);
router.use(agentRouter);
router.use(settingsRouter);
router.use(sseRouter);
router.use("/portal", portalRouter);
router.use(storageRouter);
router.use("/admin", adminRouter);

export default router;
