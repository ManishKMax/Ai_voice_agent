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

/** Get a provider by id, falling back to Twilio for unknown values. */
export function getIvrProvider(id: string | null | undefined): IvrProvider {
  if (id === "twilio" || id === "exotel") return REGISTRY[id];
  return REGISTRY.twilio;
}

/** Default provider used by media-stream during the WS handshake, before the
 * `start` envelope is parsed and we know which tenant the call belongs to.
 * Twilio is the safest default because every existing call today is Twilio
 * and Twilio's parser is the most permissive (camelCase keys). The
 * subscriber re-resolves the per-tenant provider as soon as it sees the
 * leadId from customParameters. */
export function getDefaultIvrProvider(): IvrProvider {
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

export type { IvrProvider, IvrProviderId, IvrEnvelope } from "./types.js";
export { TwilioMediaStreamsProvider } from "./twilio-provider.js";
export { ExotelMediaStreamsProvider } from "./exotel-provider.js";
