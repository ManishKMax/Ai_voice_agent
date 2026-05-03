import React, { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Plus,
  Trash2,
  ShieldOff,
  Link as LinkIcon,
  CheckCircle,
  XCircle,
  Smartphone,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
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

type VoiceAgentUser = {
  id: number;
  name: string;
  email: string;
  isActive: boolean;
  createdAt: string;
};

export default function UsersPage() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [magicLinkResult, setMagicLinkResult] = useState<string | null>(null);
  const [selectedTenantId, setSelectedTenantId] = useState<string>("");

  const { data, isLoading } = useQuery({
    queryKey: ["admin-tenants"],
    queryFn: () => apiFetch("/admin/tenants"),
  });

  const tenants: VoiceAgentUser[] = (data?.tenants ?? []).map((t: any) => ({
    id: t.id,
    name: t.name ?? t.email ?? "—",
    email: t.email,
    isActive: t.isActive ?? true,
    createdAt: t.createdAt,
  }));

  const refresh = () => qc.invalidateQueries({ queryKey: ["admin-tenants"] });

  const toggleMutation = useMutation({
    mutationFn: ({ id, isActive }: { id: number; isActive: boolean }) =>
      apiFetch(`/admin/tenants/${id}/active`, { method: "PATCH", body: JSON.stringify({ isActive }) }),
    onSuccess: refresh,
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => apiFetch(`/admin/tenants/${id}`, { method: "DELETE" }),
    onSuccess: refresh,
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const magicLinkMutation = useMutation({
    mutationFn: (tenantId: number) => apiFetch("/admin/magic-link", { method: "POST", body: JSON.stringify({ tenantId }) }),
    onSuccess: (data) => setMagicLinkResult(`${window.location.origin}/portal/auth/magic-login?token=${data.token}`),
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">User Management</h1>
          <p className="text-muted-foreground text-sm mt-1">Voice Agent users who signed up through the portal</p>
        </div>
        <Button disabled>
          <Plus className="h-4 w-4 mr-2" />
          Add User
        </Button>
      </div>

      <div className="rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Joined</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-muted-foreground py-8">Loading...</TableCell>
              </TableRow>
            ) : tenants.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-muted-foreground py-8">No users found</TableCell>
              </TableRow>
            ) : tenants.map((u) => (
              <TableRow key={u.id}>
                <TableCell className="font-medium">{u.name}</TableCell>
                <TableCell className="text-muted-foreground">{u.email}</TableCell>
                <TableCell>
                  <span className="inline-flex items-center gap-1 text-xs text-indigo-700 bg-indigo-50 px-2 py-0.5 rounded">
                    <Smartphone className="h-3 w-3" /> Voice Agent
                  </span>
                </TableCell>
                <TableCell>
                  {u.isActive ? (
                    <span className="inline-flex items-center gap-1 text-xs text-green-700"><CheckCircle className="h-3 w-3" /> Active</span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-xs text-red-600"><XCircle className="h-3 w-3" /> Inactive</span>
                  )}
                </TableCell>
                <TableCell className="text-muted-foreground text-sm">{new Date(u.createdAt).toLocaleDateString("en-IN")}</TableCell>
                <TableCell className="text-right">
                  <div className="flex items-center justify-end gap-1">
                    <Button size="sm" variant="ghost" title="Generate magic link" onClick={() => magicLinkMutation.mutate(u.id)}>
                      <LinkIcon className="h-3.5 w-3.5 text-indigo-500" />
                    </Button>
                    <Button size="sm" variant="ghost" title={u.isActive ? "Deactivate" : "Activate"} onClick={() => toggleMutation.mutate({ id: u.id, isActive: !u.isActive })}>
                      <ShieldOff className="h-3.5 w-3.5 text-orange-500" />
                    </Button>
                    <Button size="sm" variant="ghost" title="Delete user" onClick={() => { if (confirm(`Delete user ${u.name}?`)) deleteMutation.mutate(u.id); }}>
                      <Trash2 className="h-3.5 w-3.5 text-destructive" />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {magicLinkResult && (
        <div className="rounded-lg border bg-card p-4 space-y-2">
          <div className="flex items-center gap-2">
            <LinkIcon className="h-4 w-4 text-indigo-500" />
            <h3 className="font-semibold text-sm">Magic Link Generated</h3>
          </div>
          <div className="flex items-center gap-2">
            <code className="text-xs break-all flex-1 bg-muted px-3 py-2 rounded">{magicLinkResult}</code>
            <Button size="sm" variant="outline" onClick={() => { navigator.clipboard.writeText(magicLinkResult); toast({ title: "Copied!" }); }}>
              Copy
            </Button>
          </div>
          <p className="text-xs text-amber-600">Valid for 10 minutes, single use only.</p>
        </div>
      )}

      <div className="rounded-lg border bg-card p-6 space-y-4">
        <div>
          <h2 className="text-lg font-semibold flex items-center gap-2"><LinkIcon className="h-5 w-5" /> Generate Magic Link</h2>
          <p className="text-sm text-muted-foreground mt-1">Log in to the portal as any Voice Agent user (valid 10 min)</p>
        </div>
        <div className="flex gap-3 items-center">
          <Select value={selectedTenantId} onValueChange={setSelectedTenantId}>
            <SelectTrigger className="w-72">
              <SelectValue placeholder="Select Voice Agent user..." />
            </SelectTrigger>
            <SelectContent>
              {tenants.map((t) => (
                <SelectItem key={t.id} value={String(t.id)}>{t.name} ({t.email})</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button disabled={!selectedTenantId || magicLinkMutation.isPending} onClick={() => magicLinkMutation.mutate(Number(selectedTenantId))}>
            Generate
          </Button>
        </div>
      </div>

      <Dialog open={false} onOpenChange={() => undefined}>
        <DialogContent>
          <DialogHeader><DialogTitle>Unused</DialogTitle></DialogHeader>
          <DialogFooter />
        </DialogContent>
      </Dialog>
    </div>
  );
}
