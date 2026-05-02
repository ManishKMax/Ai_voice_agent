import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const apiKeysTable = pgTable("api_keys", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  keyHash: text("key_hash").notNull().unique(),
  keyPrefix: text("key_prefix").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  lastUsedAt: timestamp("last_used_at"),
});

export type ApiKey = typeof apiKeysTable.$inferSelect;
