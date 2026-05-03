import React, { useState, useCallback } from "react";
import {
  useGetLeads,
  useCreateLead,
  useExportLeads,
  useUpdateLead,
  useDeleteLead,
  useBulkLeadAction,
  getGetLeadsQueryKey,
  getExportLeadsQueryKey,
} from "@workspace/api-client-react";
import { Link } from "wouter";
import { format } from "date-fns";
import {
  Plus, Search, Filter, Download, Upload, Phone, Eye,
  Pencil, Trash2, RotateCcw, ChevronDown, X, CheckSquare,
  Square, AlertTriangle, PhoneOff, Tag, RefreshCw, Loader2,
} from "lucide-react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useQueryClient } from "@tanstack/react-query";

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LeadStatusBadge, PriorityBadge } from "@/components/status-badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import type { Lead } from "@workspace/api-client-react";
import { LeadStatus } from "@workspace/api-client-react";

// ── Schemas ──────────────────────────────────────────────────────────────────
const createLeadSchema = z.object({
  name: z.string().min(2, "Name is required"),
  phone: z.string().min(10, "Valid phone number required"),
  source: z.string().optional(),
  notes: z.string().optional(),
});

const editLeadSchema = z.object({
  name: z.string().min(2, "Name is required"),
  phone: z.string().min(10, "Valid phone number required"),
  source: z.string().optional(),
  notes: z.string().optional(),
  tags: z.string().optional(),
  priority: z.coerce.number().min(1).max(4).optional(),
});

// ── Tag chips helper ──────────────────────────────────────────────────────────
const TAG_COLORS: Record<string, string> = {
  hot:      "bg-red-100 text-red-700 border-red-200",
  warm:     "bg-orange-100 text-orange-700 border-orange-200",
  cold:     "bg-blue-100 text-blue-600 border-blue-200",
  callback: "bg-purple-100 text-purple-700 border-purple-200",
  vip:      "bg-yellow-100 text-yellow-700 border-yellow-200",
};
function TagChip({ tag }: { tag: string }) {
  const cls = TAG_COLORS[tag.toLowerCase()] ?? "bg-gray-100 text-gray-600 border-gray-200";
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-medium border ${cls}`}>
      {tag}
    </span>
  );
}
function TagList({ tags }: { tags: string }) {
  const list = tags ? tags.split(",").map(t => t.trim()).filter(Boolean) : [];
  if (list.length === 0) return <span className="text-muted-foreground text-xs">—</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {list.slice(0, 3).map(t => <TagChip key={t} tag={t} />)}
      {list.length > 3 && <span className="text-xs text-muted-foreground">+{list.length - 3}</span>}
    </div>
  );
}

// ── Status constants ──────────────────────────────────────────────────────────
const ALL_STATUSES = [
  "pending", "calling", "completed", "interested",
  "not_interested", "no_response", "callback", "dnc",
] as const;

// ── Components ────────────────────────────────────────────────────────────────
function BulkActionBar({
  count,
  onClear,
  onDelete,
  onRequeue,
  onSetStatus,
  onSetDnc,
}: {
  count: number;
  onClear: () => void;
  onDelete: () => void;
  onRequeue: () => void;
  onSetStatus: (s: string) => void;
  onSetDnc: () => void;
}) {
  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 bg-foreground text-background px-5 py-3 rounded-full shadow-2xl border border-border/20 animate-in slide-in-from-bottom-4">
      <span className="text-sm font-semibold">{count} selected</span>
      <div className="w-px h-4 bg-background/30" />
      <button onClick={onRequeue} className="flex items-center gap-1.5 text-sm hover:text-primary transition-colors">
        <RotateCcw className="h-3.5 w-3.5" /> Re-queue
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button className="flex items-center gap-1 text-sm hover:text-primary transition-colors">
            Set Status <ChevronDown className="h-3 w-3" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="center" className="w-40">
          {["pending", "interested", "not_interested", "callback", "no_response"].map(s => (
            <DropdownMenuItem key={s} onClick={() => onSetStatus(s)} className="capitalize text-sm">
              {s.replace(/_/g, " ")}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <button onClick={onSetDnc} className="flex items-center gap-1.5 text-sm hover:text-amber-400 transition-colors">
        <PhoneOff className="h-3.5 w-3.5" /> Mark DNC
      </button>
      <button onClick={onDelete} className="flex items-center gap-1.5 text-sm hover:text-red-400 transition-colors">
        <Trash2 className="h-3.5 w-3.5" /> Delete
      </button>
      <div className="w-px h-4 bg-background/30" />
      <button onClick={onClear} className="hover:text-primary transition-colors"><X className="h-4 w-4" /></button>
    </div>
  );
}

function DeleteConfirmDialog({
  open, onClose, onConfirm, count,
}: { open: boolean; onClose: () => void; onConfirm: () => void; count: number }) {
  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-destructive">
            <AlertTriangle className="h-5 w-5" />
            Delete {count > 1 ? `${count} Leads` : "Lead"}
          </DialogTitle>
          <DialogDescription>
            This will permanently delete {count > 1 ? `${count} leads` : "this lead"} and all associated call history. This cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button variant="destructive" onClick={onConfirm}>
            <Trash2 className="mr-2 h-4 w-4" /> Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────
export default function Leads() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Filters
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");

  // Selection
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

  // Dialogs
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [editLead, setEditLead] = useState<Lead | null>(null);
  const [deleteIds, setDeleteIds] = useState<number[]>([]);

  // Pagination
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 50;

  const { data, isLoading } = useGetLeads({
    search: search || undefined,
    status: statusFilter === "all" ? undefined : (statusFilter as LeadStatus),
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
  });

  const leads = data?.leads ?? [];
  const totalCount = data?.count ?? 0;
  const allIds = leads.map(l => l.id);
  const allSelected = allIds.length > 0 && allIds.every(id => selectedIds.has(id));

  // Mutations
  const createLeadMutation = useCreateLead();
  const updateLeadMutation = useUpdateLead();
  const deleteLeadMutation = useDeleteLead();
  const bulkMutation = useBulkLeadAction();
  const { refetch: refetchExport, isFetching: isExporting } = useExportLeads({
    query: { queryKey: getExportLeadsQueryKey(), enabled: false },
  });

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: getGetLeadsQueryKey() });
  }

  // ── Add form
  const addForm = useForm<z.infer<typeof createLeadSchema>>({
    resolver: zodResolver(createLeadSchema),
    defaultValues: { name: "", phone: "", source: "", notes: "" },
  });
  function onAddSubmit(values: z.infer<typeof createLeadSchema>) {
    createLeadMutation.mutate(
      { data: values },
      {
        onSuccess: () => { toast({ title: "Lead created" }); invalidate(); setIsAddOpen(false); addForm.reset(); },
        onError: (err: any) => toast({ title: "Failed to create lead", description: err?.response?.data?.error, variant: "destructive" }),
      }
    );
  }

  // ── Edit form
  const editForm = useForm<z.infer<typeof editLeadSchema>>({
    resolver: zodResolver(editLeadSchema),
    defaultValues: { name: "", phone: "", source: "", notes: "", tags: "", priority: 2 },
  });
  function openEdit(lead: Lead) {
    setEditLead(lead);
    editForm.reset({
      name: lead.name,
      phone: lead.phone,
      source: lead.source ?? "",
      notes: lead.notes ?? "",
      tags: lead.tags ?? "",
      priority: lead.priority ?? 2,
    });
  }
  function onEditSubmit(values: z.infer<typeof editLeadSchema>) {
    if (!editLead) return;
    updateLeadMutation.mutate(
      { id: editLead.id, data: values as any },
      {
        onSuccess: () => { toast({ title: "Lead updated" }); invalidate(); setEditLead(null); },
        onError: (err: any) => toast({ title: "Failed to update lead", description: err?.response?.data?.error, variant: "destructive" }),
      }
    );
  }

  // ── Retry Call
  const [retryingId, setRetryingId] = useState<number | null>(null);
  async function handleRetryCall(leadId: number) {
    setRetryingId(leadId);
    try {
      const token = localStorage.getItem("auth_token");
      const baseUrl = import.meta.env.BASE_URL.replace(/\/$/, "");
      const res = await fetch(`${baseUrl}/api/leads/${leadId}/retry-call`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      toast({ title: "Call queued", description: "Lead reset to pending and queued for calling." });
      invalidate();
    } catch (err: any) {
      toast({ title: "Retry failed", description: err?.message, variant: "destructive" });
    } finally {
      setRetryingId(null);
    }
  }

  // ── Status inline change
  function handleStatusChange(leadId: number, newStatus: string) {
    updateLeadMutation.mutate(
      { id: leadId, data: { status: newStatus as any } },
      {
        onSuccess: () => { toast({ title: "Status updated" }); invalidate(); },
        onError: () => toast({ title: "Failed to update status", variant: "destructive" }),
      }
    );
  }

  // ── Delete
  function confirmDelete(ids: number[]) { setDeleteIds(ids); }
  function handleDelete() {
    if (deleteIds.length === 1) {
      deleteLeadMutation.mutate(
        { id: deleteIds[0] },
        {
          onSuccess: () => { toast({ title: "Lead deleted" }); invalidate(); setDeleteIds([]); setSelectedIds(new Set()); },
          onError: () => toast({ title: "Failed to delete lead", variant: "destructive" }),
        }
      );
    } else {
      bulkMutation.mutate(
        { data: { ids: deleteIds, action: "delete" } },
        {
          onSuccess: () => { toast({ title: `${deleteIds.length} leads deleted` }); invalidate(); setDeleteIds([]); setSelectedIds(new Set()); },
          onError: () => toast({ title: "Bulk delete failed", variant: "destructive" }),
        }
      );
    }
  }

  // ── Bulk actions
  function handleBulkRequeue() {
    const ids = Array.from(selectedIds);
    bulkMutation.mutate(
      { data: { ids, action: "requeue" } },
      {
        onSuccess: (res: any) => { toast({ title: `${res.count} leads re-queued` }); invalidate(); setSelectedIds(new Set()); },
        onError: () => toast({ title: "Failed", variant: "destructive" }),
      }
    );
  }
  function handleBulkSetStatus(status: string) {
    const ids = Array.from(selectedIds);
    bulkMutation.mutate(
      { data: { ids, action: "set_status", status: status as any } },
      {
        onSuccess: (res: any) => { toast({ title: `${res.count} leads updated` }); invalidate(); setSelectedIds(new Set()); },
        onError: () => toast({ title: "Failed", variant: "destructive" }),
      }
    );
  }
  function handleBulkDnc() {
    const ids = Array.from(selectedIds);
    bulkMutation.mutate(
      { data: { ids, action: "set_dnc", dnc: true } },
      {
        onSuccess: (res: any) => { toast({ title: `${res.count} leads marked DNC` }); invalidate(); setSelectedIds(new Set()); },
        onError: () => toast({ title: "Failed", variant: "destructive" }),
      }
    );
  }

  // ── Selection
  function toggleSelect(id: number) {
    setSelectedIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }
  function toggleSelectAll() {
    if (allSelected) { setSelectedIds(new Set()); }
    else { setSelectedIds(new Set(allIds)); }
  }

  // ── Export
  const handleExport = async () => {
    try {
      const res = await refetchExport();
      if (res.data) {
        const blob = new Blob([res.data], { type: "text/csv" });
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `leads-export-${format(new Date(), "yyyy-MM-dd")}.csv`;
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);
        toast({ title: "Export complete" });
      }
    } catch { toast({ title: "Export failed", variant: "destructive" }); }
  };

  // ── CSV Upload
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const formData = new FormData();
    formData.append("file", file);
    try {
      const token = localStorage.getItem("auth_token");
      const baseUrl = import.meta.env.BASE_URL.replace(/\/$/, "");
      const res = await fetch(`${baseUrl}/api/leads/upload`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });
      if (!res.ok) throw new Error("Upload failed");
      const data = await res.json();
      toast({ title: `${data.message || "CSV uploaded successfully"}` });
      invalidate();
    } catch { toast({ title: "CSV upload failed", variant: "destructive" }); }
    e.target.value = "";
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Leads</h1>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <input type="file" accept=".csv" className="absolute inset-0 w-full h-full opacity-0 cursor-pointer" onChange={handleFileUpload} />
            <Button variant="outline" size="sm"><Upload className="mr-2 h-4 w-4" />Import CSV</Button>
          </div>
          <Button variant="outline" size="sm" onClick={handleExport} disabled={isExporting}>
            <Download className="mr-2 h-4 w-4" />{isExporting ? "Exporting..." : "Export"}
          </Button>
          <Dialog open={isAddOpen} onOpenChange={setIsAddOpen}>
            <DialogTrigger asChild>
              <Button size="sm"><Plus className="mr-2 h-4 w-4" />Add Lead</Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-[425px]">
              <DialogHeader>
                <DialogTitle>Add New Lead</DialogTitle>
                <DialogDescription>Enter lead details to add them to the calling queue.</DialogDescription>
              </DialogHeader>
              <Form {...addForm}>
                <form onSubmit={addForm.handleSubmit(onAddSubmit)} className="space-y-4 pt-4">
                  <FormField control={addForm.control} name="name" render={({ field }) => (
                    <FormItem><FormLabel>Name</FormLabel><FormControl><Input placeholder="Jane Smith" {...field} /></FormControl><FormMessage /></FormItem>
                  )} />
                  <FormField control={addForm.control} name="phone" render={({ field }) => (
                    <FormItem><FormLabel>Phone Number</FormLabel><FormControl><Input placeholder="+919876543210" {...field} /></FormControl><FormMessage /></FormItem>
                  )} />
                  <FormField control={addForm.control} name="source" render={({ field }) => (
                    <FormItem><FormLabel>Source (Optional)</FormLabel><FormControl><Input placeholder="Website, Referral, etc." {...field} /></FormControl><FormMessage /></FormItem>
                  )} />
                  <FormField control={addForm.control} name="notes" render={({ field }) => (
                    <FormItem><FormLabel>Notes (Optional)</FormLabel><FormControl><Textarea placeholder="Any initial context..." {...field} /></FormControl><FormMessage /></FormItem>
                  )} />
                  <DialogFooter>
                    <Button type="button" variant="outline" onClick={() => setIsAddOpen(false)}>Cancel</Button>
                    <Button type="submit" disabled={createLeadMutation.isPending}>{createLeadMutation.isPending ? "Saving..." : "Save Lead"}</Button>
                  </DialogFooter>
                </form>
              </Form>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row items-center gap-3 bg-card p-4 border rounded-lg">
        <div className="relative w-full sm:w-72">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input placeholder="Search name or phone..." className="pl-9" value={search} onChange={e => { setSearch(e.target.value); setPage(0); }} />
        </div>
        <div className="w-full sm:w-52 flex items-center gap-2">
          <Filter className="h-4 w-4 text-muted-foreground shrink-0" />
          <Select value={statusFilter} onValueChange={v => { setStatusFilter(v); setPage(0); }}>
            <SelectTrigger><SelectValue placeholder="All Statuses" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Statuses</SelectItem>
              {ALL_STATUSES.map(s => (
                <SelectItem key={s} value={s} className="capitalize">{s.replace(/_/g, " ")}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {selectedIds.size > 0 && (
          <div className="ml-auto text-sm text-muted-foreground">
            {selectedIds.size} selected
          </div>
        )}
      </div>

      {/* Table */}
      <div className="border rounded-lg bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">
                <button onClick={toggleSelectAll} className="text-muted-foreground hover:text-foreground">
                  {allSelected ? <CheckSquare className="h-4 w-4 text-primary" /> : <Square className="h-4 w-4" />}
                </button>
              </TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Phone</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="hidden sm:table-cell">Tags</TableHead>
              <TableHead className="hidden md:table-cell">Priority</TableHead>
              <TableHead className="hidden lg:table-cell">Source</TableHead>
              <TableHead className="hidden lg:table-cell">Created</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 6 }).map((_, i) => (
                <TableRow key={i}>
                  {Array.from({ length: 9 }).map((_, j) => (
                    <TableCell key={j}><Skeleton className="h-4 w-full" /></TableCell>
                  ))}
                </TableRow>
              ))
            ) : leads.length === 0 ? (
              <TableRow>
                <TableCell colSpan={9} className="h-24 text-center text-muted-foreground">
                  No leads found.
                </TableCell>
              </TableRow>
            ) : (
              leads.map(lead => (
                <TableRow
                  key={lead.id}
                  className={`${selectedIds.has(lead.id) ? "bg-primary/5" : ""} ${lead.dnc ? "opacity-60" : ""}`}
                >
                  <TableCell>
                    <button onClick={() => toggleSelect(lead.id)} className="text-muted-foreground hover:text-foreground">
                      {selectedIds.has(lead.id)
                        ? <CheckSquare className="h-4 w-4 text-primary" />
                        : <Square className="h-4 w-4" />}
                    </button>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1.5">
                      <span className="font-medium">{lead.name}</span>
                      {lead.dnc && <PhoneOff className="h-3 w-3 text-muted-foreground" aria-label="Do Not Call" />}
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm">{lead.phone}</TableCell>
                  <TableCell>
                    {/* Inline status dropdown */}
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button className="hover:opacity-80 transition-opacity">
                          <LeadStatusBadge status={lead.status} />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="start" className="w-44">
                        <div className="px-2 py-1 text-xs text-muted-foreground font-medium">Change status</div>
                        <DropdownMenuSeparator />
                        {ALL_STATUSES.map(s => (
                          <DropdownMenuItem
                            key={s}
                            onClick={() => handleStatusChange(lead.id, s)}
                            className={`capitalize text-sm ${lead.status === s ? "font-semibold" : ""}`}
                          >
                            {s.replace(/_/g, " ")}
                            {lead.status === s && <span className="ml-auto text-primary">✓</span>}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">
                    <TagList tags={lead.tags ?? ""} />
                  </TableCell>
                  <TableCell className="hidden md:table-cell">
                    <PriorityBadge priority={lead.priority ?? 2} />
                  </TableCell>
                  <TableCell className="hidden lg:table-cell text-muted-foreground text-sm">{lead.source || "—"}</TableCell>
                  <TableCell className="hidden lg:table-cell text-muted-foreground text-sm">
                    {format(new Date(lead.createdAt), "MMM d, yyyy")}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Link href={`/leads/${lead.id}`}>
                        <Button variant="ghost" size="icon" className="h-7 w-7" title="View"><Eye className="h-3.5 w-3.5" /></Button>
                      </Link>
                      <Button variant="ghost" size="icon" className="h-7 w-7" title="Edit" onClick={() => openEdit(lead)}>
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      {lead.status !== "pending" && lead.status !== "calling" && !lead.dnc ? (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-green-600 hover:text-green-700 hover:bg-green-50"
                          title="Retry Call"
                          disabled={retryingId === lead.id}
                          onClick={() => handleRetryCall(lead.id)}
                        >
                          {retryingId === lead.id
                            ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            : <RefreshCw className="h-3.5 w-3.5" />}
                        </Button>
                      ) : (
                        <Link href={`/leads/${lead.id}?call=true`}>
                          <Button variant="ghost" size="icon" className="h-7 w-7 text-blue-600 hover:text-blue-700 hover:bg-blue-50" title="Call">
                            <Phone className="h-3.5 w-3.5" />
                          </Button>
                        </Link>
                      )}
                      <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive hover:text-destructive hover:bg-destructive/10" title="Delete" onClick={() => confirmDelete([lead.id])}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>

        {/* Pagination footer */}
        <div className="p-4 border-t flex items-center justify-between text-xs text-muted-foreground">
          <span>Showing {leads.length} of {totalCount} leads</span>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage(p => p - 1)} className="h-7 text-xs">
              Previous
            </Button>
            <Button variant="outline" size="sm" disabled={(page + 1) * PAGE_SIZE >= totalCount} onClick={() => setPage(p => p + 1)} className="h-7 text-xs">
              Next
            </Button>
          </div>
        </div>
      </div>

      {/* Bulk Action Bar */}
      {selectedIds.size > 0 && (
        <BulkActionBar
          count={selectedIds.size}
          onClear={() => setSelectedIds(new Set())}
          onDelete={() => confirmDelete(Array.from(selectedIds))}
          onRequeue={handleBulkRequeue}
          onSetStatus={handleBulkSetStatus}
          onSetDnc={handleBulkDnc}
        />
      )}

      {/* Delete Confirmation */}
      <DeleteConfirmDialog
        open={deleteIds.length > 0}
        onClose={() => setDeleteIds([])}
        onConfirm={handleDelete}
        count={deleteIds.length}
      />

      {/* Edit Modal */}
      <Dialog open={!!editLead} onOpenChange={open => !open && setEditLead(null)}>
        <DialogContent className="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle>Edit Lead</DialogTitle>
            <DialogDescription>Update lead details. Status changes take effect immediately.</DialogDescription>
          </DialogHeader>
          <Form {...editForm}>
            <form onSubmit={editForm.handleSubmit(onEditSubmit)} className="space-y-4 pt-2">
              <div className="grid grid-cols-2 gap-4">
                <FormField control={editForm.control} name="name" render={({ field }) => (
                  <FormItem><FormLabel>Name</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                <FormField control={editForm.control} name="phone" render={({ field }) => (
                  <FormItem><FormLabel>Phone</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
                )} />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <FormField control={editForm.control} name="source" render={({ field }) => (
                  <FormItem><FormLabel>Source</FormLabel><FormControl><Input placeholder="Website, CSV…" {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                <FormField control={editForm.control} name="priority" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Priority</FormLabel>
                    <Select value={String(field.value ?? 2)} onValueChange={v => field.onChange(parseInt(v))}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="1">1 — Low</SelectItem>
                        <SelectItem value="2">2 — Normal</SelectItem>
                        <SelectItem value="3">3 — High</SelectItem>
                        <SelectItem value="4">4 — Urgent</SelectItem>
                      </SelectContent>
                    </Select>
                  </FormItem>
                )} />
              </div>
              <FormField control={editForm.control} name="tags" render={({ field }) => (
                <FormItem>
                  <FormLabel className="flex items-center gap-1.5"><Tag className="h-3.5 w-3.5" />Tags</FormLabel>
                  <FormControl><Input placeholder="hot, callback, vip (comma-separated)" {...field} /></FormControl>
                  {field.value && (
                    <div className="flex flex-wrap gap-1 pt-1">
                      {field.value.split(",").map(t => t.trim()).filter(Boolean).map(t => <TagChip key={t} tag={t} />)}
                    </div>
                  )}
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={editForm.control} name="notes" render={({ field }) => (
                <FormItem><FormLabel>Notes</FormLabel><FormControl><Textarea rows={3} {...field} /></FormControl><FormMessage /></FormItem>
              )} />
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setEditLead(null)}>Cancel</Button>
                <Button type="submit" disabled={updateLeadMutation.isPending}>
                  {updateLeadMutation.isPending ? "Saving…" : "Save Changes"}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
