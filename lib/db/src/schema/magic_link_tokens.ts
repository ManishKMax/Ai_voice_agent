import { pgTable, serial, integer, text, timestamp, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const magicLinkTokensTable = pgTable("magic_link_tokens", {
  id: serial("id").primaryKey(),
  token: text("token").notNull().unique(),
  tenantId: integer("tenant_id").notNull(),
  createdByUserId: integer("created_by_user_id").notNull(),
  used: boolean("used").default(false).notNull(),
  usedAt: timestamp("used_at"),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertMagicLinkTokenSchema = createInsertSchema(magicLinkTokensTable).omit({
  id: true,
  createdAt: true,
  used: true,
  usedAt: true,
});
export type InsertMagicLinkToken = z.infer<typeof insertMagicLinkTokenSchema>;
export type MagicLinkToken = typeof magicLinkTokensTable.$inferSelect;
