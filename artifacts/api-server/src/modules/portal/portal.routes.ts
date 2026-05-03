import { Router } from "express";
import { getAuth } from "@clerk/express";
import { getOrCreateTenant, getPricingConfig } from "./portal.service.js";

const router = Router();

const requireClerkAuth = (req: any, res: any, next: any) => {
  const auth = getAuth(req);
  if (!auth?.userId) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  (req as any).clerkUserId = auth.userId;
  (req as any).clerkUser = auth;
  next();
};

router.get("/me", requireClerkAuth, async (req: any, res, next) => {
  try {
    const { clerkUserId } = req;
    const name = req.headers["x-clerk-user-name"] as string || "User";
    const email = req.headers["x-clerk-user-email"] as string || "";

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

export default router;
