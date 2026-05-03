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
};

export default function UsersPage() {
  const { toast } = useToast();
  const qc = useQueryClient();

  const [createOpen, setCreateOpen] = useState(false);
  const [editRoleUser, setEditRoleUser] = useState<any>(null);
  const [resetPassUser, setResetPassUser] = useState<any>(null);
  const [magicLinkResult, setMagicLinkResult] = useState<string | null>(null);

  const [form, setForm] = useState({ name: "", email: "", password: "", role: "USER" });
  const [newRole, setNewRole] = useState("USER");
  const [newPassword, setNewPassword] = useState("");

  const { data: tenantsData } = useQuery({
    queryKey: ["admin-tenants"],
    queryFn: () => apiFetch("/admin/tenants"),
  });

  const tenants: any[] = tenantsData?.tenants ?? [];
  const users = tenants.map((t: any) => ({
    id: `tenant-${t.id}`,
    name: t.name,
    email: t.email,
    role: "PORTAL_USER",
    isActive: t.isActive,
    createdAt: t.createdAt,
  }));
  const isLoading = false;
  const displayUsers = users;

  const createMutation = useMutation({
    mutationFn: (body: any) => apiFetch("/admin/users", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["admin-tenants"] }); setCreateOpen(false); setForm({ name: "", email: "", password: "", role: "USER" }); toast({ title: "User created" }); },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const roleMutation = useMutation({
    mutationFn: ({ id, role }: any) => apiFetch(`/admin/users/${id}/role`, { method: "PATCH", body: JSON.stringify({ role }) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["admin-tenants"] }); setEditRoleUser(null); toast({ title: "Role updated" }); },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, isActive }: any) => apiFetch(`/admin/users/${id}/active`, { method: "PATCH", body: JSON.stringify({ isActive }) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["admin-tenants"] }); toast({ title: "Status updated" }); },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => apiFetch(`/admin/users/${id}`, { method: "DELETE" }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["admin-tenants"] }); toast({ title: "User deleted" }); },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const resetPassMutation = useMutation({
    mutationFn: ({ id, password }: any) => apiFetch(`/admin/users/${id}/password`, { method: "PATCH", body: JSON.stringify({ password }) }),
    onSuccess: () => { setResetPassUser(null); setNewPassword(""); toast({ title: "Password reset" }); },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const magicLinkMutation = useMutation({
    mutationFn: (tenantId: number) => apiFetch("/admin/magic-link", { method: "POST", body: JSON.stringify({ tenantId }) }),
    onSuccess: (data) => {
      const baseUrl = window.location.origin;
      const link = `${baseUrl}/portal/auth/magic-login?token=${data.token}`;
      setMagicLinkResult(link);
    },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">User Management</h1>
          <p className="text-muted-foreground text-sm mt-1">Manage admin dashboard users and their roles</p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4 mr-2" />
          Add User
        </Button>
      </div>

      {/* Users Table */}
      <div className="rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Created</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground py-8">Loading...</TableCell></TableRow>
            ) : displayUsers.length === 0 ? (
              <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground py-8">No users found</TableCell></TableRow>
            ) : displayUsers.map((u) => (
              <TableRow key={u.id}>
                <TableCell className="font-medium">{u.name}</TableCell>
                <TableCell className="text-muted-foreground">{u.email}</TableCell>
                <TableCell>
                  <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${ROLE_COLORS[u.role] ?? "bg-gray-100 text-gray-600"}`}>
                    {u.role}
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
                    <Button size="sm" variant="ghost" title="Edit role" onClick={() => { setEditRoleUser(u); setNewRole(u.role); }}>
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button size="sm" variant="ghost" title="Reset password" onClick={() => setResetPassUser(u)}>
                      <KeyRound className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      title={u.isActive ? "Deactivate" : "Activate"}
                      onClick={() => toggleMutation.mutate({ id: u.id, isActive: !u.isActive })}
                    >
                      {u.isActive ? <ShieldOff className="h-3.5 w-3.5 text-orange-500" /> : <ShieldCheck className="h-3.5 w-3.5 text-green-600" />}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      title="Delete user"
                      onClick={() => {
                        if (typeof u.id === "number" && confirm(`Delete user ${u.name}?`)) deleteMutation.mutate(u.id);
                      }}
                    >
                      <Trash2 className="h-3.5 w-3.5 text-destructive" />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* Portal Magic Link section */}
      <div className="rounded-lg border bg-card p-6 space-y-4">
        <div>
          <h2 className="text-lg font-semibold flex items-center gap-2"><LinkIcon className="h-5 w-5" /> Magic Link Login</h2>
          <p className="text-sm text-muted-foreground mt-1">Generate a temporary login link to log in to the portal as any tenant (valid 10 min)</p>
        </div>
        <div className="flex gap-3 items-center">
          <Select onValueChange={(v) => magicLinkMutation.mutate(Number(v))}>
            <SelectTrigger className="w-64">
              <SelectValue placeholder="Select tenant..." />
            </SelectTrigger>
            <SelectContent>
              {tenants.map((t: any) => (
                <SelectItem key={t.id} value={String(t.id)}>{t.name} ({t.email})</SelectItem>
              ))}
            </SelectContent>
          </Select>
          {magicLinkMutation.isPending && <span className="text-sm text-muted-foreground">Generating...</span>}
        </div>
        {magicLinkResult && (
          <div className="rounded-md bg-muted p-3 space-y-2">
            <p className="text-xs text-muted-foreground font-medium">Magic link (valid for 10 minutes):</p>
            <div className="flex items-center gap-2">
              <code className="text-xs break-all flex-1">{magicLinkResult}</code>
              <Button size="sm" variant="outline" onClick={() => { navigator.clipboard.writeText(magicLinkResult); toast({ title: "Copied!" }); }}>
                Copy
              </Button>
            </div>
            <p className="text-xs text-amber-600">Share this link securely. It expires in 10 minutes and can only be used once.</p>
          </div>
        )}
      </div>

      {/* Create User Dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Create User</DialogTitle></DialogHeader>
          <div className="space-y-4 py-2">
            {(["name", "email", "password"] as const).map((field) => (
              <div key={field} className="space-y-1">
                <label className="text-sm font-medium capitalize">{field}</label>
                <Input
                  type={field === "password" ? "password" : "text"}
                  value={form[field]}
                  onChange={(e) => setForm((f) => ({ ...f, [field]: e.target.value }))}
                  placeholder={field === "email" ? "user@company.com" : ""}
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

      {/* Edit Role Dialog */}
      <Dialog open={!!editRoleUser} onOpenChange={(o) => !o && setEditRoleUser(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Change Role — {editRoleUser?.name}</DialogTitle></DialogHeader>
          <div className="py-2 space-y-1">
            <label className="text-sm font-medium">New Role</label>
            <Select value={newRole} onValueChange={setNewRole}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="USER">USER</SelectItem>
                <SelectItem value="COMPANY_ADMIN">COMPANY_ADMIN</SelectItem>
                <SelectItem value="SUPER_ADMIN">SUPER_ADMIN</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditRoleUser(null)}>Cancel</Button>
            <Button onClick={() => roleMutation.mutate({ id: editRoleUser?.id, role: newRole })} disabled={roleMutation.isPending}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reset Password Dialog */}
      <Dialog open={!!resetPassUser} onOpenChange={(o) => !o && setResetPassUser(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Reset Password — {resetPassUser?.name}</DialogTitle></DialogHeader>
          <div className="py-2 space-y-1">
            <label className="text-sm font-medium">New Password</label>
            <Input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="Min 6 characters" />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setResetPassUser(null)}>Cancel</Button>
            <Button onClick={() => resetPassMutation.mutate({ id: resetPassUser?.id, password: newPassword })} disabled={resetPassMutation.isPending}>
              Reset
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
