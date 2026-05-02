import { pgTable, serial, text, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const callAnalysisTable = pgTable("call_analysis", {
  id: serial("id").primaryKey(),
  callId: integer("call_id").notNull(),
  leadId: integer("lead_id").notNull(),
  interest: text("interest").$type<"high" | "medium" | "low">(),
  nextAction: text("next_action").$type<"demo" | "follow_up" | "drop">(),
  summary: text("summary"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertCallAnalysisSchema = createInsertSchema(callAnalysisTable).omit({
  id: true,
  createdAt: true,
});
export type InsertCallAnalysis = z.infer<typeof insertCallAnalysisSchema>;
export type CallAnalysis = typeof callAnalysisTable.$inferSelect;
