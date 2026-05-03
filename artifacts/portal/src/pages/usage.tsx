import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { useClerk } from "@clerk/react";
import {
  ArrowLeft, PhoneCall, Clock, IndianRupee, BarChart3,
  CheckCircle, PhoneMissed, PhoneOff, LogOut, AlertTriangle,
  TrendingUp, ChevronLeft, ChevronRight, Download, Calendar, FileText,
} from "lucide-react";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

async function fetchUsage(offset: number, limit: number) {
  const res = await fetch(`${basePath}/api/portal/usage?offset=${offset}&limit=${limit}`, {
    credentials: "include",
  });
  if (!res.ok) throw new Error("Failed to fetch usage data");
  return res.json();
}

async function fetchUsageMonths() {
  const res = await fetch(`${basePath}/api/portal/usage/months`, { credentials: "include" });
  if (!res.ok) throw new Error("Failed to fetch months");
  return res.json();
}

async function fetchInvoice(year: number, month: number) {
  const res = await fetch(`${basePath}/api/portal/usage/invoice?year=${year}&month=${month}`, {
    credentials: "include",
  });
  if (!res.ok) throw new Error("Failed to fetch invoice data");
  return res.json();
}

function csvEsc(val: unknown): string {
  const s = String(val ?? "");
  return s.includes(",") || s.includes('"') || s.includes("\n")
    ? `"${s.replace(/"/g, '""')}"`
    : s;
}

function buildCsv(data: any): string {
  const lines: string[] = [];
  lines.push("VoiceAgent Monthly Invoice");
  lines.push(`Period,${csvEsc(data.monthLabel)}`);
  lines.push(`Generated,${new Date().toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" })}`);
  lines.push(`Rate,Rs ${data.perMinuteRateRupees} per minute`);
  lines.push("");
  lines.push(["Call ID", "Lead Name", "Phone Number", "Campaign", "Status", "Date & Time", "Duration", "Minutes Billed", "Cost (Rs)"].map(csvEsc).join(","));
  for (const c of data.calls) {
    const mins = Math.floor(c.duration / 60);
    const secs = c.duration % 60;
    const dur = c.duration ? (mins > 0 ? `${mins}m ${secs}s` : `${secs}s`) : "0s";
    const dt = new Date(c.createdAt).toLocaleDateString("en-IN", {
      day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: true,
    });
    lines.push([c.id, c.leadName, c.leadPhone, c.sourceLabel, c.callStatus, dt, dur, c.minutesBilled, c.costRupees > 0 ? c.costRupees.toFixed(2) : "0.00"].map(csvEsc).join(","));
  }
  lines.push("");
  lines.push("SUMMARY");
  lines.push(`Total Calls,${data.summary.totalCalls}`);
  lines.push(`Completed Calls,${data.summary.completedCalls}`);
  lines.push(`Failed / No Answer,${data.summary.totalCalls - data.summary.completedCalls}`);
  lines.push(`Total Minutes Billed,${data.summary.totalMinutesBilled}`);
  lines.push(`Total Cost (Rs),${data.summary.totalCostRupees.toFixed(2)}`);
  const avg = data.summary.avgCallDurationSeconds;
  const am = Math.floor(avg / 60), as_ = avg % 60;
  lines.push(`Average Call Duration,${avg ? (am > 0 ? `${am}m ${as_}s` : `${as_}s`) : "0s"}`);
  return lines.join("\n");
}

type CallStatus = "initiated" | "ringing" | "answered" | "completed" | "no-answer" | "busy" | "failed";

function statusStyle(s: CallStatus) {
  switch (s) {
    case "completed": return { cls: "text-green-700 bg-green-50 border-green-200", label: "Completed" };
    case "no-answer": return { cls: "text-amber-700 bg-amber-50 border-amber-200", label: "No Answer" };
    case "busy":      return { cls: "text-orange-700 bg-orange-50 border-orange-200", label: "Busy" };
    case "failed":    return { cls: "text-red-700 bg-red-50 border-red-200", label: "Failed" };
    case "answered":  return { cls: "text-blue-700 bg-blue-50 border-blue-200", label: "In Progress" };
    default:          return { cls: "text-gray-600 bg-gray-50 border-gray-200", label: s };
  }
}

function fmtDuration(secs: number) {
  if (!secs) return "—";
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function fmtDate(iso: string) {
  const d = new Date(iso);
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) +
    " " + d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true });
}

const PAGE_SIZE = 20;

export default function Usage() {
  const { signOut } = useClerk();
  const [page, setPage] = useState(0);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [selectedMonth, setSelectedMonth] = useState("");
  const [isExporting, setIsExporting] = useState(false);
  const [exportError, setExportError] = useState("");

  const offset = page * PAGE_SIZE;
  const { data, isLoading, error } = useQuery({
    queryKey: ["portal-usage", page],
    queryFn: () => fetchUsage(offset, PAGE_SIZE),
    retry: 1,
    keepPreviousData: true,
  } as any);

  const { data: monthsData, isLoading: monthsLoading } = useQuery({
    queryKey: ["portal-usage-months"],
    queryFn: fetchUsageMonths,
    retry: 1,
  });

  const summary = data?.summary;
  const byCampaign: any[] = data?.byCampaign ?? [];
  const allCalls: any[] = data?.calls ?? [];
  const total: number = data?.total ?? 0;
  const rateRupees: number = data?.perMinuteRateRupees ?? 5;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const filteredCalls = statusFilter === "all"
    ? allCalls
    : allCalls.filter((c: any) => c.callStatus === statusFilter);

  async function handleExport() {
    if (!selectedMonth) return;
    const [y, m] = selectedMonth.split("-").map(Number);
    setIsExporting(true);
    setExportError("");
    try {
      const invoiceData = await fetchInvoice(y, m);
      const csv = buildCsv(invoiceData);
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `voiceagent-invoice-${invoiceData.monthLabel.replace(/\s+/g, "-").toLowerCase()}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch {
      setExportError("Could not generate invoice. Please try again.");
    } finally {
      setIsExporting(false);
    }
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-100">
        <div className="max-w-6xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <img src={`${basePath}/logo.svg`} alt="Logo" className="h-8 w-8" />
            <span className="font-bold text-gray-900">VoiceAgent</span>
          </div>
          <nav className="hidden md:flex items-center gap-6">
            {[
              { to: "/dashboard", label: "Dashboard" },
              { to: "/leads", label: "Leads" },
              { to: "/billing", label: "Billing" },
              { to: "/usage", label: "Usage" },
              { to: "/kyc", label: "KYC" },
              { to: "/settings", label: "Settings" },
            ].map((n) => (
              <Link key={n.to} to={n.to} className={`text-sm font-medium transition-colors ${n.to === "/usage" ? "text-indigo-600" : "text-gray-600 hover:text-indigo-600"}`}>
                {n.label}
              </Link>
            ))}
          </nav>
          <button
            onClick={() => signOut({ redirectUrl: basePath + "/" })}
            className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-900 transition-colors"
          >
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-8 space-y-6">
        <div className="flex items-center gap-3 mb-2">
          <Link to="/dashboard" className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-900 transition-colors">
            <ArrowLeft className="h-4 w-4" />
            Dashboard
          </Link>
          <span className="text-gray-300">/</span>
          <span className="text-sm font-semibold text-gray-900">Usage & Call History</span>
        </div>

        <div>
          <h1 className="text-xl font-bold text-gray-900 flex items-center gap-2">
            <BarChart3 className="h-5 w-5 text-indigo-500" />
            Usage & Call History
          </h1>
          <p className="text-gray-500 text-sm mt-1">
            Track calls made, minutes consumed, and cost breakdown by campaign. Charged at ₹{rateRupees}/min.
          </p>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-2xl p-4 flex items-center gap-3 text-red-700 text-sm">
            <AlertTriangle className="h-4 w-4 flex-shrink-0" />
            Could not load usage data. Please refresh the page.
          </div>
        )}

        {/* Summary stat cards */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {isLoading ? (
            Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="bg-white rounded-2xl border border-gray-100 p-5 animate-pulse">
                <div className="h-3 bg-gray-100 rounded w-20 mb-4" />
                <div className="h-7 bg-gray-100 rounded w-12" />
              </div>
            ))
          ) : summary ? (
            <>
              <div className="bg-white rounded-2xl border border-gray-100 p-5">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-xs font-medium text-gray-500 uppercase tracking-wide">Total Calls</span>
                  <PhoneCall className="h-4 w-4 text-indigo-400" />
                </div>
                <div className="text-2xl font-bold text-gray-900">{summary.totalCalls}</div>
                <div className="text-xs text-gray-400 mt-1">{summary.completedCalls} completed</div>
              </div>

              <div className="bg-white rounded-2xl border border-gray-100 p-5">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-xs font-medium text-gray-500 uppercase tracking-wide">Minutes Used</span>
                  <Clock className="h-4 w-4 text-purple-400" />
                </div>
                <div className="text-2xl font-bold text-gray-900">{summary.totalMinutesBilled}</div>
                <div className="text-xs text-gray-400 mt-1">billed minutes</div>
              </div>

              <div className="bg-white rounded-2xl border border-gray-100 p-5">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-xs font-medium text-gray-500 uppercase tracking-wide">Total Spend</span>
                  <IndianRupee className="h-4 w-4 text-green-400" />
                </div>
                <div className="text-2xl font-bold text-gray-900">₹{summary.totalCostRupees.toLocaleString("en-IN")}</div>
                <div className="text-xs text-gray-400 mt-1">at ₹{rateRupees}/min</div>
              </div>

              <div className="bg-white rounded-2xl border border-gray-100 p-5">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-xs font-medium text-gray-500 uppercase tracking-wide">Avg Duration</span>
                  <TrendingUp className="h-4 w-4 text-blue-400" />
                </div>
                <div className="text-2xl font-bold text-gray-900">{fmtDuration(summary.avgCallDurationSeconds)}</div>
                <div className="text-xs text-gray-400 mt-1">per completed call</div>
              </div>
            </>
          ) : null}
        </div>

        {/* Campaign breakdown */}
        {!isLoading && byCampaign.length > 0 && (
          <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
            <div className="px-5 py-4 border-b border-gray-100">
              <h2 className="font-semibold text-gray-900">Spend by Campaign</h2>
              <p className="text-xs text-gray-500 mt-0.5">Cost and usage grouped by lead source</p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 border-b border-gray-100">
                    <th className="text-left px-5 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Campaign</th>
                    <th className="text-right px-5 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Calls</th>
                    <th className="text-right px-5 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Completed</th>
                    <th className="text-right px-5 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Minutes</th>
                    <th className="text-right px-5 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Cost</th>
                    <th className="px-5 py-3"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {byCampaign.map((camp: any) => {
                    const pct = camp.calls > 0 ? Math.round((camp.completedCalls / camp.calls) * 100) : 0;
                    return (
                      <tr key={camp.source} className="hover:bg-gray-50/50 transition-colors">
                        <td className="px-5 py-3.5">
                          <div className="font-medium text-gray-900">{camp.label}</div>
                          <div className="text-xs text-gray-400">{camp.source}</div>
                        </td>
                        <td className="px-5 py-3.5 text-right text-gray-700 font-medium">{camp.calls}</td>
                        <td className="px-5 py-3.5 text-right">
                          <span className="text-gray-700 font-medium">{camp.completedCalls}</span>
                          <span className="text-gray-400 text-xs ml-1">({pct}%)</span>
                        </td>
                        <td className="px-5 py-3.5 text-right text-gray-700 font-medium">{camp.minutesBilled} min</td>
                        <td className="px-5 py-3.5 text-right font-semibold text-gray-900">
                          ₹{camp.costRupees.toLocaleString("en-IN")}
                        </td>
                        <td className="px-5 py-3.5">
                          <div className="w-16 bg-gray-100 rounded-full h-1.5">
                            <div
                              className="bg-indigo-400 rounded-full h-1.5"
                              style={{ width: `${Math.min(100, summary ? (camp.costRupees / Math.max(1, summary.totalCostRupees)) * 100 : 0)}%` }}
                            />
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Monthly Invoice Export */}
        <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
          <div className="px-5 py-4 border-b border-gray-100">
            <h2 className="font-semibold text-gray-900 flex items-center gap-2">
              <FileText className="h-4 w-4 text-indigo-500" />
              Monthly Invoice Export
            </h2>
            <p className="text-xs text-gray-500 mt-0.5">
              Download a CSV invoice for any month — includes every call, minutes billed, and a cost summary.
            </p>
          </div>
          <div className="px-5 py-4 flex flex-col sm:flex-row items-start sm:items-center gap-3">
            <div className="flex items-center gap-2">
              <Calendar className="h-4 w-4 text-gray-400 flex-shrink-0" />
              {monthsLoading ? (
                <div className="h-9 w-44 bg-gray-100 rounded-lg animate-pulse" />
              ) : (
                <select
                  value={selectedMonth}
                  onChange={(e) => { setSelectedMonth(e.target.value); setExportError(""); }}
                  className="text-sm border border-gray-200 rounded-lg px-3 py-2 text-gray-700 focus:outline-none focus:ring-2 focus:ring-indigo-200 bg-white min-w-[200px]"
                >
                  <option value="">Select a month…</option>
                  {(monthsData ?? []).map((m: any) => (
                    <option key={m.value} value={m.value}>
                      {m.label} ({m.callCount} {m.callCount === 1 ? "call" : "calls"})
                    </option>
                  ))}
                </select>
              )}
            </div>
            <button
              onClick={handleExport}
              disabled={!selectedMonth || isExporting}
              className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {isExporting ? (
                <div className="h-4 w-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              ) : (
                <Download className="h-4 w-4" />
              )}
              {isExporting ? "Generating…" : "Download CSV"}
            </button>
            {!monthsLoading && (monthsData ?? []).length === 0 && (
              <span className="text-xs text-gray-400">No call history yet — invoices will appear once calls are made.</span>
            )}
          </div>
          {exportError && (
            <div className="px-5 pb-4">
              <p className="text-xs text-red-600 flex items-center gap-1.5">
                <AlertTriangle className="h-3 w-3" />
                {exportError}
              </p>
            </div>
          )}
        </div>

        {/* Call log */}
        <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
          <div className="px-5 py-4 border-b border-gray-100 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <h2 className="font-semibold text-gray-900">Call Log</h2>
              <p className="text-xs text-gray-500 mt-0.5">
                {total > 0 ? `${total} calls total` : "No calls yet"}
              </p>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              {(["all", "completed", "no-answer", "busy", "failed"] as const).map((f) => (
                <button
                  key={f}
                  onClick={() => setStatusFilter(f)}
                  className={`px-3 py-1 rounded-full text-xs font-medium transition-colors border ${
                    statusFilter === f
                      ? "bg-indigo-600 text-white border-indigo-600"
                      : "text-gray-600 border-gray-200 hover:border-gray-300"
                  }`}
                >
                  {f === "all" ? "All" : f === "no-answer" ? "No Answer" : f.charAt(0).toUpperCase() + f.slice(1)}
                </button>
              ))}
            </div>
          </div>

          {isLoading ? (
            <div className="divide-y divide-gray-50">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="px-5 py-4 animate-pulse flex items-center gap-4">
                  <div className="h-9 w-9 bg-gray-100 rounded-full flex-shrink-0" />
                  <div className="flex-1 space-y-2">
                    <div className="h-3 bg-gray-100 rounded w-32" />
                    <div className="h-3 bg-gray-100 rounded w-20" />
                  </div>
                  <div className="h-3 bg-gray-100 rounded w-16" />
                  <div className="h-3 bg-gray-100 rounded w-12" />
                </div>
              ))}
            </div>
          ) : filteredCalls.length === 0 ? (
            <div className="py-16 text-center">
              <div className="h-12 w-12 bg-gray-50 rounded-2xl flex items-center justify-center mx-auto mb-3">
                <PhoneCall className="h-6 w-6 text-gray-300" />
              </div>
              <p className="text-sm text-gray-500">No calls found</p>
              <p className="text-xs text-gray-400 mt-1">Calls will appear here once your campaign starts</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 border-b border-gray-100">
                    <th className="text-left px-5 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Lead</th>
                    <th className="text-left px-5 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide hidden sm:table-cell">Campaign</th>
                    <th className="text-left px-5 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Status</th>
                    <th className="text-right px-5 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Duration</th>
                    <th className="text-right px-5 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Minutes</th>
                    <th className="text-right px-5 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Cost</th>
                    <th className="text-right px-5 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide hidden md:table-cell">Date</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {filteredCalls.map((call: any) => {
                    const st = statusStyle(call.callStatus);
                    return (
                      <tr key={call.id} className="hover:bg-gray-50/40 transition-colors">
                        <td className="px-5 py-3.5">
                          <div className="font-medium text-gray-900 truncate max-w-[140px]">{call.leadName}</div>
                          <div className="text-xs text-gray-400">{call.leadPhone}</div>
                        </td>
                        <td className="px-5 py-3.5 hidden sm:table-cell">
                          <span className="text-xs text-gray-500 bg-gray-100 px-2 py-0.5 rounded-full">{call.sourceLabel}</span>
                        </td>
                        <td className="px-5 py-3.5">
                          <span className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full border ${st.cls}`}>
                            {call.callStatus === "completed" && <CheckCircle className="h-3 w-3" />}
                            {call.callStatus === "no-answer" && <PhoneMissed className="h-3 w-3" />}
                            {(call.callStatus === "failed" || call.callStatus === "busy") && <PhoneOff className="h-3 w-3" />}
                            {st.label}
                          </span>
                        </td>
                        <td className="px-5 py-3.5 text-right text-gray-600 tabular-nums">{fmtDuration(call.duration)}</td>
                        <td className="px-5 py-3.5 text-right">
                          {call.minutesBilled > 0
                            ? <span className="font-medium text-gray-900">{call.minutesBilled} min</span>
                            : <span className="text-gray-400">—</span>}
                        </td>
                        <td className="px-5 py-3.5 text-right">
                          {call.costRupees > 0
                            ? <span className="font-semibold text-gray-900">₹{call.costRupees}</span>
                            : <span className="text-gray-400">—</span>}
                        </td>
                        <td className="px-5 py-3.5 text-right text-xs text-gray-400 hidden md:table-cell whitespace-nowrap">{fmtDate(call.createdAt)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* Pagination */}
          {total > PAGE_SIZE && (
            <div className="px-5 py-4 border-t border-gray-100 flex items-center justify-between">
              <span className="text-xs text-gray-500">
                Showing {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of {total}
              </span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setPage(p => Math.max(0, p - 1))}
                  disabled={page === 0}
                  className="p-1.5 rounded-lg border border-gray-200 text-gray-500 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
                <span className="text-xs text-gray-600 px-2">{page + 1} / {totalPages}</span>
                <button
                  onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
                  disabled={page >= totalPages - 1}
                  className="p-1.5 rounded-lg border border-gray-200 text-gray-500 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  <ChevronRight className="h-4 w-4" />
                </button>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
