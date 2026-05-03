import React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  TrendingUp,
  PhoneCall,
  Users,
  Clock,
  ThumbsUp,
  ThumbsDown,
  Minus,
  RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  LineChart,
  Line,
} from "recharts";

const API = "/api";
const getToken = () => localStorage.getItem("auth_token");

async function apiFetch(path: string) {
  const res = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${getToken()}` },
  });
  if (!res.ok) throw new Error("Failed to fetch");
  return res.json();
}

const fmtMins = (mins: number) =>
  mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`;

export default function ReportsPage() {
  const { data, isLoading, refetch } = useQuery({
    queryKey: ["reports-overview"],
    queryFn: () => apiFetch("/reports/overview"),
    refetchInterval: 60_000,
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64 text-muted-foreground">
        Loading reports...
      </div>
    );
  }

  const leads = data?.leads ?? {};
  const calls = data?.calls ?? {};
  const monthly: any[] = data?.monthly ?? [];
  const tenants = data?.tenants ?? {};

  const statCards = [
    {
      label: "Total Leads",
      value: leads.total ?? 0,
      icon: <Users className="h-5 w-5 text-blue-600" />,
      color: "text-blue-600",
    },
    {
      label: "Conversion Rate",
      value: `${leads.conversionRate ?? 0}%`,
      icon: <TrendingUp className="h-5 w-5 text-green-600" />,
      color: "text-green-600",
      sub: `${leads.interestedCount ?? 0} interested of ${(leads.interestedCount ?? 0) + (leads.notInterestedCount ?? 0) + (leads.noResponseCount ?? 0)} contacted`,
    },
    {
      label: "Total Calls",
      value: calls.total ?? 0,
      icon: <PhoneCall className="h-5 w-5 text-purple-600" />,
      color: "text-purple-600",
      sub: `${calls.completed ?? 0} completed`,
    },
    {
      label: "Minutes Used",
      value: fmtMins(calls.totalMinutesBilled ?? 0),
      icon: <Clock className="h-5 w-5 text-orange-600" />,
      color: "text-orange-600",
    },
    {
      label: "Interested",
      value: leads.interestedCount ?? 0,
      icon: <ThumbsUp className="h-5 w-5 text-emerald-600" />,
      color: "text-emerald-600",
    },
    {
      label: "Not Interested",
      value: leads.notInterestedCount ?? 0,
      icon: <ThumbsDown className="h-5 w-5 text-red-600" />,
      color: "text-red-600",
    },
    {
      label: "No Response",
      value: leads.noResponseCount ?? 0,
      icon: <Minus className="h-5 w-5 text-gray-500" />,
      color: "text-gray-500",
    },
    {
      label: "Active Tenants",
      value: tenants.total ?? 0,
      icon: <Users className="h-5 w-5 text-indigo-600" />,
      color: "text-indigo-600",
      sub: `${tenants.activeSubscriptions ?? 0} with active plan`,
    },
  ];

  const outcomeData = [
    { name: "Interested", value: calls.byOutcome?.INTERESTED ?? leads.interestedCount ?? 0, fill: "#10b981" },
    { name: "Not Interested", value: calls.byOutcome?.NOT_INTERESTED ?? leads.notInterestedCount ?? 0, fill: "#ef4444" },
    { name: "No Response", value: calls.byOutcome?.NO_RESPONSE ?? leads.noResponseCount ?? 0, fill: "#6b7280" },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Reports</h1>
          <p className="text-muted-foreground text-sm mt-1">Campaign performance, conversion rates, and usage analytics</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => refetch()}>
          <RefreshCw className="h-4 w-4 mr-2" /> Refresh
        </Button>
      </div>

      {/* Stat Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {statCards.map((s) => (
          <div key={s.label} className="rounded-lg border bg-card p-4 space-y-1">
            <div className="flex items-center justify-between">
              <p className="text-xs text-muted-foreground">{s.label}</p>
              {s.icon}
            </div>
            <p className={`text-2xl font-bold ${s.color}`}>{s.value}</p>
            {s.sub && <p className="text-xs text-muted-foreground">{s.sub}</p>}
          </div>
        ))}
      </div>

      {/* Monthly Call Volume Chart */}
      {monthly.length > 0 && (
        <div className="rounded-lg border bg-card p-6 space-y-4">
          <h2 className="text-base font-semibold">Monthly Activity (Last 6 Months)</h2>
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={monthly} margin={{ top: 4, right: 16, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
              <XAxis dataKey="label" tick={{ fontSize: 12 }} />
              <YAxis tick={{ fontSize: 12 }} />
              <Tooltip />
              <Legend />
              <Bar dataKey="calls" name="Total Calls" fill="#6366f1" radius={[3, 3, 0, 0]} />
              <Bar dataKey="completedCalls" name="Completed" fill="#10b981" radius={[3, 3, 0, 0]} />
              <Bar dataKey="interestedLeads" name="Interested" fill="#f59e0b" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Minutes Usage Line Chart */}
      {monthly.length > 0 && (
        <div className="rounded-lg border bg-card p-6 space-y-4">
          <h2 className="text-base font-semibold">Minutes Usage Trend</h2>
          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={monthly} margin={{ top: 4, right: 16, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
              <XAxis dataKey="label" tick={{ fontSize: 12 }} />
              <YAxis tick={{ fontSize: 12 }} />
              <Tooltip formatter={(v) => [`${v} min`, "Minutes"]} />
              <Line type="monotone" dataKey="totalMinutes" name="Minutes Used" stroke="#f59e0b" strokeWidth={2} dot />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Outcome Breakdown */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="rounded-lg border bg-card p-6 space-y-4">
          <h2 className="text-base font-semibold">Call Outcomes</h2>
          <div className="space-y-3">
            {outcomeData.map((o) => {
              const total = outcomeData.reduce((s, x) => s + x.value, 0);
              const pct = total > 0 ? Math.round((o.value / total) * 100) : 0;
              return (
                <div key={o.name} className="space-y-1">
                  <div className="flex justify-between text-sm">
                    <span>{o.name}</span>
                    <span className="font-medium">{o.value} ({pct}%)</span>
                  </div>
                  <div className="h-2 rounded-full bg-muted overflow-hidden">
                    <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, backgroundColor: o.fill }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="rounded-lg border bg-card p-6 space-y-4">
          <h2 className="text-base font-semibold">Lead Status Breakdown</h2>
          <div className="space-y-2">
            {Object.entries(leads.byStatus ?? {}).map(([status, count]: [string, any]) => (
              <div key={status} className="flex items-center justify-between text-sm">
                <span className="capitalize text-muted-foreground">{status.replace(/_/g, " ")}</span>
                <span className="font-medium tabular-nums">{count}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
