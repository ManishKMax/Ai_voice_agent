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

export async function addLead(req: AuthRequest, res: Response): Promise<void> {
  try {
    const { name, phone, source, notes } = req.body;
    if (!name || !phone) {
      res.status(400).json({ error: "name and phone are required" });
      return;
    }
    const lead = await createLead({ name, phone, source, notes });
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

    const rows: InsertLead[] = records
      .filter((r) => r.name && r.phone)
      .map((r) => ({
        name: r.name!,
        phone: r.phone!,
        source: r.source ?? "csv",
        notes: r.notes,
      }));

    if (rows.length === 0) {
      res.status(400).json({ error: "No valid rows found in CSV (need name and phone columns)" });
      return;
    }

    const leads = await createLeadsFromCSV(rows);
    res.status(201).json({ message: `${leads.length} leads imported`, leads });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "CSV upload failed";
    res.status(500).json({ error: msg });
  }
}

export async function listLeads(req: AuthRequest, res: Response): Promise<void> {
  try {
    const { status, search, limit, offset } = req.query as Record<string, string>;
    const leads = await getLeads({
      status: status as any,
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
