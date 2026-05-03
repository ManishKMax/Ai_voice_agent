import React, { useMemo, useState } from "react";
import { useGetLeads, useGetCalls } from "@workspace/api-client-react";
import { Link } from "wouter";
import { format, formatDistanceToNow } from "date-fns";
import {
  Trophy, ChevronDown, ChevronRight, Phone, Clock,
  TrendingUp, Flame, Bot, User, Minus, RefreshCw,
  MessageSquare, PhoneOff, PhoneCall,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { getGetLeadsQueryKey, getGetCallsQueryKey } from "@workspace/api-client-react";

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { LeadStatusBadge } from "@/components/status-badge";
import { Separator } from "@/components/ui/separator";

// ── Score helpers ─────────────────────────────────────────────────────────────

function scoreColor(score: number): string {
  if (score >= 80) return "bg-emerald-500";
  if (score >= 55) return "bg-amber-400";
  if (score >= 30) return "bg-orange-400";
  return "bg-slate-300";
}

function scoreBg(score: number): string {
  if (score >= 80) return "bg-emerald-50 border-emerald-200";
  if (score >= 55) return "bg-amber-50 border-amber-200";
  if (score >= 30) return "bg-orange-50 border-orange-200";
  return "bg-slate-50 border-slate-200";
}

function scoreLabel(score: number): { text: string; icon: React.ReactNode } {
  if (score >= 80) return { text: "Hot", icon: <Flame className="h-3.5 w-3.5 text-emerald-600" /> };
  if (score >= 55) return { text: "Warm", icon: <TrendingUp className="h-3.5 w-3.5 text-amber-500" /> };
  if (score >= 30) return { text: "Cool", icon: <Minus className="h-3.5 w-3.5 text-orange-400" /> };
  return { text: "Cold", icon: <Minus className="h-3.5 w-3.5 text-slate-400" /> };
}

function rankIcon(rank: number) {
  if (rank === 1) return <span className="text-yellow-500 text-lg font-bold">🥇</span>;
  if (rank === 2) return <span className="text-slate-400 text-lg font-bold">🥈</span>;
  if (rank === 3) return <span className="text-amber-600 text-lg font-bold">🥉</span>;
  return (
    <span className="w-8 h-8 flex items-center justify-center rounded-full bg-muted text-muted-foreground text-sm font-semibold">
      {rank}
    </span>
  );
}

// ── Score ring ─────────────────────────────────────────────────────────────────

function ScoreRing({ score }: { score: number | null }) {
  if (score == null) {
    return (
      <div className="flex items-center justify-center w-14 h-14 rounded-full bg-muted/50 border border-muted">
        <span className="text-xs text-muted-foreground font-medium">N/A</span>
      </div>
    );
  }
  const radius = 22;
  const circumference = 2 * Math.PI * radius;
  const progress = (score / 100) * circumference;
  const color =
    score >= 80 ? "#10b981" : score >= 55 ? "#f59e0b" : score >= 30 ? "#f97316" : "#94a3b8";

  return (
    <div className="relative w-14 h-14">
      <svg className="w-14 h-14 -rotate-90" viewBox="0 0 56 56">
        <circle cx="28" cy="28" r={radius} fill="none" stroke="#e2e8f0" strokeWidth="4" />
        <circle
          cx="28" cy="28" r={radius}
          fill="none"
          stroke={color}
          strokeWidth="4"
          strokeDasharray={`${progress} ${circumference}`}
          strokeLinecap="round"
        />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center">
        <span className="text-xs font-bold text-foreground">{score}</span>
      </div>
    </div>
  );
}

// ── Call timeline row ─────────────────────────────────────────────────────────

interface CallRow {
  id: number;
  leadId: number;
  callStatus: string;
  duration?: number | null;
  interestScore?: number | null;
  answeredBy?: string | null;
  transcript?: string | null;
  createdAt: string;
}

function CallTimeline({ calls }: { calls: CallRow[] }) {
  const sorted = [...calls].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );

  return (
    <div className="mt-3 space-y-2 pl-4 border-l-2 border-muted ml-4">
      {sorted.map((call, idx) => (
        <div key={call.id} className="relative">
          {/* connector dot */}
          <div className="absolute -left-[21px] top-2 w-2.5 h-2.5 rounded-full bg-muted-foreground/30 border-2 border-background" />

          <div className="bg-muted/30 rounded-lg p-3 text-sm">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs text-muted-foreground">#{call.id}</span>
                <CallStatusPill status={call.callStatus} />
                {call.answeredBy === "machine" && (
                  <span className="text-[10px] bg-slate-100 text-slate-500 border border-slate-200 rounded px-1.5 py-0.5 flex items-center gap-1">
                    <Bot className="h-2.5 w-2.5" /> Voicemail
                  </span>
                )}
                {call.answeredBy === "human" && (
                  <span className="text-[10px] bg-blue-50 text-blue-500 border border-blue-200 rounded px-1.5 py-0.5 flex items-center gap-1">
                    <User className="h-2.5 w-2.5" /> Human
                  </span>
                )}
              </div>
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                {call.duration != null && (
                  <span className="flex items-center gap-1">
                    <Clock className="h-3 w-3" />{call.duration}s
                  </span>
                )}
                {call.interestScore != null && (
                  <span
                    className={`flex items-center gap-1 px-1.5 py-0.5 rounded font-medium ${scoreBg(call.interestScore)} border`}
                    title="Interest score for this call"
                  >
                    <TrendingUp className="h-3 w-3" />{call.interestScore}
                  </span>
                )}
                <span title={format(new Date(call.createdAt), "PPpp")}>
                  {formatDistanceToNow(new Date(call.createdAt), { addSuffix: true })}
                </span>
              </div>
            </div>

            {call.transcript && (
              <div className="mt-2 text-xs text-muted-foreground line-clamp-2 bg-muted/50 rounded px-2 py-1.5 font-mono leading-relaxed">
                {call.transcript.split("\n").slice(0, 2).join(" · ")}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function CallStatusPill({ status }: { status: string }) {
  const map: Record<string, string> = {
    completed: "bg-green-100 text-green-700 border-green-200",
    answered: "bg-green-100 text-green-700 border-green-200",
    "no-answer": "bg-red-100 text-red-600 border-red-200",
    failed: "bg-red-100 text-red-600 border-red-200",
    busy: "bg-orange-100 text-orange-600 border-orange-200",
    initiated: "bg-blue-100 text-blue-600 border-blue-200",
    ringing: "bg-blue-100 text-blue-600 border-blue-200",
  };
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded border font-medium ${map[status] ?? "bg-slate-100 text-slate-500 border-slate-200"}`}>
      {status.replace("-", " ")}
    </span>
  );
}

// ── Leaderboard row ───────────────────────────────────────────────────────────

interface LeaderEntry {
  leadId: number;
  name: string;
  phone: string;
  status: string;
  tags: string;
  source: string | null;
  bestScore: number | null;
  callCount: number;
  lastCallAt: string | null;
  calls: CallRow[];
}

function LeaderRow({ entry, rank }: { entry: LeaderEntry; rank: number }) {
  const [expanded, setExpanded] = useState(false);
  const tagList = (entry.tags ?? "").split(",").map(t => t.trim()).filter(Boolean);
  const label = entry.bestScore != null ? scoreLabel(entry.bestScore) : null;

  return (
    <div className={`border rounded-xl overflow-hidden transition-shadow hover:shadow-sm ${entry.bestScore != null && entry.bestScore >= 80 ? "border-emerald-200" : "border-border"}`}>
      {/* Main row */}
      <div
        className={`flex items-center gap-4 p-4 cursor-pointer select-none ${expanded ? "bg-muted/20" : "bg-card"}`}
        onClick={() => setExpanded(v => !v)}
      >
        {/* Rank */}
        <div className="flex-shrink-0 w-10 flex justify-center">
          {rankIcon(rank)}
        </div>

        {/* Score ring */}
        <div className="flex-shrink-0">
          <ScoreRing score={entry.bestScore} />
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <Link
              href={`/leads/${entry.leadId}`}
              onClick={e => e.stopPropagation()}
              className="font-semibold text-sm text-foreground hover:underline"
            >
              {entry.name}
            </Link>
            <LeadStatusBadge status={entry.status} />
            {label && (
              <span className={`flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border font-medium ${scoreBg(entry.bestScore!)}`}>
                {label.icon} {label.text}
              </span>
            )}
          </div>

          <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground flex-wrap">
            <span className="flex items-center gap-1">
              <Phone className="h-3 w-3" />{entry.phone}
            </span>
            {entry.source && (
              <span className="flex items-center gap-1">
                <MessageSquare className="h-3 w-3" />{entry.source}
              </span>
            )}
            <span className="flex items-center gap-1">
              <PhoneCall className="h-3 w-3" />{entry.callCount} call{entry.callCount !== 1 ? "s" : ""}
            </span>
            {entry.lastCallAt && (
              <span className="flex items-center gap-1">
                <Clock className="h-3 w-3" />
                Last: {formatDistanceToNow(new Date(entry.lastCallAt), { addSuffix: true })}
              </span>
            )}
          </div>

          {tagList.length > 0 && (
            <div className="flex gap-1 mt-1.5 flex-wrap">
              {tagList.map(t => (
                <span key={t} className="text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground border">{t}</span>
              ))}
            </div>
          )}
        </div>

        {/* Score bar (desktop) */}
        {entry.bestScore != null && (
          <div className="hidden md:flex flex-col items-end gap-1 flex-shrink-0 w-32">
            <span className="text-xs text-muted-foreground">Interest</span>
            <div className="w-full h-2.5 rounded-full bg-muted overflow-hidden">
              <div
                className={`h-full rounded-full ${scoreColor(entry.bestScore)} transition-all`}
                style={{ width: `${entry.bestScore}%` }}
              />
            </div>
            <span className="text-xs font-bold text-foreground">{entry.bestScore} / 100</span>
          </div>
        )}

        {/* Expand chevron */}
        <div className="flex-shrink-0 text-muted-foreground">
          {entry.calls.length > 0
            ? (expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />)
            : <PhoneOff className="h-4 w-4 opacity-30" />}
        </div>
      </div>

      {/* Expanded call timeline */}
      {expanded && entry.calls.length > 0 && (
        <div className="px-4 pb-4 bg-muted/10 border-t">
          <p className="text-xs font-medium text-muted-foreground pt-3 pb-1 uppercase tracking-wider">
            Call History
          </p>
          <CallTimeline calls={entry.calls} />
        </div>
      )}
    </div>
  );
}

// ── Leaderboard ───────────────────────────────────────────────────────────────

type SortMode = "score" | "calls" | "recent";

export default function Leaderboard() {
  const queryClient = useQueryClient();
  const [sort, setSort] = useState<SortMode>("score");
  const [showAll, setShowAll] = useState(false);

  const { data: leadsData, isLoading: loadingLeads } = useGetLeads({ limit: 200 });
  const { data: callsData, isLoading: loadingCalls } = useGetCalls({ limit: 500 });

  const isLoading = loadingLeads || loadingCalls;

  // Build per-lead call map
  const entries: LeaderEntry[] = useMemo(() => {
    const leads = leadsData?.leads ?? [];
    const calls = (callsData?.calls ?? []) as CallRow[];

    const callsByLead = new Map<number, CallRow[]>();
    for (const c of calls) {
      const arr = callsByLead.get(c.leadId) ?? [];
      arr.push(c);
      callsByLead.set(c.leadId, arr);
    }

    return leads.map(lead => {
      const leadCalls = callsByLead.get(lead.id) ?? [];
      const scored = leadCalls.filter(c => c.interestScore != null);
      const bestScore = scored.length > 0
        ? Math.max(...scored.map(c => c.interestScore!))
        : null;
      const sorted = [...leadCalls].sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );
      return {
        leadId: lead.id,
        name: lead.name,
        phone: lead.phone,
        status: lead.status,
        tags: lead.tags ?? "",
        source: lead.source ?? null,
        bestScore,
        callCount: leadCalls.length,
        lastCallAt: sorted[0]?.createdAt ?? null,
        calls: leadCalls,
      };
    });
  }, [leadsData, callsData]);

  const sorted = useMemo(() => {
    const copy = [...entries];
    if (sort === "score") {
      return copy.sort((a, b) => {
        if (a.bestScore == null && b.bestScore == null) return 0;
        if (a.bestScore == null) return 1;
        if (b.bestScore == null) return -1;
        return b.bestScore - a.bestScore;
      });
    }
    if (sort === "calls") {
      return copy.sort((a, b) => b.callCount - a.callCount);
    }
    // recent
    return copy.sort((a, b) => {
      if (!a.lastCallAt && !b.lastCallAt) return 0;
      if (!a.lastCallAt) return 1;
      if (!b.lastCallAt) return -1;
      return new Date(b.lastCallAt).getTime() - new Date(a.lastCallAt).getTime();
    });
  }, [entries, sort]);

  const visible = showAll ? sorted : sorted.slice(0, 20);

  // Stats summary
  const scoredLeads = entries.filter(e => e.bestScore != null);
  const hotLeads = entries.filter(e => (e.bestScore ?? 0) >= 80).length;
  const avgScore = scoredLeads.length > 0
    ? Math.round(scoredLeads.reduce((s, e) => s + e.bestScore!, 0) / scoredLeads.length)
    : null;

  function refresh() {
    queryClient.invalidateQueries({ queryKey: getGetLeadsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetCallsQueryKey() });
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Trophy className="h-6 w-6 text-amber-500" />
            Interest Leaderboard
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Leads ranked by AI-computed interest score from call analysis
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={refresh}>
          <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
          Refresh
        </Button>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <SummaryCard label="Total Leads" value={entries.length} icon={<User className="h-4 w-4 text-muted-foreground" />} />
        <SummaryCard label="Scored Leads" value={scoredLeads.length} icon={<TrendingUp className="h-4 w-4 text-blue-500" />} />
        <SummaryCard label="Hot Leads" value={hotLeads} icon={<Flame className="h-4 w-4 text-emerald-500" />} accent="emerald" />
        <SummaryCard label="Avg Score" value={avgScore != null ? `${avgScore}` : "—"} icon={<Trophy className="h-4 w-4 text-amber-500" />} />
      </div>

      {/* Sort controls */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs text-muted-foreground font-medium mr-1">Sort by:</span>
        {(["score", "calls", "recent"] as SortMode[]).map(s => (
          <button
            key={s}
            onClick={() => setSort(s)}
            className={`text-xs px-3 py-1.5 rounded-full border font-medium transition-colors ${sort === s ? "bg-primary text-primary-foreground border-primary" : "bg-card text-muted-foreground border-border hover:border-primary/50"}`}
          >
            {s === "score" ? "Interest Score" : s === "calls" ? "Call Count" : "Most Recent"}
          </button>
        ))}
      </div>

      {/* Leaderboard list */}
      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="border rounded-xl p-4 flex items-center gap-4">
              <Skeleton className="h-8 w-8 rounded-full flex-shrink-0" />
              <Skeleton className="h-14 w-14 rounded-full flex-shrink-0" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-48" />
                <Skeleton className="h-3 w-72" />
              </div>
              <Skeleton className="h-8 w-32 hidden md:block" />
            </div>
          ))}
        </div>
      ) : sorted.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16 text-muted-foreground">
            <Trophy className="h-12 w-12 mb-3 opacity-20" />
            <p className="font-medium">No leads yet</p>
            <p className="text-sm mt-1 opacity-70">Add leads and make calls to see the leaderboard</p>
            <Link href="/leads">
              <Button variant="outline" size="sm" className="mt-4">Go to Leads</Button>
            </Link>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="space-y-2">
            {visible.map((entry, i) => (
              <LeaderRow key={entry.leadId} entry={entry} rank={i + 1} />
            ))}
          </div>

          {sorted.length > 20 && (
            <div className="text-center">
              <Button variant="outline" onClick={() => setShowAll(v => !v)}>
                {showAll ? "Show Top 20" : `Show All ${sorted.length} Leads`}
              </Button>
            </div>
          )}

          <p className="text-xs text-center text-muted-foreground">
            Showing {visible.length} of {sorted.length} leads · Scores are computed by the AI after each completed call
          </p>
        </>
      )}
    </div>
  );
}

function SummaryCard({
  label, value, icon, accent,
}: {
  label: string;
  value: string | number;
  icon: React.ReactNode;
  accent?: string;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-medium text-muted-foreground">{label}</span>
          {icon}
        </div>
        <p className={`text-2xl font-bold ${accent === "emerald" ? "text-emerald-600" : "text-foreground"}`}>
          {value}
        </p>
      </CardContent>
    </Card>
  );
}
