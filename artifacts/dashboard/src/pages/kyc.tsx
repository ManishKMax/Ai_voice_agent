import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ShieldCheck,
  ShieldX,
  ShieldAlert,
  FileText,
  ExternalLink,
  ChevronDown,
  ChevronUp,
  Loader2,
  CheckCircle2,
  XCircle,
  Clock,
  User,
  Search,
  Plus,
  Minus,
  Zap,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

async function apiFetch(path: string, options?: RequestInit) {
  const token = localStorage.getItem("auth_token");
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options?.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error(`Request failed: ${res.status}`);
  return res.json();
}

type KycStatus = "pending" | "submitted" | "approved" | "rejected";

interface KycDocument {
  id: number;
  tenantId: number;
  documentType: "aadhaar" | "gst";
  fileUrl: string | null;
  fileName: string | null;
  status: "pending" | "approved" | "rejected";
  adminNotes: string | null;
  createdAt: string;
}

interface Tenant {
  id: number;
  name: string;
  email: string;
  type: string;
  kycStatus: KycStatus;
  trialCallsUsed: number;
  minutesBalance: number;
  telephonyProvider: string | null;
  isActive: boolean;
  createdAt: string;
  documents: KycDocument[];
}

const statusConfig: Record<KycStatus, { label: string; icon: React.ElementType; cls: string }> = {
  pending:   { label: "Pending",   icon: Clock,        cls: "text-gray-500 bg-gray-100" },
  submitted: { label: "Submitted", icon: ShieldAlert,  cls: "text-amber-700 bg-amber-100" },
  approved:  { label: "Approved",  icon: ShieldCheck,  cls: "text-green-700 bg-green-100" },
  rejected:  { label: "Rejected",  icon: ShieldX,      cls: "text-red-700 bg-red-100" },
};

function docLabel(type: string) {
  return type === "aadhaar" ? "Aadhaar Card" : type === "gst" ? "GST Certificate" : type;
}

/**
 * "Migrate to LiveKit" button on each tenant row. Pre-Phase-2 tenants
 * have telephony_provider=NULL (treated as Twilio Legacy); this button
 * flips them onto the new LiveKit SIP path via the admin migrate
 * endpoint. Shows current provider + lets operators flip back to Twilio
 * if a LiveKit trunk problem is detected, without needing DB access.
 */
function MigrateTelephonyButton({ tenant }: { tenant: Tenant }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const current = tenant.telephonyProvider ?? "twilio";
  const target = current === "livekit" ? "twilio" : "livekit";
  const targetLabel = target === "livekit" ? "Migrate to LiveKit" : "Revert to Twilio";

  const mutation = useMutation({
    mutationFn: () =>
      apiFetch(`/api/admin/tenants/${tenant.id}/migrate-telephony`, {
        method: "POST",
        body: JSON.stringify({ provider: target }),
      }),
    onSuccess: (res: { previous: string | null; current: string }) => {
      qc.invalidateQueries({ queryKey: ["admin-tenants"] });
      toast({
        title: "Telephony updated",
        description: `${tenant.name}: ${res.previous ?? "twilio"} → ${res.current}`,
      });
    },
    onError: (err: Error) => {
      toast({
        title: "Migration failed",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  return (
    <button
      onClick={() => {
        if (!confirm(`Switch ${tenant.name} from ${current} to ${target}? Next call will use the new provider.`)) return;
        mutation.mutate();
      }}
      disabled={mutation.isPending}
      title={`Current: ${current}`}
      className="text-xs font-semibold text-muted-foreground border border-border hover:bg-muted px-2.5 py-1.5 rounded-lg transition-colors disabled:opacity-50"
    >
      {mutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : targetLabel}
    </button>
  );
}

function ReviewModal({
  tenant,
  onClose,
}: {
  tenant: Tenant;
  onClose: () => void;
}) {
  const [notes, setNotes] = useState(tenant.documents[0]?.adminNotes ?? "");
  const [decision, setDecision] = useState<"approved" | "rejected" | null>(null);
  const [localBalance, setLocalBalance] = useState(tenant.minutesBalance);
  const [topUpAmount, setTopUpAmount] = useState("");
  const [topUpMode, setTopUpMode] = useState<"credit" | "debit">("credit");
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: (body: { kycStatus: "approved" | "rejected"; adminNotes: string }) =>
      apiFetch(`/api/admin/tenants/${tenant.id}/kyc`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: ["admin-tenants"] });
      toast({
        title: vars.kycStatus === "approved" ? "Tenant approved" : "Tenant rejected",
        description: `${tenant.name} has been ${vars.kycStatus}.`,
      });
      onClose();
    },
    onError: () => {
      toast({ title: "Error", description: "Could not update KYC status.", variant: "destructive" });
    },
  });

  const topUpMutation = useMutation({
    mutationFn: (delta: number) =>
      apiFetch(`/api/admin/tenants/${tenant.id}/minutes`, {
        method: "PATCH",
        body: JSON.stringify({ delta }),
      }),
    onSuccess: (data: { minutesBalance: number }, delta) => {
      setLocalBalance(data.minutesBalance);
      setTopUpAmount("");
      queryClient.invalidateQueries({ queryKey: ["admin-tenants"] });
      toast({
        title: delta > 0 ? `+${delta} minutes credited` : `${Math.abs(delta)} minutes debited`,
        description: `New balance: ${data.minutesBalance} min`,
      });
    },
    onError: () => {
      toast({ title: "Failed", description: "Could not update balance.", variant: "destructive" });
    },
  });

  function applyTopUp(amount: number) {
    const delta = topUpMode === "credit" ? amount : -amount;
    topUpMutation.mutate(delta);
  }

  function handleCustomTopUp() {
    const n = parseInt(topUpAmount, 10);
    if (!n || n <= 0) return;
    applyTopUp(n);
  }

  function submit(status: "approved" | "rejected") {
    setDecision(status);
    mutation.mutate({ kycStatus: status, adminNotes: notes });
  }

  const cfg = statusConfig[tenant.kycStatus];
  const Icon = cfg.icon;

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-card rounded-2xl border border-border shadow-2xl w-full max-w-xl max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-6 border-b border-border">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-lg font-bold text-foreground">{tenant.name}</h2>
              <p className="text-sm text-muted-foreground">{tenant.email}</p>
            </div>
            <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-semibold ${cfg.cls}`}>
              <Icon className="h-3.5 w-3.5" />
              {cfg.label}
            </span>
          </div>

          <div className="mt-4 grid grid-cols-3 gap-3">
            {[
              { label: "Account type", value: tenant.type },
              { label: "Trial calls used", value: `${tenant.trialCallsUsed}` },
              { label: "Minutes balance", value: `${localBalance} min` },
            ].map((s) => (
              <div key={s.label} className="bg-muted rounded-lg px-3 py-2">
                <p className="text-xs text-muted-foreground">{s.label}</p>
                <p className="text-sm font-semibold text-foreground capitalize">{s.value}</p>
              </div>
            ))}
          </div>
        </div>

        <div className="p-6">
          <h3 className="text-sm font-semibold text-foreground mb-3">Submitted Documents</h3>

          {tenant.documents.length === 0 ? (
            <p className="text-sm text-muted-foreground italic">No documents uploaded yet.</p>
          ) : (
            <div className="space-y-3 mb-5">
              {tenant.documents.map((doc) => (
                <div key={doc.id} className="flex items-center justify-between border border-border rounded-xl p-4 bg-muted/30">
                  <div className="flex items-center gap-3">
                    <div className="h-9 w-9 bg-indigo-50 dark:bg-indigo-950 rounded-lg flex items-center justify-center flex-shrink-0">
                      <FileText className="h-4 w-4 text-indigo-500" />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-foreground">{docLabel(doc.documentType)}</p>
                      <p className="text-xs text-muted-foreground">{doc.fileName ?? "Uploaded file"}</p>
                    </div>
                  </div>
                  {doc.fileUrl && (
                    <a
                      href={`${BASE}/api/storage${doc.fileUrl}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-1.5 text-xs font-medium text-primary hover:underline px-3 py-1.5 border border-border rounded-lg hover:bg-muted transition-colors"
                    >
                      <ExternalLink className="h-3 w-3" />
                      View
                    </a>
                  )}
                </div>
              ))}
            </div>
          )}

          <div className="mb-5">
            <label className="block text-sm font-medium text-foreground mb-1.5">
              Admin Notes <span className="text-muted-foreground font-normal">(optional)</span>
            </label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Add a note visible to the user (e.g. reason for rejection)…"
              className="w-full border border-border rounded-xl px-3 py-2.5 text-sm bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 resize-none"
              rows={3}
            />
          </div>

          {tenant.kycStatus !== "approved" && tenant.kycStatus !== "rejected" && (
            <div className="flex gap-3">
              <button
                onClick={() => submit("approved")}
                disabled={mutation.isPending}
                className="flex-1 flex items-center justify-center gap-2 bg-green-600 hover:bg-green-700 text-white py-2.5 rounded-xl font-semibold text-sm transition-colors disabled:opacity-50"
              >
                {mutation.isPending && decision === "approved" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <CheckCircle2 className="h-4 w-4" />
                )}
                Approve
              </button>
              <button
                onClick={() => submit("rejected")}
                disabled={mutation.isPending}
                className="flex-1 flex items-center justify-center gap-2 bg-red-600 hover:bg-red-700 text-white py-2.5 rounded-xl font-semibold text-sm transition-colors disabled:opacity-50"
              >
                {mutation.isPending && decision === "rejected" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <XCircle className="h-4 w-4" />
                )}
                Reject
              </button>
            </div>
          )}

          {(tenant.kycStatus === "approved" || tenant.kycStatus === "rejected") && (
            <div className="flex gap-3">
              <button
                onClick={() => submit("approved")}
                disabled={mutation.isPending || tenant.kycStatus === "approved"}
                className="flex-1 flex items-center justify-center gap-2 border border-green-300 text-green-700 hover:bg-green-50 dark:hover:bg-green-950 py-2.5 rounded-xl font-semibold text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <CheckCircle2 className="h-4 w-4" />
                {tenant.kycStatus === "approved" ? "Already Approved" : "Approve"}
              </button>
              <button
                onClick={() => submit("rejected")}
                disabled={mutation.isPending || tenant.kycStatus === "rejected"}
                className="flex-1 flex items-center justify-center gap-2 border border-red-300 text-red-700 hover:bg-red-50 dark:hover:bg-red-950 py-2.5 rounded-xl font-semibold text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <XCircle className="h-4 w-4" />
                {tenant.kycStatus === "rejected" ? "Already Rejected" : "Reject"}
              </button>
            </div>
          )}

          {/* ── Minutes top-up ── */}
          <div className="mt-6 pt-5 border-t border-border">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Zap className="h-4 w-4 text-amber-500" />
                <h3 className="text-sm font-semibold text-foreground">Minutes Balance</h3>
              </div>
              <span className="text-lg font-bold text-foreground tabular-nums">
                {localBalance}
                <span className="text-xs font-normal text-muted-foreground ml-1">min</span>
              </span>
            </div>

            {/* Credit / Debit toggle */}
            <div className="flex rounded-lg overflow-hidden border border-border mb-3 text-sm font-medium">
              <button
                onClick={() => setTopUpMode("credit")}
                className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 transition-colors ${
                  topUpMode === "credit"
                    ? "bg-green-600 text-white"
                    : "bg-card text-muted-foreground hover:bg-muted"
                }`}
              >
                <Plus className="h-3.5 w-3.5" /> Credit
              </button>
              <button
                onClick={() => setTopUpMode("debit")}
                className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 transition-colors ${
                  topUpMode === "debit"
                    ? "bg-red-600 text-white"
                    : "bg-card text-muted-foreground hover:bg-muted"
                }`}
              >
                <Minus className="h-3.5 w-3.5" /> Debit
              </button>
            </div>

            {/* Quick presets */}
            <div className="flex gap-2 mb-3 flex-wrap">
              {[30, 60, 120, 300].map((n) => (
                <button
                  key={n}
                  onClick={() => applyTopUp(n)}
                  disabled={topUpMutation.isPending}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors disabled:opacity-50 ${
                    topUpMode === "credit"
                      ? "border-green-300 text-green-700 hover:bg-green-50 dark:hover:bg-green-950"
                      : "border-red-300 text-red-700 hover:bg-red-50 dark:hover:bg-red-950"
                  }`}
                >
                  {topUpMode === "credit" ? "+" : "−"}{n} min
                </button>
              ))}
            </div>

            {/* Custom amount */}
            <div className="flex gap-2">
              <input
                type="number"
                min={1}
                value={topUpAmount}
                onChange={(e) => setTopUpAmount(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleCustomTopUp()}
                placeholder="Custom amount…"
                className="flex-1 rounded-xl border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 placeholder:text-muted-foreground"
              />
              <button
                onClick={handleCustomTopUp}
                disabled={topUpMutation.isPending || !topUpAmount}
                className={`flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-semibold text-white transition-colors disabled:opacity-50 ${
                  topUpMode === "credit" ? "bg-green-600 hover:bg-green-700" : "bg-red-600 hover:bg-red-700"
                }`}
              >
                {topUpMutation.isPending
                  ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  : topUpMode === "credit" ? <Plus className="h-3.5 w-3.5" /> : <Minus className="h-3.5 w-3.5" />}
                Apply
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function KycReview() {
  const [search, setSearch] = useState("");
  const [filterStatus, setFilterStatus] = useState<KycStatus | "all">("all");
  const [selected, setSelected] = useState<Tenant | null>(null);

  const { data, isLoading, error } = useQuery<{ tenants: Tenant[] }>({
    queryKey: ["admin-tenants"],
    queryFn: () => apiFetch("/api/admin/tenants"),
    refetchInterval: 30_000,
  });

  const tenants = data?.tenants ?? [];

  const filtered = tenants.filter((t) => {
    const matchesSearch =
      !search ||
      t.name.toLowerCase().includes(search.toLowerCase()) ||
      t.email.toLowerCase().includes(search.toLowerCase());
    const matchesFilter = filterStatus === "all" || t.kycStatus === filterStatus;
    return matchesSearch && matchesFilter;
  });

  const counts = tenants.reduce<Record<string, number>>(
    (acc, t) => { acc[t.kycStatus] = (acc[t.kycStatus] ?? 0) + 1; return acc; },
    {},
  );

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">KYC Review</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Review and approve portal tenant identity documents
          </p>
        </div>
      </div>

      {/* Status summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {(["submitted", "pending", "approved", "rejected"] as KycStatus[]).map((s) => {
          const cfg = statusConfig[s];
          const Icon = cfg.icon;
          return (
            <button
              key={s}
              onClick={() => setFilterStatus(filterStatus === s ? "all" : s)}
              className={`text-left p-4 rounded-xl border transition-all ${
                filterStatus === s
                  ? "border-primary bg-primary/5"
                  : "border-border bg-card hover:border-primary/50"
              }`}
            >
              <div className={`inline-flex items-center justify-center h-8 w-8 rounded-lg mb-2 ${cfg.cls}`}>
                <Icon className="h-4 w-4" />
              </div>
              <div className="text-2xl font-bold text-foreground">{counts[s] ?? 0}</div>
              <div className="text-xs text-muted-foreground mt-0.5">{cfg.label}</div>
            </button>
          );
        })}
      </div>

      {/* Search & filter bar */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search by name or email…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-9 pr-3 py-2 border border-border rounded-lg text-sm bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
          />
        </div>
        <select
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value as KycStatus | "all")}
          className="border border-border rounded-lg px-3 py-2 text-sm bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
        >
          <option value="all">All statuses</option>
          <option value="submitted">Submitted</option>
          <option value="pending">Pending</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
        </select>
      </div>

      {/* Table */}
      {isLoading && (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      )}

      {error && (
        <div className="bg-destructive/10 border border-destructive/30 rounded-xl p-4 text-sm text-destructive">
          Failed to load tenants. Make sure you're logged in.
        </div>
      )}

      {!isLoading && !error && filtered.length === 0 && (
        <div className="text-center py-16 text-muted-foreground text-sm">
          {tenants.length === 0 ? "No portal tenants have signed up yet." : "No tenants match your filters."}
        </div>
      )}

      {!isLoading && !error && filtered.length > 0 && (
        <div className="bg-card border border-border rounded-2xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40">
                <th className="text-left px-5 py-3 font-semibold text-muted-foreground">Tenant</th>
                <th className="text-left px-5 py-3 font-semibold text-muted-foreground hidden md:table-cell">Type</th>
                <th className="text-left px-5 py-3 font-semibold text-muted-foreground">KYC Status</th>
                <th className="text-left px-5 py-3 font-semibold text-muted-foreground hidden lg:table-cell">Docs</th>
                <th className="text-left px-5 py-3 font-semibold text-muted-foreground hidden lg:table-cell">Signed up</th>
                <th className="px-5 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filtered.map((t) => {
                const cfg = statusConfig[t.kycStatus];
                const Icon = cfg.icon;
                const isNew = t.kycStatus === "submitted";
                return (
                  <tr
                    key={t.id}
                    className={`hover:bg-muted/30 transition-colors ${isNew ? "bg-amber-50/40 dark:bg-amber-950/20" : ""}`}
                  >
                    <td className="px-5 py-4">
                      <div className="flex items-center gap-3">
                        <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
                          <User className="h-4 w-4 text-primary" />
                        </div>
                        <div>
                          <p className="font-medium text-foreground">{t.name}</p>
                          <p className="text-xs text-muted-foreground">{t.email}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-5 py-4 hidden md:table-cell">
                      <span className="capitalize text-foreground">{t.type}</span>
                    </td>
                    <td className="px-5 py-4">
                      <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-semibold ${cfg.cls}`}>
                        <Icon className="h-3 w-3" />
                        {cfg.label}
                        {isNew && (
                          <span className="ml-1 bg-amber-500 text-white text-[10px] font-bold px-1 rounded">NEW</span>
                        )}
                      </span>
                    </td>
                    <td className="px-5 py-4 hidden lg:table-cell text-muted-foreground">
                      {t.documents.length === 0 ? "—" : `${t.documents.length} file${t.documents.length !== 1 ? "s" : ""}`}
                    </td>
                    <td className="px-5 py-4 hidden lg:table-cell text-muted-foreground">
                      {new Date(t.createdAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}
                    </td>
                    <td className="px-5 py-4 text-right">
                      <div className="inline-flex items-center gap-2">
                        <MigrateTelephonyButton tenant={t} />
                        <button
                          onClick={() => setSelected(t)}
                          className="text-xs font-semibold text-primary border border-primary/30 hover:bg-primary/10 px-3 py-1.5 rounded-lg transition-colors"
                        >
                          Review
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {selected && (
        <ReviewModal
          tenant={selected}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}
