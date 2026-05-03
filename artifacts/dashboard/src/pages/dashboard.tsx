import React, { useEffect, useRef, useState } from "react";
import { useGetDashboardStats } from "@workspace/api-client-react";
import { Link } from "wouter";
import { format } from "date-fns";
import { Users, PhoneCall, PhoneForwarded, Clock, ArrowRight, Radio, TrendingUp } from "lucide-react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { LeadStatusBadge, CallStatusBadge } from "@/components/status-badge";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

interface LiveEvent {
  id: string;
  event: string;
  data: Record<string, unknown>;
  ts: number;
}

function useLiveEvents() {
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const token = localStorage.getItem("auth_token");
    const url = `${BASE}/api/sse/events`;
    const es = new EventSource(url);
    esRef.current = es;

    es.addEventListener("connected", () => setConnected(true));

    const handleEvent = (name: string) => (e: MessageEvent) => {
      const data = JSON.parse(e.data) as Record<string, unknown>;
      setEvents((prev) => [
        { id: `${name}-${Date.now()}`, event: name, data, ts: Date.now() },
        ...prev.slice(0, 19),
      ]);
    };

    es.addEventListener("lead.status_changed", handleEvent("lead.status_changed") as EventListener);
    es.addEventListener("lead.created", handleEvent("lead.created") as EventListener);
    es.addEventListener("lead.analyzed", handleEvent("lead.analyzed") as EventListener);

    es.onerror = () => setConnected(false);

    return () => {
      es.close();
      setConnected(false);
    };
  }, []);

  return { events, connected };
}

function eventLabel(event: string, data: Record<string, unknown>): string {
  const name = (data.name as string) ?? `Lead #${data.leadId}`;
  switch (event) {
    case "lead.created": return `New lead added: ${name}`;
    case "lead.status_changed": return `${name} → ${data.status}`;
    case "lead.analyzed": {
      const score = data.interestScore as number;
      return `${name} scored ${score}/100 (${data.newStatus})`;
    }
    default: return event;
  }
}

function eventColor(event: string, data: Record<string, unknown>): string {
  if (event === "lead.created") return "bg-blue-500";
  if (event === "lead.analyzed") {
    const score = (data.interestScore as number) ?? 0;
    if (score >= 70) return "bg-emerald-500";
    if (score >= 40) return "bg-yellow-500";
    return "bg-red-400";
  }
  const status = data.status as string;
  if (status === "interested") return "bg-emerald-500";
  if (status === "calling") return "bg-blue-500";
  if (status === "not_interested" || status === "dnc") return "bg-red-400";
  return "bg-muted-foreground";
}

export default function Dashboard() {
  const { data: stats, isLoading, isError, error } = useGetDashboardStats({
    query: {
      retry: 0,
      staleTime: 10_000,
    },
  } as any);
  const { events, connected } = useLiveEvents();

  if (isLoading) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold tracking-tight">Overview</h1>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {[1, 2, 3, 4].map((i) => (
            <Card key={i}>
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <Skeleton className="h-4 w-[100px]" />
              </CardHeader>
              <CardContent>
                <Skeleton className="h-8 w-[60px]" />
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  if (isError || !stats) {
    const isAuthIssue = String((error as Error | undefined)?.message ?? "").toLowerCase().includes("401") ||
      String((error as Error | undefined)?.message ?? "").toLowerCase().includes("unauthor");

    return (
      <div className="p-8 text-center space-y-3">
        <h2 className="text-xl font-semibold text-destructive">Failed to load dashboard stats</h2>
        <p className="text-muted-foreground">
          {isAuthIssue
            ? "Your session expired. Please sign in again."
            : "Please try again later."}
        </p>
        {isAuthIssue && <Link href="/login" className="text-sm text-primary underline">Go to login</Link>}
      </div>
    );
  }

  const conversionRate = stats.leads.total > 0
    ? Math.round(((stats.leads.byStatus.interested || 0) / stats.leads.total) * 100)
    : 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Overview</h1>
          <span
            className={`flex items-center gap-1.5 text-xs px-2 py-0.5 rounded-full font-medium ${
              connected
                ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
                : "bg-muted text-muted-foreground"
            }`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${connected ? "bg-emerald-500 animate-pulse" : "bg-muted-foreground"}`} />
            {connected ? "Live" : "Offline"}
          </span>
        </div>
        <div className="flex gap-2">
          <Link href="/leads">
            <Button variant="outline" size="sm">Manage Leads</Button>
          </Link>
          <Link href="/calls">
            <Button size="sm">View Call Log</Button>
          </Link>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Leads</CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.leads.total}</div>
            <p className="text-xs text-muted-foreground mt-1">
              {stats.leads.byStatus.pending || 0} pending contact
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Calls</CardTitle>
            <PhoneCall className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.calls.total}</div>
            <p className="text-xs text-muted-foreground mt-1">
              {stats.calls.byStatus.completed || 0} completed
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Interested Leads</CardTitle>
            <PhoneForwarded className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-emerald-600">
              {stats.leads.byStatus.interested || 0}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              Ready for follow up
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Conversion Rate</CardTitle>
            <TrendingUp className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{conversionRate}%</div>
            <p className="text-xs text-muted-foreground mt-1">
              {stats.queue.total} in queue ({stats.queue.pending} ready)
            </p>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-7">
        <Card className="col-span-4">
          <CardHeader className="flex flex-row items-center justify-between">
            <div className="space-y-1">
              <CardTitle>Recent Leads</CardTitle>
              <CardDescription>Latest additions to the system.</CardDescription>
            </div>
            <Link href="/leads">
              <Button variant="ghost" size="sm" className="h-8 text-xs">
                View all <ArrowRight className="ml-2 h-3 w-3" />
              </Button>
            </Link>
          </CardHeader>
          <CardContent>
            {stats.leads.recent.length === 0 ? (
              <div className="py-8 text-center text-sm text-muted-foreground">
                No recent leads found.
              </div>
            ) : (
              <div className="space-y-4">
                {stats.leads.recent.map((lead) => (
                  <div key={lead.id} className="flex items-center justify-between border-b pb-4 last:border-0 last:pb-0">
                    <div className="space-y-1">
                      <Link href={`/leads/${lead.id}`} className="font-medium hover:underline text-sm">
                        {lead.name}
                      </Link>
                      <div className="text-xs text-muted-foreground flex gap-2">
                        <span>{lead.phone}</span>
                        <span>•</span>
                        <span>{format(new Date(lead.createdAt), "MMM d, yyyy")}</span>
                      </div>
                    </div>
                    <LeadStatusBadge status={lead.status} />
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="col-span-3">
          <CardHeader className="flex flex-row items-center justify-between">
            <div className="space-y-1 flex items-center gap-2">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <Radio className="h-4 w-4 text-blue-500" />
                  Live Activity
                </CardTitle>
                <CardDescription>Real-time call & lead events.</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {events.length === 0 ? (
              <div className="py-8 text-center text-sm text-muted-foreground space-y-1">
                <Radio className="h-6 w-6 mx-auto mb-2 text-muted-foreground/50" />
                <p>{connected ? "Watching for events…" : "Connecting to event stream…"}</p>
              </div>
            ) : (
              <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
                {events.map((ev) => (
                  <div key={ev.id} className="flex items-start gap-2.5 text-sm">
                    <span className={`mt-1.5 h-2 w-2 rounded-full flex-shrink-0 ${eventColor(ev.event, ev.data)}`} />
                    <div className="min-w-0">
                      <p className="text-foreground leading-tight">{eventLabel(ev.event, ev.data)}</p>
                      <p className="text-xs text-muted-foreground">{format(new Date(ev.ts), "h:mm:ss a")}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-7">
        <Card className="col-span-4">
          <CardHeader className="flex flex-row items-center justify-between">
            <div className="space-y-1">
              <CardTitle>Recent Calls</CardTitle>
              <CardDescription>Latest outbound activity.</CardDescription>
            </div>
            <Link href="/calls">
              <Button variant="ghost" size="sm" className="h-8 text-xs">
                View all <ArrowRight className="ml-2 h-3 w-3" />
              </Button>
            </Link>
          </CardHeader>
          <CardContent>
            {stats.calls.recent.length === 0 ? (
              <div className="py-8 text-center text-sm text-muted-foreground">
                No recent calls found.
              </div>
            ) : (
              <div className="space-y-4">
                {stats.calls.recent.map((call) => (
                  <div key={call.id} className="flex items-center justify-between border-b pb-4 last:border-0 last:pb-0">
                    <div className="space-y-1">
                      <p className="font-medium text-sm flex items-center gap-2">
                        Call #{call.id}
                        {call.duration ? <span className="text-xs font-normal text-muted-foreground">({call.duration}s)</span> : null}
                      </p>
                      <div className="text-xs text-muted-foreground">
                        {format(new Date(call.createdAt), "MMM d, h:mm a")}
                      </div>
                    </div>
                    <CallStatusBadge status={call.callStatus} />
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="col-span-3">
          <CardHeader>
            <CardTitle>Lead Status Breakdown</CardTitle>
            <CardDescription>Distribution across all statuses.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {Object.entries(stats.leads.byStatus)
                .filter(([, count]) => (count as number) > 0)
                .sort(([, a], [, b]) => (b as number) - (a as number))
                .map(([status, count]) => {
                  const pct = stats.leads.total > 0
                    ? Math.round(((count as number) / stats.leads.total) * 100)
                    : 0;
                  const colorMap: Record<string, string> = {
                    interested: "bg-emerald-500",
                    pending: "bg-blue-500",
                    calling: "bg-yellow-500",
                    completed: "bg-gray-400",
                    not_interested: "bg-red-400",
                    no_response: "bg-orange-400",
                    callback: "bg-purple-500",
                    dnc: "bg-red-600",
                  };
                  return (
                    <div key={status} className="space-y-1">
                      <div className="flex justify-between text-xs">
                        <span className="capitalize text-muted-foreground">status.replace("_", " ")</span>
                        <span className="font-medium">{count as number}</span>
                      </div>
                      <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all ${colorMap[status] ?? "bg-muted-foreground"}`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
