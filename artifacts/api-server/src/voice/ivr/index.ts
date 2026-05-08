import { eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { leadsTable, tenantsTable } from "@workspace/db/schema";
import { logger } from "../../lib/logger.js";
import type { IvrProvider, IvrProviderId } from "./types.js";
import { TwilioMediaStreamsProvider } from "./twilio-provider.js";
import { ExotelMediaStreamsProvider } from "./exotel-provider.js";

/**
 * Provider registry. Adding a new IVR (e.g. Plivo) is two lines:
 *   1. Implement `IvrProvider` in voice/ivr/<plivo>-provider.ts
 *   2. Register the singleton here keyed by its `IvrProviderId`.
 *
 * Singletons are safe because providers are stateless — every per-call piece
 * of state lives on the CallSession instance.
 */
const REGISTRY: Record<IvrProviderId, IvrProvider> = {
  twilio: new TwilioMediaStreamsProvider(),
  exotel: new ExotelMediaStreamsProvider(),
};

/**
 * Production safety gate. The Exotel provider is a scaffold — its envelope
 * keys, codec defaults, and connect XML are documented but not verified
 * against a live Exotel account, and `media-stream.ts` still parses Twilio's
 * envelope shape (a separate Phase-5 follow-up). Routing real Exotel-tenant
 * traffic into that path would produce silent calls. So unless an operator
 * explicitly opts in via `EXOTEL_WS_ENABLED=1`, we fall back to the Twilio
 * provider and log a warning so the misconfiguration is visible. Test envs
 * (`NODE_ENV=test`) bypass the gate so the registry remains exercisable.
 */
function isProviderEnabled(id: IvrProviderId): boolean {
  if (id === "twilio") return true;
  if (id === "exotel") {
    if (process.env["NODE_ENV"] === "test") return true;
    return process.env["EXOTEL_WS_ENABLED"] === "1";
  }
  return false;
}

/** Get a provider by id, falling back to Twilio for unknown / disabled values. */
export function getIvrProvider(id: string | null | undefined): IvrProvider {
  if (id === "twilio" || id === "exotel") {
    if (isProviderEnabled(id)) return REGISTRY[id];
    logger.warn(
      { requestedProvider: id, fallback: "twilio" },
      "ivr_provider_disabled_falling_back_to_twilio",
    );
    return REGISTRY.twilio;
  }
  return REGISTRY.twilio;
}

/**
 * Resolve the IvrProvider that should handle a given lead.
 *
 *   - Lead has no tenant → platform default (Twilio).
 *   - Lead has a tenant → use `tenants.telephony_provider`, falling back to
 *     Twilio when null/unknown.
 *
 * This mirrors the routing logic in `calls.service.dispatchCall()` so the
 * webhook response and the WS-pipeline codec stay in lock-step for a given
 * call. If the two ever drift, the carrier will hear silence.
 */
export async function resolveProviderForLead(leadId: number): Promise<IvrProvider> {
  if (!leadId || Number.isNaN(leadId)) return REGISTRY.twilio;
  try {
    const [row] = await db
      .select({
        tenantId: leadsTable.tenantId,
        telephonyProvider: tenantsTable.telephonyProvider,
      })
      .from(leadsTable)
      .leftJoin(tenantsTable, eq(tenantsTable.id, leadsTable.tenantId))
      .where(eq(leadsTable.id, leadId))
      .limit(1);
    if (!row) return REGISTRY.twilio;
    return getIvrProvider(row.telephonyProvider);
  } catch (err) {
    logger.warn({ err, leadId }, "resolveProviderForLead_failed_using_twilio_default");
    return REGISTRY.twilio;
  }
}

export type { IvrProvider, IvrProviderId } from "./types.js";
export { TwilioMediaStreamsProvider } from "./twilio-provider.js";
export { ExotelMediaStreamsProvider } from "./exotel-provider.js";
