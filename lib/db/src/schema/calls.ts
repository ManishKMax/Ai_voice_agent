import { pgTable, serial, text, integer, timestamp, date } from "drizzle-orm/pg-core";
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
