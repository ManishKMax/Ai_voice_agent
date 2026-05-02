import type { Response } from "express";
import type { AuthRequest } from "../../middlewares/auth.js";
import {
  createLead,
  createLeadsFromCSV,
  getLeads,
  exportLeadsCSV,
  getLeadById,
} from "./leads.service.js";
import { parse } from "csv-parse/sync";
import type { InsertLead } from "@workspace/db/schema";
import { leadStatusEnum } from "@workspace/db/schema";

/** Validate that a string is an E.164-format phone number: +[country][number] */
function isValidPhone(phone: string): boolean {
  return /^\+[1-9]\d{7,14}$/.test(phone.trim());
}

/** Normalise a status query param — returns undefined if invalid */
function parseLeadStatus(raw: string | undefined) {
  if (!raw) return undefined;
  return (leadStatusEnum as readonly string[]).includes(raw)
    ? (raw as (typeof leadStatusEnum)[number])
    : undefined;
}

export async function addLead(req: AuthRequest, res: Response): Promise<void> {
  try {
    const { name, phone, source, notes } = req.body as Record<string, string>;

    if (!name || !phone) {
      res.status(400).json({ error: "name and phone are required" });
      return;
    }

    if (!isValidPhone(phone)) {
      res.status(400).json({
        error: "phone must be in E.164 format (e.g. +919876543210)",
      });
      return;
    }

    const lead = await createLead({ name: name.trim(), phone: phone.trim(), source, notes });
    res.status(201).json({ message: "Lead created", lead });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Failed to create lead";
    res.status(500).json({ error: msg });
  }
}

export async function uploadLeads(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!req.file) {
      res.status(400).json({ error: "CSV file is required" });
      return;
    }

    const records = parse(req.file.buffer, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
    }) as Array<{ name?: string; phone?: string; source?: string; notes?: string }>;

    const invalid: string[] = [];
    const rows: InsertLead[] = [];

    for (const r of records) {
      if (!r.name || !r.phone) continue;
      if (!isValidPhone(r.phone)) {
        invalid.push(r.phone);
        continue;
      }
      rows.push({
        name: r.name,
        phone: r.phone,
        source: r.source ?? "csv",
        notes: r.notes,
      });
    }

    if (rows.length === 0) {
      res.status(400).json({
        error: "No valid rows found in CSV (need name and E.164 phone columns)",
        invalidPhones: invalid,
      });
      return;
    }

    const leads = await createLeadsFromCSV(rows);
    res.status(201).json({
      message: `${leads.length} leads imported`,
      leads,
      ...(invalid.length > 0 && { skippedInvalidPhones: invalid }),
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "CSV upload failed";
    res.status(500).json({ error: msg });
  }
}

export async function listLeads(req: AuthRequest, res: Response): Promise<void> {
  try {
    const { status, search, limit, offset } = req.query as Record<string, string>;
    const leads = await getLeads({
      status: parseLeadStatus(status),
      search,
      limit: limit ? parseInt(limit) : undefined,
      offset: offset ? parseInt(offset) : undefined,
    });
    res.json({ leads, count: leads.length });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Failed to fetch leads";
    res.status(500).json({ error: msg });
  }
}

export async function getLead(req: AuthRequest, res: Response): Promise<void> {
  try {
    const id = parseInt(req.params.id as string);
    const lead = await getLeadById(id);
    if (!lead) {
      res.status(404).json({ error: "Lead not found" });
      return;
    }
    res.json({ lead });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Failed to fetch lead";
    res.status(500).json({ error: msg });
  }
}

export async function exportLeads(req: AuthRequest, res: Response): Promise<void> {
  try {
    const csv = await exportLeadsCSV();
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=leads.csv");
    res.send(csv);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Export failed";
    res.status(500).json({ error: msg });
  }
}
