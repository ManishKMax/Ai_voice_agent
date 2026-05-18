import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import authRouter from "../modules/auth/auth.routes.js";
import leadsRouter from "../modules/leads/leads.routes.js";
import callsRouter from "../modules/calls/calls.routes.js";
import livekitRouter from "../modules/calls/livekit.routes.js";
import livekitWebhookRouter from "../modules/calls/livekit-webhook.routes.js";
import callOutcomeRouter from "../modules/calls/call-outcome.routes.js";
import callMetricsRouter from "../modules/calls/call-metrics.routes.js";
import queueRouter from "../modules/queue/queue.routes.js";
import dashboardRouter from "../modules/dashboard/dashboard.routes.js";
import aiRouter from "../modules/ai/ai.routes.js";
import agentRouter from "../modules/agent/agent.routes.js";
import settingsRouter from "../modules/settings/settings.routes.js";
import sseRouter from "../modules/sse/sse.routes.js";
import portalRouter from "../modules/portal/portal.routes.js";
import storageRouter from "./storage.js";
import adminRouter from "../modules/admin/admin.routes.js";
import usersRouter from "../modules/users/users.routes.js";
import magicLinkAdminRouter from "../modules/magic-link/magic-link.routes.js";
import magicLinkAuthRouter from "../modules/magic-link/magic-link.routes.js";
import subscriptionsRouter from "../modules/subscriptions/subscriptions.routes.js";
import razorpayRouter from "../modules/razorpay/razorpay.routes.js";
import reportsRouter from "../modules/reports/reports.routes.js";
import debugRouter from "../modules/debug/debug.routes.js";
import simulatorRouter from "../modules/simulator/simulator.routes.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(leadsRouter);
router.use(callsRouter);
router.use(livekitRouter);
router.use("/livekit", livekitWebhookRouter);
router.use("/calls", callOutcomeRouter);
router.use(callMetricsRouter);
router.use(queueRouter);
router.use(dashboardRouter);
router.use(aiRouter);
router.use(agentRouter);
router.use(settingsRouter);
router.use(sseRouter);
router.use("/portal", portalRouter);
router.use(storageRouter);
router.use("/admin", adminRouter);
router.use("/admin/users", usersRouter);
router.use("/admin", magicLinkAdminRouter);      // POST /admin/magic-link
router.use("/auth", magicLinkAuthRouter);         // GET  /auth/magic-login
router.use(subscriptionsRouter);
router.use(razorpayRouter);
router.use(reportsRouter);
router.use("/debug", debugRouter);
router.use("/simulator", simulatorRouter);

export default router;
