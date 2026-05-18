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

interface LatencyBucket {
  bucket: string;
  provider_id: string;
  turn_count: number;
  [key: string]: number | string;
}

const LATENCY_METRICS: { key: string; label: string; unit: string }[] = [
  { key: "total_roundtrip_ms",   label: "Total roundtrip",  unit: "ms" },
  { key: "stt_latency_ms",       label: "STT latency",      unit: "ms" },
  { key: "llm_latency_ms",       label: "LLM latency",      unit: "ms" },
  { key: "llm_first_token_ms",   label: "LLM first token",  unit: "ms" },
  { key: "first_word_trigger_ms",label: "First word trigger", unit: "ms" },
  { key: "tts_stream_start_ms",  label: "TTS stream start", unit: "ms" },
  { key: "first_playback_ms",    label: "First playback",   unit: "ms" },
  { key: "tts_complete_ms",      label: "TTS complete",     unit: "ms" },
  { key: "tts_latency_ms",       label: "TTS latency",      unit: "ms" },
];

const PROVIDER_COLORS: Record<string, string> = {
  sarvam: "#6366f1",
  groq:   "#10b981",
  openai: "#f59e0b",
  gemini: "#ef4444",
};

function LatencyWidget() {
  const [providerFilter, setProviderFilter] = React.useState<string>("");
  const [groupBy, setGroupBy] = React.useState<"day" | "hour">("day");
  const [rangeDays, setRangeDays] = React.useState<number>(14);
  const [percentile, setPercentile] = React.useState<"p50" | "p95" | "p99">("p50");
  const fromIso = React.useMemo(
    () => new Date(Date.now() - rangeDays * 24 * 60 * 60 * 1000).toISOString(),
    [rangeDays],
  );
  const { data, isLoading } = useQuery({
    queryKey: ["reports-latency", providerFilter, groupBy, rangeDays],
    queryFn: () => {
      const qs = new URLSearchParams({ groupBy, from: fromIso });
      if (providerFilter) qs.set("providerId", providerFilter);
      return apiFetch(`/reports/latency?${qs.toString()}`);
    },
    refetchInterval: 60_000,
  });

  const buckets: LatencyBucket[] = data?.buckets ?? [];

  // Pivot per metric: one chart with one line per provider.
  const providers = Array.from(new Set(buckets.map((b) => b.provider_id))).sort();

  return (
    <div className="rounded-lg border bg-card p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold">Voice Latency Trends</h2>
          <p className="text-xs text-muted-foreground mt-1">
            Per-stage round-trip latency, color-coded by LLM provider.
          </p>
        </div>
        <div className="flex gap-2">
          <select className="text-xs border rounded px-2 py-1 bg-background"
            value={percentile} onChange={(e) => setPercentile(e.target.value as "p50" | "p95" | "p99")}>
            <option value="p50">p50</option>
            <option value="p95">p95</option>
            <option value="p99">p99</option>
          </select>
          <select className="text-xs border rounded px-2 py-1 bg-background"
            value={groupBy} onChange={(e) => setGroupBy(e.target.value as "day" | "hour")}>
            <option value="day">by day</option>
            <option value="hour">by hour</option>
          </select>
          <select className="text-xs border rounded px-2 py-1 bg-background"
            value={rangeDays} onChange={(e) => setRangeDays(parseInt(e.target.value, 10))}>
            <option value={1}>last 24h</option>
            <option value={7}>last 7d</option>
            <option value={14}>last 14d</option>
            <option value={30}>last 30d</option>
          </select>
          <select className="text-xs border rounded px-2 py-1 bg-background"
            value={providerFilter} onChange={(e) => setProviderFilter(e.target.value)}>
            <option value="">All providers</option>
            <option value="sarvam">Sarvam</option>
            <option value="groq">Groq</option>
            <option value="openai">OpenAI</option>
            <option value="gemini">Gemini</option>
          </select>
        </div>
      </div>
      {isLoading ? (
        <div className="text-xs text-muted-foreground py-8 text-center">Loading latency data...</div>
      ) : buckets.length === 0 ? (
        <div className="text-xs text-muted-foreground py-8 text-center">
          No turn metrics yet. Run a live call to populate this widget.
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {LATENCY_METRICS.map((m) => {
            // Build time-series: one row per bucket, one column per provider.
            const byBucket = new Map<string, Record<string, number | string>>();
            for (const b of buckets) {
              const key = String(b.bucket);
              if (!byBucket.has(key)) byBucket.set(key, { bucket: key });
              const row = byBucket.get(key)!;
              const v = b[`${m.key}_${percentile}`];
              if (v != null) row[b.provider_id] = Math.round(Number(v));
            }
            const series = Array.from(byBucket.values()).sort((a, b) =>
              String(a["bucket"]).localeCompare(String(b["bucket"])),
            );
            return (
              <div key={m.key} className="border rounded p-3 space-y-1">
                <p className="text-xs font-medium">{m.label} <span className="text-muted-foreground font-normal">{percentile}</span></p>
                <ResponsiveContainer width="100%" height={120}>
                  <LineChart data={series} margin={{ top: 4, right: 4, bottom: 0, left: -20 }}>
                    <XAxis dataKey="bucket" tick={{ fontSize: 9 }} tickFormatter={(v) => String(v).slice(5, 10)} />
                    <YAxis tick={{ fontSize: 9 }} unit={m.unit} />
                    <Tooltip formatter={(v) => `${v} ${m.unit}`} />
                    {providers.map((p) => (
                      <Line
                        key={p}
                        type="monotone"
                        dataKey={p}
                        stroke={PROVIDER_COLORS[p] ?? "#888"}
                        strokeWidth={1.5}
                        dot={false}
                        connectNulls
                      />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

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

      <LatencyWidget />

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
