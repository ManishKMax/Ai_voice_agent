import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Users as UsersIcon,
  Plus,
  Pencil,
  Trash2,
  ShieldCheck,
  ShieldOff,
  KeyRound,
  Link as LinkIcon,
  CheckCircle,
  XCircle,
  Smartphone,
  Shield,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

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

const ROLE_COLORS: Record<string, string> = {
  SUPER_ADMIN: "bg-red-100 text-red-700",
  COMPANY_ADMIN: "bg-blue-100 text-blue-700",
  USER: "bg-gray-100 text-gray-600",
  VOICE_AGENT: "bg-indigo-100 text-indigo-700",
};

type UnifiedUser = {
  uid: string;
  id: number;
  name: string;
  email: string;
  role: string;
  isActive: boolean;
  createdAt: string;
  source: "portal" | "admin";
};

export default function UsersPage() {
  const { toast } = useToast();
  const qc = useQueryClient();

  const [tab, setTab] = useState<"all" | "portal">("all");
  const [createOpen, setCreateOpen] = useState(false);
  const [editRoleUser, setEditRoleUser] = useState<UnifiedUser | null>(null);
  const [resetPassUser, setResetPassUser] = useState<UnifiedUser | null>(null);
  const [magicLinkResult, setMagicLinkResult] = useState<string | null>(null);

  const [form, setForm] = useState({ name: "", email: "", password: "", role: "USER" });
  const [newRole, setNewRole] = useState("USER");
  const [newPassword, setNewPassword] = useState("");

  const { data: tenantsData, isLoading: tenantsLoading } = useQuery({
    queryKey: ["admin-tenants"],
    queryFn: () => apiFetch("/admin/tenants"),
  });

  const { data: adminUsersData, isLoading: adminUsersLoading } = useQuery({
    queryKey: ["admin-users"],
    queryFn: () => apiFetch("/admin/users"),
  });

  const tenants: any[] = tenantsData?.tenants ?? [];
  const adminUsers: any[] = adminUsersData?.users ?? [];

  const portalUsers: UnifiedUser[] = tenants.map((t: any) => ({
    uid: `tenant-${t.id}`,
    id: t.id,
    name: t.name ?? t.email ?? "—",
    email: t.email,
    role: "VOICE_AGENT",
    isActive: t.isActive ?? true,
    createdAt: t.createdAt,
    source: "portal",
  }));

  const dashboardUsers: UnifiedUser[] = adminUsers.map((u: any) => ({
    uid: `admin-${u.id}`,
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    isActive: u.isActive,
    createdAt: u.createdAt,
    source: "admin",
  }));

  const allUsers: UnifiedUser[] =
    tab === "portal"
      ? portalUsers
      : [...portalUsers, ...dashboardUsers].sort(
          (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        );

  const isLoading = tenantsLoading || adminUsersLoading;

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["admin-tenants"] });
    qc.invalidateQueries({ queryKey: ["admin-users"] });
  };

  const createMutation = useMutation({
    mutationFn: (body: any) => apiFetch("/admin/users", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => { invalidate(); setCreateOpen(false); setForm({ name: "", email: "", password: "", role: "USER" }); toast({ title: "User created" }); },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const roleMutation = useMutation({
    mutationFn: ({ id, role }: { id: number; role: string }) =>
      apiFetch(`/admin/users/${id}/role`, { method: "PATCH", body: JSON.stringify({ role }) }),
    onSuccess: () => { invalidate(); setEditRoleUser(null); toast({ title: "Role updated" }); },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const toggleAdminMutation = useMutation({
    mutationFn: ({ id, isActive }: { id: number; isActive: boolean }) =>
      apiFetch(`/admin/users/${id}/active`, { method: "PATCH", body: JSON.stringify({ isActive }) }),
    onSuccess: () => { invalidate(); toast({ title: "Status updated" }); },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const toggleTenantMutation = useMutation({
    mutationFn: ({ id, isActive }: { id: number; isActive: boolean }) =>
      apiFetch(`/admin/tenants/${id}/active`, { method: "PATCH", body: JSON.stringify({ isActive }) }),
    onSuccess: () => { invalidate(); toast({ title: "Status updated" }); },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const deleteAdminMutation = useMutation({
    mutationFn: (id: number) => apiFetch(`/admin/users/${id}`, { method: "DELETE" }),
    onSuccess: () => { invalidate(); toast({ title: "User deleted" }); },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const deleteTenantMutation = useMutation({
    mutationFn: (id: number) => apiFetch(`/admin/tenants/${id}`, { method: "DELETE" }),
    onSuccess: () => { invalidate(); toast({ title: "User deleted" }); },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const resetPassMutation = useMutation({
    mutationFn: ({ id, password }: { id: number; password: string }) =>
      apiFetch(`/admin/users/${id}/password`, { method: "PATCH", body: JSON.stringify({ password }) }),
    onSuccess: () => { setResetPassUser(null); setNewPassword(""); toast({ title: "Password reset" }); },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const magicLinkMutation = useMutation({
    mutationFn: (tenantId: number) => apiFetch("/admin/magic-link", { method: "POST", body: JSON.stringify({ tenantId }) }),
    onSuccess: (data) => {
      const baseUrl = window.location.origin;
      setMagicLinkResult(`${baseUrl}/portal/auth/magic-login?token=${data.token}`);
    },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  function handleToggle(u: UnifiedUser) {
    if (u.source === "portal") {
      toggleTenantMutation.mutate({ id: u.id, isActive: !u.isActive });
    } else {
      toggleAdminMutation.mutate({ id: u.id, isActive: !u.isActive });
    }
  }

  function handleDelete(u: UnifiedUser) {
    if (!confirm(`Delete user ${u.name}?`)) return;
    if (u.source === "portal") {
      deleteTenantMutation.mutate(u.id);
    } else {
      deleteAdminMutation.mutate(u.id);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">User Management</h1>
          <p className="text-muted-foreground text-sm mt-1">
            {portalUsers.length} Voice Agent users · {dashboardUsers.length} admin users
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4 mr-2" />
          Add Admin User
        </Button>
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as any)}>
        <TabsList>
          <TabsTrigger value="all">All ({portalUsers.length + dashboardUsers.length})</TabsTrigger>
          <TabsTrigger value="portal">
            <Smartphone className="h-3.5 w-3.5 mr-1.5" />
            Voice Agent ({portalUsers.length})
          </TabsTrigger>
        </TabsList>
      </Tabs>

      <div className="rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Joined</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={7} className="text-center text-muted-foreground py-8">Loading...</TableCell>
              </TableRow>
            ) : allUsers.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="text-center text-muted-foreground py-8">No users found</TableCell>
              </TableRow>
            ) : allUsers.map((u) => (
              <TableRow key={u.uid}>
                <TableCell className="font-medium">{u.name}</TableCell>
                <TableCell className="text-muted-foreground">{u.email}</TableCell>
                <TableCell>
                  {u.source === "portal" ? (
                    <span className="inline-flex items-center gap-1 text-xs text-indigo-700 bg-indigo-50 px-2 py-0.5 rounded">
                      <Smartphone className="h-3 w-3" /> Voice Agent
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-xs text-blue-700 bg-blue-50 px-2 py-0.5 rounded">
                      <Shield className="h-3 w-3" /> Admin
                    </span>
                  )}
                </TableCell>
                <TableCell>
                  <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${ROLE_COLORS[u.role] ?? "bg-gray-100 text-gray-600"}`}>
                    {u.role === "VOICE_AGENT" ? "Voice Agent" : u.role}
                  </span>
                </TableCell>
                <TableCell>
                  {u.isActive ? (
                    <span className="inline-flex items-center gap-1 text-xs text-green-700">
                      <CheckCircle className="h-3 w-3" /> Active
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-xs text-red-600">
                      <XCircle className="h-3 w-3" /> Inactive
                    </span>
                  )}
                </TableCell>
                <TableCell className="text-muted-foreground text-sm">
                  {new Date(u.createdAt).toLocaleDateString("en-IN")}
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex items-center justify-end gap-1">
                    {u.source === "portal" && (
                      <Button
                        size="sm"
                        variant="ghost"
                        title="Generate magic link"
                        onClick={() => magicLinkMutation.mutate(u.id)}
                      >
                        <LinkIcon className="h-3.5 w-3.5 text-indigo-500" />
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      title={u.isActive ? "Deactivate" : "Activate"}
                      onClick={() => handleToggle(u)}
                    >
                      {u.isActive
                        ? <ShieldOff className="h-3.5 w-3.5 text-orange-500" />
                        : <ShieldCheck className="h-3.5 w-3.5 text-green-600" />}
                    </Button>
                    <Button size="sm" variant="ghost" title="Delete user" onClick={() => handleDelete(u)}>
                      <Trash2 className="h-3.5 w-3.5 text-destructive" />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* Magic Link Result */}
      {magicLinkResult && (
        <div className="rounded-lg border bg-card p-4 space-y-2">
          <div className="flex items-center gap-2">
            <LinkIcon className="h-4 w-4 text-indigo-500" />
            <h3 className="font-semibold text-sm">Magic Link Generated</h3>
          </div>
          <div className="flex items-center gap-2">
            <code className="text-xs break-all flex-1 bg-muted px-3 py-2 rounded">{magicLinkResult}</code>
            <Button size="sm" variant="outline" onClick={() => { navigator.clipboard.writeText(magicLinkResult!); toast({ title: "Copied!" }); }}>
              Copy
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setMagicLinkResult(null)}>✕</Button>
          </div>
          <p className="text-xs text-amber-600">Valid for 10 minutes, single use only.</p>
        </div>
      )}

      {/* Magic Link Section for bulk selection */}
      <div className="rounded-lg border bg-card p-6 space-y-4">
        <div>
          <h2 className="text-lg font-semibold flex items-center gap-2"><LinkIcon className="h-5 w-5" /> Generate Magic Link</h2>
          <p className="text-sm text-muted-foreground mt-1">Log in to the portal as any Voice Agent user (valid 10 min)</p>
        </div>
        <div className="flex gap-3 items-center">
          <Select onValueChange={(v) => magicLinkMutation.mutate(Number(v))}>
            <SelectTrigger className="w-72">
              <SelectValue placeholder="Select Voice Agent user..." />
            </SelectTrigger>
            <SelectContent>
              {tenants.map((t: any) => (
                <SelectItem key={t.id} value={String(t.id)}>{t.name ?? t.email} ({t.email})</SelectItem>
              ))}
            </SelectContent>
          </Select>
          {magicLinkMutation.isPending && <span className="text-sm text-muted-foreground">Generating...</span>}
        </div>
      </div>

      {/* Create Admin User Dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Add Admin User</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">Creates a dashboard admin account. Voice Agent users sign up via the portal with Google.</p>
          <div className="space-y-4 py-2">
            {(["name", "email", "password"] as const).map((field) => (
              <div key={field} className="space-y-1">
                <label className="text-sm font-medium capitalize">{field}</label>
                <Input
                  type={field === "password" ? "password" : "text"}
                  value={form[field]}
                  onChange={(e) => setForm((f) => ({ ...f, [field]: e.target.value }))}
                  placeholder={field === "email" ? "admin@company.com" : ""}
                />
              </div>
            ))}
            <div className="space-y-1">
              <label className="text-sm font-medium">Role</label>
              <Select value={form.role} onValueChange={(v) => setForm((f) => ({ ...f, role: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="USER">USER</SelectItem>
                  <SelectItem value="COMPANY_ADMIN">COMPANY_ADMIN</SelectItem>
                  <SelectItem value="SUPER_ADMIN">SUPER_ADMIN</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button onClick={() => createMutation.mutate(form)} disabled={createMutation.isPending}>
              {createMutation.isPending ? "Creating..." : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </div>
  );
}
