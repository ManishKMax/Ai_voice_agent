import { Router } from "express";
import { getAuth } from "@clerk/express";
import { getOrCreateTenant, getPricingConfig, submitKycDocument } from "./portal.service.js";
import { ObjectStorageService } from "../../lib/objectStorage.js";

const router = Router();
const objectStorageService = new ObjectStorageService();

const requireClerkAuth = (req: any, res: any, next: any) => {
  const auth = getAuth(req);
  if (!auth?.userId) {
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

/**
 * POST /api/portal/kyc/upload-url
 * Returns a presigned URL for direct-to-GCS upload of a KYC document.
 * Step 1 of the 2-step presigned upload flow.
 */
router.post("/kyc/upload-url", requireClerkAuth, async (req: any, res, next) => {
  try {
    const { name, size, contentType } = req.body;
    if (!name || !size || !contentType) {
      return res.status(400).json({ error: "name, size, contentType are required" });
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
router.post("/kyc/submit", requireClerkAuth, async (req: any, res, next) => {
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
      return res.status(400).json({ error: "documents array is required" });
    }

    const tenant = await getOrCreateTenant(clerkUserId, "User", "");
    const saved = await submitKycDocument(tenant.id, documents);

    res.json({ success: true, documents: saved });
  } catch (err) {
    next(err);
  }
});

export default router;
