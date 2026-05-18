import { Router } from "express";
import { getAuth } from "@clerk/express";
import {
  getOrCreateTenant,
  getPricingConfig,
  submitKycDocument,
  getPortalUsage,
  getPortalUsageMonths,
  getPortalUsageForMonth,
  updateTenantCredentials,
  getTenantLeads,
  createTenantLead,
  deleteTenantLead,
  getTenantLead,
  getTenantByClerkId,
} from "./portal.service.js";
import { ObjectStorageService } from "../../lib/objectStorage.js";
import { logger } from "../../lib/logger.js";
import { triggerCallForLead } from "../calls/calls.service.js";
import { enqueueLead } from "../queue/queue.service.js";
import { testExotelCredentials } from "../../services/exotel.service.js";
import twilio from "twilio";

const router = Router();
const objectStorageService = new ObjectStorageService();

const requireClerkAuth = (req: any, res: any, next: any) => {
  const auth = getAuth(req);
  if (!auth?.userId) {
    const authHeader = req.headers.authorization || "";
    const hasBearer = authHeader.toLowerCase().startsWith("bearer ");
    // Do NOT log any portion of the bearer token — even a prefix is credential
    // material that could appear in shared logs.
    logger.warn({
      path: req.path,
      hasAuthHeader: !!authHeader,
      hasBearer,
      authReason: (auth as any)?.reason,
      authMessage: (auth as any)?.message,
      authState: (auth as any)?.sessionClaims ? "has-claims" : "no-claims",
      host: req.headers.host,
      origin: req.headers.origin,
    }, "Clerk auth rejected on portal route");
    return res.status(401).json({ error: "Unauthorized" });
  }
  (req as any).clerkUserId = auth.userId;
  next();
};

router.get("/me", requireClerkAuth, async (req: any, res, next) => {
  try {
    const { clerkUserId } = req;
    const name = (req.headers["x-clerk-user-name"] as string) || "User";
    const email = (req.headers["x-clerk-user-email"] as string) || "";

    const tenant = await getOrCreateTenant(clerkUserId, name, email);
    const pricing = await getPricingConfig();

    const trialLimit = pricing.trialCallsLimit;
    const trialCallsRemaining = Math.max(0, trialLimit - tenant.trialCallsUsed);
    const isTrialActive = tenant.kycStatus !== "approved";
    const canMakeCalls = !isTrialActive || tenant.minutesBalance > 0;

    res.json({
      tenant: {
        id: tenant.id,
        name: tenant.name,
        email: tenant.email,
        type: tenant.type,
        kycStatus: tenant.kycStatus,
        trialCallsUsed: tenant.trialCallsUsed,
        trialCallsRemaining,
        trialLimit,
        isTrialActive,
        canMakeCalls,
        minutesBalance: tenant.minutesBalance,
        telephonyProvider: tenant.telephonyProvider,
        isActive: tenant.isActive,
        createdAt: tenant.createdAt,
      },
      pricing: {
        perMinuteRatePaise: pricing.perMinuteRatePaise,
        perMinuteRateRupees: pricing.perMinuteRatePaise / 100,
        monthlyPlanCostPaise: pricing.monthlyPlanCostPaise,
        monthlyPlanCostRupees: pricing.monthlyPlanCostPaise / 100,
        monthlyMinutesQuota: pricing.monthlyMinutesQuota,
        trialCallsLimit: pricing.trialCallsLimit,
      },
    });
  } catch (err) {
    next(err);
  }
});

router.get("/debug/session", requireClerkAuth, async (req: any, res, next) => {
  try {
    const { clerkUserId } = req;
    const tenant = await getTenantByClerkId(clerkUserId);
    res.json({
      clerkUserId,
      hasTenant: !!tenant,
      tenant: tenant
        ? { id: tenant.id, name: tenant.name, email: tenant.email, createdAt: tenant.createdAt }
        : null,
    });
  } catch (err) {
    next(err);
  }
});

router.get("/usage/months", requireClerkAuth, async (req: any, res, next) => {
  try {
    const tenant = await getOrCreateTenant(req.clerkUserId, "User", "");
    const months = await getPortalUsageMonths(tenant.id);
    res.json(months);
  } catch (err) {
    next(err);
  }
});

router.get("/usage/invoice", requireClerkAuth, async (req: any, res, next) => {
  try {
    const year = parseInt(req.query.year as string);
    const month = parseInt(req.query.month as string);
    if (!year || !month || month < 1 || month > 12) {
      res.status(400).json({ error: "Valid year and month (1–12) are required" });
      return;
    }
    const tenant = await getOrCreateTenant(req.clerkUserId, "User", "");
    const data = await getPortalUsageForMonth(tenant.id, year, month);
    res.json(data);
  } catch (err) {
    next(err);
  }
});

router.get("/usage", requireClerkAuth, async (req: any, res, next) => {
  try {
    const tenant = await getOrCreateTenant(req.clerkUserId, "User", "");
    const limit = Math.min(100, Math.max(1, parseInt((req.query.limit as string) ?? "20")));
    const offset = Math.max(0, parseInt((req.query.offset as string) ?? "0"));
    const data = await getPortalUsage(limit, offset, tenant.id);
    res.json(data);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/portal/kyc/upload-url
 * Returns a presigned URL for direct-to-GCS upload of a KYC document.
 * Step 1 of the 2-step presigned upload flow.
 */
router.post("/kyc/upload-url", requireClerkAuth, async (req: any, res, next): Promise<void> => {
  try {
    const { name, size, contentType } = req.body;
    if (!name || !size || !contentType) {
      res.status(400).json({ error: "name, size, contentType are required" });
      return;
    }

    const uploadURL = await objectStorageService.getObjectEntityUploadURL();
    const objectPath = objectStorageService.normalizeObjectEntityPath(uploadURL);

    res.json({ uploadURL, objectPath, metadata: { name, size, contentType } });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/portal/kyc/submit
 * After the client uploads directly to GCS, call this to record the document in the DB
 * and update the tenant's KYC status to "submitted".
 */
router.post("/kyc/submit", requireClerkAuth, async (req: any, res, next): Promise<void> => {
  try {
    const { clerkUserId } = req;
    const { documents } = req.body as {
      documents: Array<{
        documentType: "aadhaar" | "gst";
        objectPath: string;
        fileName: string;
      }>;
    };

    if (!documents || !Array.isArray(documents) || documents.length === 0) {
      res.status(400).json({ error: "documents array is required" });
      return;
    }

    const tenant = await getOrCreateTenant(clerkUserId, "User", "");
    const saved = await submitKycDocument(tenant.id, documents);

    res.json({ success: true, documents: saved });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/portal/credentials
 * Returns the tenant's saved telephony credentials (auth tokens redacted).
 */
router.get("/credentials", requireClerkAuth, async (req: any, res, next) => {
  try {
    const tenant = await getOrCreateTenant(req.clerkUserId, "User", "");
    res.json({
      telephonyProvider: tenant.telephonyProvider ?? "twilio",
      twilio: {
        accountSid: tenant.twilioAccountSid ?? "",
        authTokenMasked: tenant.twilioAuthToken ? "••••••••" : "",
        phoneNumber: tenant.twilioPhoneNumber ?? "",
      },
      exotel: {
        accountSid: tenant.exotelAccountSid ?? "",
        apiKey: tenant.exotelApiKey ?? "",
        apiTokenMasked: tenant.exotelApiToken ? "••••••••" : "",
        phoneNumber: tenant.exotelPhoneNumber ?? "",
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/portal/credentials
 * Save the tenant's Twilio or Exotel credentials.
 */
router.patch("/credentials", requireClerkAuth, async (req: any, res, next): Promise<void> => {
  try {
    const tenant = await getOrCreateTenant(req.clerkUserId, "User", "");
    const body = req.body as {
      telephonyProvider?: "twilio" | "exotel" | "livekit";
      twilio?: { accountSid?: string; authToken?: string; phoneNumber?: string };
      exotel?: { accountSid?: string; apiKey?: string; apiToken?: string; phoneNumber?: string };
      livekit?: { sipTrunkId?: string; outboundNumber?: string };
    };

    if (body.telephonyProvider && !["twilio", "exotel", "livekit"].includes(body.telephonyProvider)) {
      res.status(400).json({ error: "telephonyProvider must be 'twilio', 'exotel', or 'livekit'" });
      return;
    }

    const updated = await updateTenantCredentials(tenant.id, {
      telephonyProvider: body.telephonyProvider,
      twilioAccountSid: body.twilio?.accountSid,
      twilioAuthToken: body.twilio?.authToken,
      twilioPhoneNumber: body.twilio?.phoneNumber,
      exotelAccountSid: body.exotel?.accountSid,
      exotelApiKey: body.exotel?.apiKey,
      exotelApiToken: body.exotel?.apiToken,
      exotelPhoneNumber: body.exotel?.phoneNumber,
      livekitSipTrunkId: body.livekit?.sipTrunkId,
      livekitSipOutboundNumber: body.livekit?.outboundNumber,
    });

    res.json({ success: true, telephonyProvider: updated.telephonyProvider });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/portal/credentials/test
 * Test the supplied credentials against the chosen provider's API.
 */
router.post("/credentials/test", requireClerkAuth, async (req: any, res): Promise<void> => {
  try {
    const { provider, twilio: t, exotel: e } = req.body as {
      provider: "twilio" | "exotel";
      twilio?: { accountSid?: string; authToken?: string };
      exotel?: { accountSid?: string; apiKey?: string; apiToken?: string };
    };

    if (provider === "twilio") {
      if (!t?.accountSid || !t?.authToken) {
        res.status(400).json({ success: false, message: "Account SID and Auth Token required" });
        return;
      }
      const client = twilio(t.accountSid, t.authToken);
      await client.api.v2010.accounts(t.accountSid).fetch();
      res.json({ success: true, message: "Twilio credentials are valid" });
      return;
    }

    if (provider === "exotel") {
      if (!e?.accountSid || !e?.apiKey || !e?.apiToken) {
        res.status(400).json({ success: false, message: "Account SID, API Key, and API Token required" });
        return;
      }
      await testExotelCredentials({
        accountSid: e.accountSid,
        apiKey: e.apiKey,
        apiToken: e.apiToken,
        phoneNumber: "",
      });
      res.json({ success: true, message: "Exotel credentials are valid" });
      return;
    }

    res.status(400).json({ success: false, message: "Unknown provider" });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Credential test failed";
    res.status(400).json({ success: false, message: msg });
  }
});

/**
 * GET /api/portal/leads — list this tenant's leads
 */
router.get("/leads", requireClerkAuth, async (req: any, res, next) => {
  try {
    const tenant = await getOrCreateTenant(req.clerkUserId, "User", "");
    const limit = parseInt((req.query.limit as string) ?? "50");
    const offset = parseInt((req.query.offset as string) ?? "0");
    const status = req.query.status as string | undefined;
    const data = await getTenantLeads(tenant.id, { limit, offset, status });
    res.json(data);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/portal/leads — create a lead and enqueue it for calling
 */
router.post("/leads", requireClerkAuth, async (req: any, res, next): Promise<void> => {
  try {
    const tenant = await getOrCreateTenant(req.clerkUserId, "User", "");
    const { name, phone, notes, tags, priority } = req.body as {
      name?: string; phone?: string; notes?: string; tags?: string; priority?: 1 | 2 | 3 | 4;
    };

    if (!name || !phone) {
      res.status(400).json({ error: "name and phone are required" });
      return;
    }

    if (tenant.kycStatus === "approved" && tenant.minutesBalance <= 0) {
      res.status(402).json({ error: "No calling minutes left. Please top up to continue." });
      return;
    }

    const lead = await createTenantLead(tenant.id, { name, phone, notes, tags, priority });
    enqueueLead(lead.id, 0, lead.priority);
    res.status(201).json({ success: true, lead });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/portal/leads/:id — delete a tenant's own lead
 */
router.delete("/leads/:id", requireClerkAuth, async (req: any, res, next): Promise<void> => {
  try {
    const tenant = await getOrCreateTenant(req.clerkUserId, "User", "");
    const id = parseInt(req.params.id);
    const deleted = await deleteTenantLead(tenant.id, id);
    if (!deleted) {
      res.status(404).json({ error: "Lead not found" });
      return;
    }
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/portal/leads/:id/retry — manually re-trigger a call for a lead
 */
router.post("/leads/:id/retry", requireClerkAuth, async (req: any, res, next): Promise<void> => {
  try {
    const tenant = await getOrCreateTenant(req.clerkUserId, "User", "");
    const id = parseInt(req.params.id);
    const lead = await getTenantLead(tenant.id, id);
    if (!lead) {
      res.status(404).json({ error: "Lead not found" });
      return;
    }
    enqueueLead(lead.id, 0, lead.priority);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

export default router;
