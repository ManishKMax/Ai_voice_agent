import React, { useEffect, useRef, useState } from "react";
import { Phone, Bot, User, Activity, PhoneOff, Clock, Loader2, Radio } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";

// ── Types ─────────────────────────────────────────────────────────────────────

interface CallTurn {
  turn: number;
  userText: string;
  agentText: string;
  ts: number;
}

interface ActiveCall {
  callSid: string;
  leadId: number;
  leadName: string;
  phone: string;
  startedAt: number;
  turn: number;
  lastAgentText: string;
  turns: CallTurn[];
  status: "active" | "ending";
}

interface RecentCall {
  callSid: string;
  leadId: number;
  leadName: string;
  turns: number;
  endedAt: number;
}

// ── Elapsed timer ─────────────────────────────────────────────────────────────

function useElapsed(startedAt: number) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => clearInterval(id);
  }, [startedAt]);
  const m = Math.floor(elapsed / 60).toString().padStart(2, "0");
  const s = (elapsed % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

// ── Single active call card ───────────────────────────────────────────────────

function ActiveCallCard({ call }: { call: ActiveCall }) {
  const elapsed = useElapsed(call.startedAt);

  return (
    <Card className="border-green-200 bg-green-50/40 shadow-sm">
      <CardHeader className="pb-3 pt-4 px-4">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="relative flex-shrink-0">
              <div className="h-9 w-9 rounded-full bg-green-100 flex items-center justify-center">
                <Phone className="h-4 w-4 text-green-600" />
              </div>
              <span className="absolute -top-0.5 -right-0.5 flex h-3 w-3">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-3 w-3 bg-green-500" />
              </span>
            </div>
            <div className="min-w-0">
              <p className="font-semibold text-sm leading-tight truncate">{call.leadName}</p>
              <p className="text-xs text-muted-foreground">{call.phone}</p>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <Badge variant="outline" className="text-[10px] border-green-300 text-green-700 bg-white gap-1">
              <Clock className="h-2.5 w-2.5" />
              {elapsed}
            </Badge>
            <Badge variant="outline" className="text-[10px] border-blue-200 text-blue-700 bg-white">
              Turn {call.turn}
            </Badge>
          </div>
        </div>
      </CardHeader>

      <CardContent className="px-4 pb-4 space-y-2">
        {/* Conversation so far */}
        <ScrollArea className="max-h-48 pr-1">
          <div className="space-y-2">
            {call.turns.map((t) => (
              <React.Fragment key={t.turn}>
                {t.userText && (
                  <div className="flex gap-2 justify-end">
                    <div className="bg-white border rounded-xl px-3 py-1.5 text-xs max-w-[80%] text-right shadow-sm">
                      <p className="text-[10px] font-medium text-muted-foreground mb-0.5">Lead</p>
                      <p>{t.userText.replace(/^\[pressed /, "pressed key ").replace(/\]$/, "")}</p>
                    </div>
                    <div className="h-6 w-6 rounded-full bg-slate-100 flex items-center justify-center flex-shrink-0 mt-0.5">
                      <User className="h-3 w-3 text-slate-500" />
                    </div>
                  </div>
                )}
                <div className="flex gap-2">
                  <div className="h-6 w-6 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0 mt-0.5">
                    <Bot className="h-3 w-3 text-primary" />
                  </div>
                  <div className="bg-white border rounded-xl px-3 py-1.5 text-xs max-w-[80%] shadow-sm">
                    <p className="text-[10px] font-medium text-muted-foreground mb-0.5">Agent</p>
                    <p>{t.agentText}</p>
                  </div>
                </div>
              </React.Fragment>
            ))}
          </div>
        </ScrollArea>

        {/* Typing indicator while waiting for next response */}
        {call.status === "active" && (
          <div className="flex gap-2 items-center pt-1">
            <div className="h-6 w-6 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
              <Bot className="h-3 w-3 text-primary" />
            </div>
            <div className="bg-white border rounded-xl px-3 py-2 flex gap-1 shadow-sm">
              <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground animate-bounce [animation-delay:0ms]" />
              <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground animate-bounce [animation-delay:150ms]" />
              <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground animate-bounce [animation-delay:300ms]" />
            </div>
          </div>
        )}

        {call.status === "ending" && (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground pt-1">
            <Loader2 className="h-3 w-3 animate-spin" />
            Analysing transcript…
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Recent ended call row ─────────────────────────────────────────────────────

function RecentCallRow({ call }: { call: RecentCall }) {
  const ago = Math.floor((Date.now() - call.endedAt) / 1000);
  const label = ago < 60 ? `${ago}s ago` : `${Math.floor(ago / 60)}m ago`;
  return (
    <div className="flex items-center justify-between py-2.5 px-3 rounded-lg hover:bg-muted/40 transition-colors">
      <div className="flex items-center gap-2.5">
        <div className="h-7 w-7 rounded-full bg-slate-100 flex items-center justify-center">
          <PhoneOff className="h-3.5 w-3.5 text-slate-500" />
        </div>
        <div>
          <p className="text-sm font-medium leading-tight">{call.leadName}</p>
          <p className="text-xs text-muted-foreground">{call.turns} turns · {label}</p>
        </div>
      </div>
      <Badge variant="secondary" className="text-[10px]">Ended</Badge>
    </div>
  );
}

// ── SSE hook ─────────────────────────────────────────────────────────────────

function useLiveCallMonitor() {
  const [activeCalls, setActiveCalls] = useState<Map<string, ActiveCall>>(new Map());
  const [recentCalls, setRecentCalls] = useState<RecentCall[]>([]);
  const [connected, setConnected] = useState(false);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const token = localStorage.getItem("auth_token");
    const base = import.meta.env.BASE_URL.replace(/\/$/, "");
    const url = `${base}/api/sse/events${token ? `?token=${encodeURIComponent(token)}` : ""}`;

    function connect() {
      const es = new EventSource(url);
      esRef.current = es;

      es.addEventListener("connected", () => setConnected(true));

      es.addEventListener("call.started", (e) => {
        const d = JSON.parse(e.data) as {
          callSid: string; leadId: number; leadName: string;
          phone: string; agentText: string; startedAt: number;
        };
        setActiveCalls((prev) => {
          const next = new Map(prev);
          next.set(d.callSid, {
            callSid: d.callSid,
            leadId: d.leadId,
            leadName: d.leadName,
            phone: d.phone,
            startedAt: d.startedAt,
            turn: 0,
            lastAgentText: d.agentText,
            turns: [{ turn: 0, userText: "", agentText: d.agentText, ts: Date.now() }],
            status: "active",
          });
          return next;
        });
      });

      es.addEventListener("call.turn", (e) => {
        const d = JSON.parse(e.data) as {
          callSid: string; turn: number; userText: string;
          agentText: string; leadName: string; isEnd: boolean;
        };
        setActiveCalls((prev) => {
          const call = prev.get(d.callSid);
          if (!call) return prev;
          const next = new Map(prev);
          next.set(d.callSid, {
            ...call,
            turn: d.turn,
            lastAgentText: d.agentText,
            turns: [...call.turns, { turn: d.turn, userText: d.userText, agentText: d.agentText, ts: Date.now() }],
            status: d.isEnd ? "ending" : "active",
          });
          return next;
        });
      });

      es.addEventListener("call.ended", (e) => {
        const d = JSON.parse(e.data) as {
          callSid: string; leadId: number; leadName: string; turns: number; endedAt: number;
        };
        setActiveCalls((prev) => {
          const next = new Map(prev);
          next.delete(d.callSid);
          return next;
        });
        setRecentCalls((prev) => [
          { callSid: d.callSid, leadId: d.leadId, leadName: d.leadName, turns: d.turns, endedAt: d.endedAt },
          ...prev.slice(0, 9),
        ]);
      });

      es.onerror = () => {
        setConnected(false);
        es.close();
        setTimeout(connect, 3000);
      };
    }

    connect();
    return () => {
      esRef.current?.close();
    };
  }, []);

  return { activeCalls, recentCalls, connected };
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function Monitor() {
  const { activeCalls, recentCalls, connected } = useLiveCallMonitor();
  const activeList = Array.from(activeCalls.values());

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Live Call Monitor</h1>
          <p className="text-muted-foreground text-sm mt-0.5">
            Watch AI conversations as they happen in real time
          </p>
        </div>
        <div className="flex items-center gap-2 text-sm">
          {connected ? (
            <>
              <span className="flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-2 w-2 rounded-full bg-green-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
              </span>
              <span className="text-green-600 font-medium">Live</span>
            </>
          ) : (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
              <span className="text-muted-foreground">Connecting…</span>
            </>
          )}
        </div>
      </div>

      {/* Stats strip */}
      <div className="grid grid-cols-3 gap-4">
        <Card className="p-4">
          <p className="text-xs text-muted-foreground uppercase tracking-wide">Active Now</p>
          <p className="text-3xl font-bold mt-1 text-green-600">{activeList.length}</p>
        </Card>
        <Card className="p-4">
          <p className="text-xs text-muted-foreground uppercase tracking-wide">Completed Today</p>
          <p className="text-3xl font-bold mt-1">{recentCalls.length}</p>
        </Card>
        <Card className="p-4">
          <p className="text-xs text-muted-foreground uppercase tracking-wide">Avg Turns</p>
          <p className="text-3xl font-bold mt-1">
            {recentCalls.length > 0
              ? (recentCalls.reduce((s, c) => s + c.turns, 0) / recentCalls.length).toFixed(1)
              : "—"}
          </p>
        </Card>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        {/* Active calls */}
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Radio className="h-4 w-4 text-green-500" />
            <h2 className="font-semibold text-sm">Active Calls</h2>
            {activeList.length > 0 && (
              <Badge className="bg-green-500 text-white text-[10px] h-4 px-1.5">{activeList.length}</Badge>
            )}
          </div>

          {activeList.length === 0 ? (
            <Card className="border-dashed">
              <CardContent className="flex flex-col items-center justify-center py-12 text-center">
                <Phone className="h-8 w-8 text-muted-foreground/40 mb-3" />
                <p className="text-sm font-medium text-muted-foreground">No active calls</p>
                <p className="text-xs text-muted-foreground/60 mt-1">
                  When a call starts, it will appear here live
                </p>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-3">
              {activeList.map((call) => (
                <ActiveCallCard key={call.callSid} call={call} />
              ))}
            </div>
          )}
        </div>

        {/* Recent completed */}
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Activity className="h-4 w-4 text-muted-foreground" />
            <h2 className="font-semibold text-sm">Recently Ended</h2>
          </div>

          <Card>
            {recentCalls.length === 0 ? (
              <CardContent className="flex flex-col items-center justify-center py-12 text-center">
                <PhoneOff className="h-8 w-8 text-muted-foreground/40 mb-3" />
                <p className="text-sm font-medium text-muted-foreground">No completed calls yet</p>
                <p className="text-xs text-muted-foreground/60 mt-1">
                  Calls that finish will appear here
                </p>
              </CardContent>
            ) : (
              <CardContent className="p-2 divide-y">
                {recentCalls.map((call) => (
                  <RecentCallRow key={call.callSid} call={call} />
                ))}
              </CardContent>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
