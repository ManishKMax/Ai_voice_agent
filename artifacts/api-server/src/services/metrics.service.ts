import { and, eq, gte, lte, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { callMetricsTable, callsTable, type InsertCallMetrics } from "@workspace/db/schema";
import { logger } from "../lib/logger.js";

/**
 * Fire-and-forget insertion of a per-turn metrics row. Failures are logged
 * but never thrown — the call hot path must not be blocked by DB latency.
 */
export function recordTurnMetrics(row: InsertCallMetrics): void {
  void db
    .insert(callMetricsTable)
    .values(row)
    .catch((err) => {
      logger.warn(
        { err: (err as Error).message, call_id: row.callId, turn_id: row.turnId },
        "call_metrics_persist_failed",
      );
    });
}

/**
 * Fetch the per-turn metrics for a given DB call id, ordered by turn.
 * Used by `/api/calls/:callId/metrics` and the simulator UI panel.
 */
export async function getCallMetrics(callId: number) {
  return db
    .select()
    .from(callMetricsTable)
    .where(eq(callMetricsTable.callId, callId))
    .orderBy(callMetricsTable.turnId);
}

/**
 * Resolve a Twilio call SID (the value `CallSession` knows) to a DB call id.
 * Returns null if no matching row — caller skips persistence in that case.
 */
export async function findCallIdBySid(sid: string): Promise<number | null> {
  const [row] = await db
    .select({ id: callsTable.id })
    .from(callsTable)
    .where(eq(callsTable.twilioCallSid, sid))
    .limit(1);
  return row?.id ?? null;
}

export interface LatencyAggregateQuery {
  providerId?: string;
  from?: Date;
  to?: Date;
  groupBy?: "day" | "hour";
}

/**
 * Aggregate p50 / p95 / p99 of every numeric latency metric, bucketed by
 * `day` (default) or `hour`. Used by the Reports → Voice Latency trends
 * widget.
 *
 * Postgres `percentile_cont` is interpolated, which is appropriate for
 * latency distributions.
 */
export async function getLatencyAggregates(q: LatencyAggregateQuery) {
  const bucket = q.groupBy === "hour" ? "hour" : "day";
  const conds = [];
  if (q.providerId) conds.push(eq(callMetricsTable.llmProvider, q.providerId));
  if (q.from) conds.push(gte(callMetricsTable.createdAt, q.from));
  if (q.to) conds.push(lte(callMetricsTable.createdAt, q.to));
  const whereClause = conds.length ? and(...conds) : undefined;

  const numericCols = [
    "stt_latency_ms",
    "llm_first_token_ms",
    "first_word_trigger_ms",
    "tts_stream_start_ms",
    "first_playback_ms",
    "first_audio_chunk_ms",
    "tts_complete_ms",
    "llm_latency_ms",
    "tts_latency_ms",
    "total_roundtrip_ms",
    "livekit_transport_ms",
  ];

  const exprs = numericCols.flatMap((col) => [
    sql.raw(`percentile_cont(0.5)  within group (order by ${col}) as ${col}_p50`),
    sql.raw(`percentile_cont(0.95) within group (order by ${col}) as ${col}_p95`),
    sql.raw(`percentile_cont(0.99) within group (order by ${col}) as ${col}_p99`),
  ]);
  exprs.push(sql.raw(`avg(llm_tokens_per_sec) as llm_tokens_per_sec_avg`));

  const rows = await db.execute<Record<string, number | string | null>>(sql`
    select
      date_trunc(${bucket}, created_at) as bucket,
      llm_provider as provider_id,
      count(*)::int as turn_count,
      ${sql.join(exprs, sql`, `)}
    from call_metrics
    ${whereClause ? sql`where ${whereClause}` : sql``}
    group by bucket, llm_provider
    order by bucket asc
  `);
  return rows.rows;
}
