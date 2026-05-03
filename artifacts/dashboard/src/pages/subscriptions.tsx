import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  CreditCard,
  CheckCircle,
  XCircle,
  Clock,
  Plus,
  RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";

const API = "/api";
const getToken = () => localStorage.getItem("auth_token");

async function apiFetch(path: string, opts: RequestInit = {}) {
  const res = await fetch(`${API}${path}`, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getToken()}`,
      ...(opts.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.error ?? res.statusText);
  }
  return res.json();
}

const STATUS_CONFIG: Record<string, { color: string; icon: React.ReactNode }> = {
  active:         { color: "bg-green-100 text-green-700",  icon: <CheckCircle className="h-3 w-3" /> },
  pending:        { color: "bg-yellow-100 text-yellow-700", icon: <Clock className="h-3 w-3" /> },
  cancelled:      { color: "bg-gray-100 text-gray-600",    icon: <XCircle className="h-3 w-3" /> },
  expired:        { color: "bg-orange-100 text-orange-700", icon: <XCircle className="h-3 w-3" /> },
  payment_failed: { color: "bg-red-100 text-red-700",      icon: <XCircle className="h-3 w-3" /> },
};

export default function SubscriptionsPage() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [activateOpen, setActivateOpen] = useState(false);
  const [selectedTenant, setSelectedTenant] = useState("");

  const { data, isLoading, refetch } = useQuery({
    queryKey: ["admin-subscriptions"],
    queryFn: () => apiFetch("/admin/subscriptions"),
  });

  const { data: tenantsData } = useQuery({
    queryKey: ["admin-tenants"],
    queryFn: () => apiFetch("/admin/tenants"),
  });

  const subscriptions: any[] = data?.subscriptions ?? [];
  const tenants: any[] = tenantsData?.tenants ?? [];

  const activateMutation = useMutation({
    mutationFn: (tenantId: number) =>
      apiFetch("/admin/subscriptions", { method: "POST", body: JSON.stringify({ tenantId }) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-subscriptions"] });
      qc.invalidateQueries({ queryKey: ["admin-tenants"] });
      setActivateOpen(false);
      setSelectedTenant("");
      toast({ title: "Subscription activated", description: "Minutes credited to tenant balance." });
    },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const totalRevenue = subscriptions
    .filter((s) => s.status === "active" || s.razorpayPaymentId)
    .reduce((sum, s) => sum + (s.planCostPaise ?? 0), 0);

  const activeCount = subscriptions.filter((s) => s.status === "active").length;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Subscriptions</h1>
          <p className="text-muted-foreground text-sm mt-1">Manage tenant subscriptions and billing</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => refetch()}>
            <RefreshCw className="h-4 w-4 mr-2" /> Refresh
          </Button>
          <Button onClick={() => setActivateOpen(true)}>
            <Plus className="h-4 w-4 mr-2" /> Activate Plan
          </Button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4">
        {[
          { label: "Active Subscriptions", value: activeCount, icon: <CheckCircle className="h-5 w-5 text-green-600" /> },
          { label: "Total Plans", value: subscriptions.length, icon: <CreditCard className="h-5 w-5 text-blue-600" /> },
          { label: "Revenue (estimate)", value: `₹${(totalRevenue / 100).toLocaleString("en-IN")}`, icon: <CreditCard className="h-5 w-5 text-purple-600" /> },
        ].map((stat) => (
          <div key={stat.label} className="rounded-lg border bg-card p-4 flex items-center gap-3">
            <div className="p-2 rounded-full bg-muted">{stat.icon}</div>
            <div>
              <p className="text-xs text-muted-foreground">{stat.label}</p>
              <p className="text-xl font-bold">{stat.value}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Table */}
      <div className="rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Tenant</TableHead>
              <TableHead>Plan</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Minutes</TableHead>
              <TableHead>Amount</TableHead>
              <TableHead>Period</TableHead>
              <TableHead>Razorpay</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground py-8">Loading...</TableCell></TableRow>
            ) : subscriptions.length === 0 ? (
              <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground py-8">No subscriptions yet</TableCell></TableRow>
            ) : subscriptions.map((s) => {
              const cfg = STATUS_CONFIG[s.status] ?? STATUS_CONFIG.pending;
              return (
                <TableRow key={s.id}>
                  <TableCell>
                    <div>
                      <p className="font-medium text-sm">{s.tenantName ?? `Tenant #${s.tenantId}`}</p>
                      <p className="text-xs text-muted-foreground">{s.tenantEmail}</p>
                    </div>
                  </TableCell>
                  <TableCell className="text-sm">₹{(s.planCostPaise / 100).toLocaleString("en-IN")}/mo</TableCell>
                  <TableCell>
                    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${cfg.color}`}>
                      {cfg.icon} {s.status}
                    </span>
                  </TableCell>
                  <TableCell className="text-sm">
                    <span className="text-muted-foreground">{s.usedMinutes}</span>
                    <span className="text-muted-foreground mx-1">/</span>
                    <span className="font-medium">{s.includedMinutes}</span>
                    <span className="text-xs text-muted-foreground ml-1">min</span>
                  </TableCell>
                  <TableCell className="text-sm">₹{(s.planCostPaise / 100).toLocaleString("en-IN")}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {s.periodStart
                      ? `${new Date(s.periodStart).toLocaleDateString("en-IN")} – ${new Date(s.periodEnd).toLocaleDateString("en-IN")}`
                      : "—"}
                  </TableCell>
                  <TableCell className="text-xs">
                    {s.razorpayPaymentId ? (
                      <code className="text-xs bg-muted px-1 py-0.5 rounded">{s.razorpayPaymentId.slice(-8)}</code>
                    ) : "—"}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      {/* Activate Plan Dialog */}
      <Dialog open={activateOpen} onOpenChange={setActivateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Activate Monthly Plan</DialogTitle>
          </DialogHeader>
          <div className="py-2 space-y-4">
            <p className="text-sm text-muted-foreground">
              This will activate a ₹2,000/month plan for the selected tenant and credit them 400 minutes.
              Any existing active subscription for that tenant will be expired.
            </p>
            <div className="space-y-1">
              <label className="text-sm font-medium">Select Tenant</label>
              <Select value={selectedTenant} onValueChange={setSelectedTenant}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose a tenant..." />
                </SelectTrigger>
                <SelectContent>
                  {tenants.map((t: any) => (
                    <SelectItem key={t.id} value={String(t.id)}>
                      {t.name} ({t.email})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setActivateOpen(false)}>Cancel</Button>
            <Button
              disabled={!selectedTenant || activateMutation.isPending}
              onClick={() => activateMutation.mutate(Number(selectedTenant))}
            >
              {activateMutation.isPending ? "Activating..." : "Activate Plan"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
