import { useState, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { useClerk } from "@clerk/react";
import {
  ArrowLeft, PhoneCall, Clock, IndianRupee, BarChart3,
  CheckCircle, PhoneMissed, PhoneOff, LogOut, AlertTriangle,
  TrendingUp, ChevronLeft, ChevronRight, Download, Calendar, FileText, Phone,
} from "lucide-react";
import { useCallStatusSSE } from "@/hooks/useCallStatusSSE";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

async function parseJsonOrThrow(res: Response) {
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    throw new Error("Your session expired. Please sign in again.");
  }
  return res.json().catch(() => {
    throw new Error("Unexpected response from server");
  });
}

async function fetchUsage(offset: number, limit: number) {
  const res = await fetch(`${basePath}/api/portal/usage?offset=${offset}&limit=${limit}`, {
    credentials: "include",
  });
  if (!res.ok) throw new Error("Failed to fetch usage data");
  return parseJsonOrThrow(res);
}

async function fetchUsageMonths() {
  const res = await fetch(`${basePath}/api/portal/usage/months`, { credentials: "include" });
  if (!res.ok) throw new Error("Failed to fetch months");
  return parseJsonOrThrow(res);
}

async function fetchInvoice(year: number, month: number) {
  const res = await fetch(`${basePath}/api/portal/usage/invoice?year=${year}&month=${month}`, {
    credentials: "include",
  });
  if (!res.ok) throw new Error("Failed to fetch invoice data");
  return parseJsonOrThrow(res);
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
  const queryClient = useQueryClient();
  const [page, setPage] = useState(0);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [selectedMonth, setSelectedMonth] = useState("");
  const [isExporting, setIsExporting] = useState(false);
  const [exportError, setExportError] = useState("");

  const [isLive, setIsLive] = useState(false);
  const [activeCall, setActiveCall] = useState<{ leadName: string; phone: string } | null>(null);
  const [justRefreshed, setJustRefreshed] = useState(false);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useCallStatusSSE(
    (type, data: any) => {
      if (type === "call.started") {
        setActiveCall({ leadName: data.leadName ?? "Unknown", phone: data.phone ?? "" });
      } else if (type === "call.ended" || type === "call.status") {
        setActiveCall(null);
        queryClient.invalidateQueries({ queryKey: ["portal-usage"] });
        queryClient.invalidateQueries({ queryKey: ["portal-usage-months"] });
        setJustRefreshed(true);
        if (flashTimer.current) clearTimeout(flashTimer.current);
        flashTimer.current = setTimeout(() => setJustRefreshed(false), 3500);
      }
    },
    () => setIsLive(true),
    () => setIsLive(false),
  );

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
      {/* ...rest unchanged... */}
    </div>
  );
}
