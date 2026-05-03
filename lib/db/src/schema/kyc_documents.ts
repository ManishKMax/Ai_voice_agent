import { pgTable, serial, integer, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const kycDocumentTypeEnum = ["aadhaar", "gst"] as const;
export type KycDocumentType = (typeof kycDocumentTypeEnum)[number];

export const kycDocumentStatusEnum = ["pending", "approved", "rejected"] as const;
export type KycDocumentStatus = (typeof kycDocumentStatusEnum)[number];

export const kycDocumentsTable = pgTable("kyc_documents", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull(),
  documentType: text("document_type").$type<KycDocumentType>().notNull(),
  fileUrl: text("file_url"),
  fileName: text("file_name"),
  status: text("status").$type<KycDocumentStatus>().default("pending").notNull(),
  adminNotes: text("admin_notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertKycDocumentSchema = createInsertSchema(kycDocumentsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  status: true,
  adminNotes: true,
});

export type InsertKycDocument = z.infer<typeof insertKycDocumentSchema>;
export type KycDocument = typeof kycDocumentsTable.$inferSelect;
