import { pgTable, serial, text, integer, timestamp, date, real, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const callStatusEnum = [
  "initiated",
  "ringing",
  "answered",
  "completed",
  "no-answer",
  "busy",
  "failed",
] as const;

export type CallStatus = (typeof callStatusEnum)[number];

export const callOutcomeEnum = [
  "INTERESTED",
  "NOT_INTERESTED",
  "NO_RESPONSE",
] as const;
export type CallOutcome = (typeof callOutcomeEnum)[number];

export const callsTable = pgTable("calls", {
  id: serial("id").primaryKey(),
  leadId: integer("lead_id").notNull(),
  twilioCallSid: text("twilio_call_sid"),
  callStatus: text("call_status").$type<CallStatus>().default("initiated").notNull(),
  duration: integer("duration"),
  recordingUrl: text("recording_url"),
  transcript: text("transcript"),
  interestScore: integer("interest_score"),
  answeredBy: text("answered_by"),
  outcome: text("outcome").$type<CallOutcome>(),
  followUpDate: date("follow_up_date"),
  followUpTime: text("follow_up_time"),
  outcomeNotes: text("outcome_notes"),
  // Origin of the call. `"production"` (default) covers real PSTN traffic
  // — Twilio, Exotel, future SIP carriers. `"simulator"` is reserved for
  // in-browser Call Simulator runs (Task #31) so analytics + reports can
  // filter them out (`where source <> 'simulator'`). Free-form text so we
  // can introduce new sources (e.g. `"loadtest"`) without a migration.
  source: text("source").default("production").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertCallSchema = createInsertSchema(callsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertCall = z.infer<typeof insertCallSchema>;
export type Call = typeof callsTable.$inferSelect;

/**
 * Per-turn latency metrics for live voice calls.
 * Written fire-and-forget by `CallSession` after each conversational turn.
 * No PII — only timing data and provider IDs.
 *
 * Field semantics (all *_ms columns are wall-clock milliseconds):
 *  - stt_latency_ms          end-of-utterance → STT final transcript
 *  - llm_first_token_ms      STT-final → LLM first token (= llm_latency_ms for non-streaming providers)
 *  - llm_tokens_per_sec      completion tokens / (llm_complete - llm_first_token) seconds; null if usage missing
 *  - first_word_trigger_ms   LLM first token → first sentence handed to TTS
 *  - tts_stream_start_ms     first TTS HTTP request → first TTS bytes returned
 *  - first_playback_ms       TTS first bytes → first outbound audio frame on the wire
 *  - first_audio_chunk_ms    start-of-turn → first outbound audio frame (alias of total_roundtrip)
 *  - tts_playback_start_at   absolute wall-clock timestamp of first outbound audio frame
 *  - tts_complete_ms         TTS first bytes → last outbound audio frame
 *  - llm_latency_ms          LLM request sent → LLM response complete
 *  - tts_latency_ms          first TTS HTTP request → last outbound audio frame
 *  - total_roundtrip_ms      end-of-utterance → first outbound audio frame (user-perceived lag)
 *  - livekit_transport_ms    LiveKit RTT (null for Twilio/Exotel; populated by Task #30)
 */
export const callMetricsTable = pgTable(
  "call_metrics",
  {
    id: serial("id").primaryKey(),
    callId: integer("call_id").notNull(),
    turnId: integer("turn_id").notNull(),
    llmProvider: text("llm_provider").notNull(),
    llmModel: text("llm_model"),
    sttLatencyMs: integer("stt_latency_ms"),
    llmFirstTokenMs: integer("llm_first_token_ms"),
    llmTokensPerSec: real("llm_tokens_per_sec"),
    firstWordTriggerMs: integer("first_word_trigger_ms"),
    ttsStreamStartMs: integer("tts_stream_start_ms"),
    firstPlaybackMs: integer("first_playback_ms"),
    firstAudioChunkMs: integer("first_audio_chunk_ms"),
    ttsPlaybackStartAt: timestamp("tts_playback_start_at"),
    ttsCompleteMs: integer("tts_complete_ms"),
    llmLatencyMs: integer("llm_latency_ms"),
    ttsLatencyMs: integer("tts_latency_ms"),
    totalRoundtripMs: integer("total_roundtrip_ms"),
    livekitTransportMs: integer("livekit_transport_ms"),
    /** Task #31 — row source. "production" for real lead calls, "simulator"
     *  for in-browser Call Simulator runs. Lets the Reports → Voice Latency
     *  widget exclude operator test calls directly without joining `calls`. */
    source: text("source").default("production").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("call_metrics_call_turn_idx").on(t.callId, t.turnId),
    index("call_metrics_created_provider_idx").on(t.createdAt, t.llmProvider),
    index("call_metrics_source_idx").on(t.source),
  ],
);

export const insertCallMetricsSchema = createInsertSchema(callMetricsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertCallMetrics = z.infer<typeof insertCallMetricsSchema>;
export type CallMetrics = typeof callMetricsTable.$inferSelect;
