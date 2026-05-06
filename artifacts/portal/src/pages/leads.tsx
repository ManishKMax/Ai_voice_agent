import { useState, useRef } from "react";
import { Link } from "wouter";
import { useAuth } from "@clerk/react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft, PhoneCall, Plus, Upload, Loader2, Trash2,
  RotateCcw, X, AlertCircle,
} from "lucide-react";
import { portalFetch } from "@/lib/portalFetch";

type Lead = {
  id: number;
  name: string;
  phone: string;
  status: string;
  notes: string | null;
  createdAt: string;
};

const statusBadge: Record<string, string> = {
  pending: "bg-gray-100 text-gray-700",
  calling: "bg-blue-100 text-blue-700",
  completed: "bg-emerald-100 text-emerald-700",
  interested: "bg-emerald-100 text-emerald-700",
  not_interested: "bg-red-100 text-red-700",
  no_response: "bg-amber-100 text-amber-700",
  callback: "bg-indigo-100 text-indigo-700",
  dnc: "bg-red-100 text-red-700",
};

export default function Leads() {
  const { getToken } = useAuth();
  const qc = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [notes, setNotes] = useState("");
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["portal-leads"],
    queryFn: async () => {
      const token = await getToken();
      return portalFetch("/api/portal/leads?limit=100", token) as Promise<{ leads: Lead[]; total: number }>;
    },
  });

  const createLead = useMutation({
    mutationFn: async (input: { name: string; phone: string; notes?: string }) => {
      const token = await getToken();
      return portalFetch("/api/portal/leads", token, {
        method: "POST",
        body: JSON.stringify(input),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["portal-leads"] });
      setShowAdd(false);
      setName(""); setPhone(""); setNotes("");
      setErrMsg(null);
    },
    onError: (e: Error) => setErrMsg(e.message),
  });

  const deleteLead = useMutation({
    mutationFn: async (id: number) => {
      const token = await getToken();
      return portalFetch(`/api/portal/leads/${id}`, token, { method: "DELETE" });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["portal-leads"] }),
  });

  const retryLead = useMutation({
    mutationFn: async (id: number) => {
      const token = await getToken();
      return portalFetch(`/api/portal/leads/${id}/retry`, token, { method: "POST" });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["portal-leads"] }),
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !phone.trim()) {
      setErrMsg("Name and phone are required");
      return;
    }
    createLead.mutate({ name: name.trim(), phone: phone.trim(), notes: notes.trim() || undefined });
  }

  async function handleCsvUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setErrMsg(null);
    const text = await file.text();
    const rows = text.split("\n").map((r) => r.trim()).filter(Boolean);
    if (rows.length === 0) return;

    const header = rows[0].toLowerCase();
    const hasHeader = header.includes("name") || header.includes("phone");
    const dataRows = hasHeader ? rows.slice(1) : rows;

    let added = 0;
    let failed = 0;
    for (const row of dataRows) {
      const cols = row.split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
      const [n, p, ...rest] = cols;
      if (!n || !p) { failed++; continue; }
      try {
        await createLead.mutateAsync({ name: n, phone: p, notes: rest.join(", ") || undefined });
        added++;
      } catch { failed++; }
    }
    setErrMsg(`Imported ${added} lead${added !== 1 ? "s" : ""}${failed ? `, ${failed} skipped` : ""}.`);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  const leads = data?.leads ?? [];

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-100">
        <div className="max-w-6xl mx-auto px-4 py-4 flex items-center gap-3">
          <Link to="/dashboard" className="flex items-center gap-2 text-gray-500 hover:text-gray-900 text-sm font-medium transition-colors">
            <ArrowLeft className="h-4 w-4" />
            Dashboard
          </Link>
          <span className="text-gray-300">/</span>
          <span className="text-sm font-semibold text-gray-900">Leads</span>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-8">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-xl font-bold text-gray-900">Leads</h1>
            <p className="text-gray-500 text-sm mt-1">{data?.total ?? 0} total · Manage your calling campaign leads</p>
          </div>
          <div className="flex items-center gap-2">
            <input ref={fileInputRef} type="file" accept=".csv,text/csv" onChange={handleCsvUpload} className="hidden" />
            <button onClick={() => fileInputRef.current?.click()} className="flex items-center gap-2 border border-gray-200 text-gray-700 px-4 py-2 rounded-lg text-sm font-medium hover:bg-gray-50 transition-colors">
              <Upload className="h-4 w-4" />
              Import CSV
            </button>
            <button onClick={() => setShowAdd(true)} className="flex items-center gap-2 bg-indigo-600 text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-indigo-700 transition-colors">
              <Plus className="h-4 w-4" />
              Add Lead
            </button>
          </div>
        </div>

        {errMsg && (
          <div className="mb-4 flex items-start gap-2 p-3 rounded-lg text-sm bg-amber-50 text-amber-800 border border-amber-200">
            <AlertCircle className="h-4 w-4 mt-0.5" />
            <span>{errMsg}</span>
          </div>
        )}

        {isLoading ? (
          <div className="bg-white border border-gray-100 rounded-2xl p-16 text-center">
            <Loader2 className="h-6 w-6 animate-spin text-gray-400 mx-auto" />
          </div>
        ) : leads.length === 0 ? (
          <div className="bg-white border border-gray-100 rounded-2xl p-16 text-center">
            <div className="h-14 w-14 bg-indigo-50 rounded-2xl flex items-center justify-center mx-auto mb-4">
              <PhoneCall className="h-7 w-7 text-indigo-400" />
            </div>
            <h3 className="font-semibold text-gray-900 mb-2">No leads yet</h3>
            <p className="text-sm text-gray-500 mb-6 max-w-sm mx-auto">
              Add your first lead to start your AI calling campaign. You can add leads one by one or import a CSV file.
            </p>
            <button onClick={() => setShowAdd(true)} className="inline-flex items-center gap-2 bg-indigo-600 text-white px-5 py-2.5 rounded-xl font-semibold hover:bg-indigo-700 transition-colors text-sm">
              <Plus className="h-4 w-4" />
              Add Your First Lead
            </button>
          </div>
        ) : (
          <div className="bg-white border border-gray-100 rounded-2xl overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-100">
                <tr>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Name</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Phone</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Status</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Created</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-600">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {leads.map((lead) => (
                  <tr key={lead.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 font-medium text-gray-900">{lead.name}</td>
                    <td className="px-4 py-3 text-gray-700 font-mono text-xs">{lead.phone}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-block px-2 py-0.5 rounded-md text-xs font-medium ${statusBadge[lead.status] ?? "bg-gray-100 text-gray-700"}`}>
                        {lead.status.replace(/_/g, " ")}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-500 text-xs">
                      {new Date(lead.createdAt).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="inline-flex items-center gap-1">
                        <button onClick={() => retryLead.mutate(lead.id)} disabled={retryLead.isPending} title="Re-call this lead" className="p-1.5 text-gray-500 hover:text-indigo-600 hover:bg-indigo-50 rounded transition-colors disabled:opacity-50">
                          <RotateCcw className="h-4 w-4" />
                        </button>
                        <button onClick={() => { if (confirm(`Delete lead "${lead.name}"?`)) deleteLead.mutate(lead.id); }} disabled={deleteLead.isPending} title="Delete" className="p-1.5 text-gray-500 hover:text-red-600 hover:bg-red-50 rounded transition-colors disabled:opacity-50">
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>

      {showAdd && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={() => setShowAdd(false)}>
          <div className="bg-white rounded-2xl shadow-xl max-w-md w-full p-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-semibold text-gray-900">Add New Lead</h2>
              <button onClick={() => setShowAdd(false)} className="text-gray-400 hover:text-gray-600">
                <X className="h-5 w-5" />
              </button>
            </div>
            <form onSubmit={handleSubmit} className="space-y-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Name *</label>
                <input value={name} onChange={(e) => setName(e.target.value)} type="text" required className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Phone (E.164) *</label>
                <input value={phone} onChange={(e) => setPhone(e.target.value)} type="tel" required placeholder="+919876543210" className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
                <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
              </div>
              {errMsg && (
                <div className="flex items-start gap-2 p-2.5 rounded-lg text-xs bg-red-50 text-red-700 border border-red-200">
                  <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
                  <span>{errMsg}</span>
                </div>
              )}
              <div className="flex items-center gap-2 pt-2">
                <button type="submit" disabled={createLead.isPending} className="flex-1 flex items-center justify-center gap-2 bg-indigo-600 text-white py-2.5 rounded-xl font-semibold hover:bg-indigo-700 disabled:opacity-60 transition-colors text-sm">
                  {createLead.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                  Add & Start Call
                </button>
                <button type="button" onClick={() => setShowAdd(false)} className="px-4 py-2.5 border border-gray-200 text-gray-700 rounded-xl font-medium hover:bg-gray-50 transition-colors text-sm">
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
