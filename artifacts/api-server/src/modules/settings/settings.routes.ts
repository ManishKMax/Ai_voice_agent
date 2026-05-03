import { Router } from "express";
import { authMiddleware as requireAuth } from "../../middlewares/auth.js";
import {
  getSettings,
  patchSettings,
  testTwilio,
  testSarvam,
  getTwilioNumbers,
  getWebhookInfo,
  testWebhook,
  testEmail,
  testLowBalanceEmail,
  listApiKeys,
  createApiKey,
  deleteApiKey,
} from "./settings.controller.js";

const router = Router();

router.get("/settings", requireAuth, getSettings);
router.patch("/settings", requireAuth, patchSettings);
router.post("/settings/test-twilio", requireAuth, testTwilio);
router.post("/settings/test-sarvam", requireAuth, testSarvam);
router.get("/settings/twilio-numbers", requireAuth, getTwilioNumbers);
router.get("/settings/webhook-info", requireAuth, getWebhookInfo);
router.post("/settings/test-webhook", requireAuth, testWebhook);
router.post("/settings/test-email", requireAuth, testEmail);
router.post("/settings/test-low-balance-email", requireAuth, testLowBalanceEmail);

router.get("/settings/api-keys", requireAuth, listApiKeys);
router.post("/settings/api-keys", requireAuth, createApiKey);
router.delete("/settings/api-keys/:keyId", requireAuth, deleteApiKey);

export default router;
