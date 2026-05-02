import { pgTable, serial, text, integer, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const leadStatusEnum = [
  "pending",
  "calling",
  "completed",
  "interested",
  "not_interested",
  "no_response",
  "callback",
  "dnc",
] as const;

export type LeadStatus = (typeof leadStatusEnum)[number];

export const leadPriorityEnum = [1, 2, 3, 4] as const;
export type LeadPriority = (typeof leadPriorityEnum)[number];

export const leadsTable = pgTable("leads", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  phone: text("phone").notNull(),
  source: text("source").default("manual"),
  sourceId: text("source_id"),
  status: text("status").$type<LeadStatus>().default("pending").notNull(),
  retryCount: text("retry_count").default("0").notNull(),
  notes: text("notes"),
  tags: text("tags").default("").notNull(),
  priority: integer("priority").$type<LeadPriority>().default(2).notNull(),
  dnc: boolean("dnc").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertLeadSchema = createInsertSchema(leadsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  status: true,
  retryCount: true,
  dnc: true,
  tags: true,
  priority: true,
});
export type InsertLead = z.infer<typeof insertLeadSchema>;
export type Lead = typeof leadsTable.$inferSelect;
