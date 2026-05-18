import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Room, RoomEvent, Track, type RemoteTrack, type RemoteParticipant, type RemoteTrackPublication } from "livekit-client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Mic, MicOff, PhoneCall, PhoneOff, Pause, Play } from "lucide-react";

/**
 * Task #31 — In-browser Call Simulator.
 *
 * Reuses the production CallSession code path via the Phase-1 LiveKit
 * transport. The browser publishes its mic; the in-process agent worker
 * joins the same room, runs CallSession over the WebRTC tracks, and
 * streams its TTS back. SSE on `/api/simulator/:callId/stream` carries
 * live transcript + 13 per-stage metrics + every `call_session_*` log.
 */

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

async function apiFetch(path: string, options?: RequestInit) {
  const token = localStorage.getItem("auth_token");
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options?.headers ?? {}),
    },
  });
  return res.json();
}

const LLM_PROVIDERS = [
  { id: "sarvam", label: "Sarvam-M (default)" },
  { id: "groq", label: "Groq Llama-3.3-70B" },
  { id: "openai", label: "OpenAI GPT-4o-mini" },
  { id: "gemini", label: "Gemini 2.0 Flash" },
] as const;

// Common Sarvam Bulbul-v3 speakers (the full list lives in replit.md).
// "default" means "no per-call override — use platform setting".
const VOICE_OPTIONS = [
  { id: "default", label: "Use platform default" },
  { id: "priya", label: "Priya (en-IN, female)" },
  { id: "neha", label: "Neha (en-IN, female)" },
  { id: "kavya", label: "Kavya (en-IN, female)" },
  { id: "rohan", label: "Rohan (en-IN, male)" },
  { id: "shubh", label: "Shubh (en-IN, male)" },
  { id: "amit", label: "Amit (en-IN, male)" },
] as const;

const LANGUAGE_OPTIONS = [
  { id: "default", label: "Use platform default" },
  { id: "en-IN", label: "English (India)" },
  { id: "hi-IN", label: "Hindi" },
  { id: "te-IN", label: "Telugu" },
  { id: "ta-IN", label: "Tamil" },
  { id: "kn-IN", label: "Kannada" },
  { id: "mr-IN", label: "Marathi" },
  { id: "bn-IN", label: "Bengali" },
] as const;

// 13 metric fields, label + warn/error thresholds (ms). Thresholds match
// the operator playbook in REPLIT.md ("acceptable: <800ms STT, <500ms LLM
// first token", etc); deviating from these requires updating both files.
interface MetricSpec {
  key: string;
  label: string;
  warn?: number;
  error?: number;
  unit?: string;
  digits?: number;
}
const METRIC_SPECS: MetricSpec[] = [
  { key: "sttLatencyMs",        label: "STT latency",       warn:  800, error: 1500 },
  { key: "llmFirstTokenMs",     label: "LLM first token",   warn:  500, error: 1200 },
  { key: "llmTokensPerSec",     label: "LLM tok/s",         unit: "t/s", digits: 1 },
  { key: "firstWordTriggerMs",  label: "First-word trigger",warn:  150, error:  400 },
  { key: "ttsStreamStartMs",    label: "TTS stream start",  warn:  500, error: 1500 },
  { key: "firstPlaybackMs",     label: "First playback",    warn:  100, error:  300 },
  { key: "firstAudioChunkMs",   label: "First audio chunk", warn: 1500, error: 3000 },
  { key: "ttsCompleteMs",       label: "TTS complete",      warn: 3000, error: 6000 },
  { key: "llmLatencyMs",        label: "LLM total",         warn: 1500, error: 3000 },
  { key: "ttsLatencyMs",        label: "TTS total",         warn: 3000, error: 6000 },
  { key: "totalRoundtripMs",    label: "Total roundtrip",   warn: 2000, error: 4000 },
  { key: "livekitTransportMs",  label: "LK transport",      warn:  150, error:  400 },
  // ttsPlaybackStartAt is a timestamp, render as wall-clock
  { key: "ttsPlaybackStartAt",  label: "TTS playback @",    unit: "" },
];

interface MetricRow extends Record<string, unknown> {
  turnId: number;
}

interface TranscriptTurn {
  turn: number;
  userText: string;
  agentText: string;
  /** ISO timestamps captured server-side for each side of the turn. */
  userAt?: string;
  agentAt?: string;
}

interface LogEntry {
  ts: number;
  level: string;
  event: string | null;
  body: Record<string, unknown>;
}

interface SessionInfo {
  callId: number;
  callSid: string;
  leadId: number;
  roomName: string;
}

function median(values: number[]): number | null {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid]! : (xs[mid - 1]! + xs[mid]!) / 2;
}

function metricColorClass(value: number | null, spec: MetricSpec): string {
  if (value == null) return "text-muted-foreground";
  if (spec.error != null && value >= spec.error) return "text-red-500 font-semibold";
  if (spec.warn != null && value >= spec.warn) return "text-amber-500 font-medium";
  return "text-emerald-500";
}

function formatMetric(value: unknown, spec: MetricSpec): string {
  if (value == null) return "—";
  if (spec.key === "ttsPlaybackStartAt") {
    try {
      const d = new Date(value as string);
      return d.toLocaleTimeString();
    } catch {
      return String(value);
    }
  }
  if (typeof value === "number") {
    return spec.digits != null ? value.toFixed(spec.digits) : Math.round(value).toString();
  }
  return String(value);
}

export default function SimulatorPage() {
  const [leadName, setLeadName] = useState("Test Lead");
  const [leadPhone, setLeadPhone] = useState("+910000000000");
  const [llmProvider, setLlmProvider] = useState<string>("sarvam");
  const [voice, setVoice] = useState<string>("default");
  const [language, setLanguage] = useState<string>("default");

  const [starting, setStarting] = useState(false);
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [connected, setConnected] = useState(false);
  const [micMuted, setMicMuted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [transcript, setTranscript] = useState<TranscriptTurn[]>([]);
  const [currentMetrics, setCurrentMetrics] = useState<MetricRow | null>(null);
  const [allMetrics, setAllMetrics] = useState<MetricRow[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [logSearch, setLogSearch] = useState("");
  const [logPaused, setLogPaused] = useState(false);

  const roomRef = useRef<Room | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const sseRef = useRef<EventSource | null>(null);
  const logsHostRef = useRef<HTMLDivElement | null>(null);

  // Auto-scroll log tail unless the user is hovering (paused) or has
  // explicitly toggled pause.
  useEffect(() => {
    if (logPaused) return;
    const host = logsHostRef.current;
    if (!host) return;
    host.scrollTop = host.scrollHeight;
  }, [logs, logPaused]);

  const teardown = useCallback(async () => {
    try { sseRef.current?.close(); } catch { /* ignore */ }
    sseRef.current = null;
    try { await roomRef.current?.disconnect(); } catch { /* ignore */ }
    roomRef.current = null;
    setConnected(false);
  }, []);

  const handleEnd = useCallback(async () => {
    if (!session) return;
    const callId = session.callId;
    await teardown();
    try {
      await apiFetch(`/api/simulator/${callId}/end`, { method: "POST" });
    } catch {
      // best-effort
    }
    setSession(null);
  }, [session, teardown]);

  // Beforeunload safety net so a closed tab tears down the agent worker.
  useEffect(() => {
    if (!session) return;
    const handler = () => {
      // navigator.sendBeacon avoids the request being aborted on unload.
      try {
        const token = localStorage.getItem("auth_token");
        const url = `${BASE}/api/simulator/${session.callId}/end`;
        // Beacons can't set custom headers; the SSE auth pattern accepts
        // `?token=` so we mirror that here for the end endpoint. If your
        // middleware ignores the param on POST, the in-process room
        // teardown still fires when LiveKit notices the peer is gone.
        const blob = new Blob([JSON.stringify({})], { type: "application/json" });
        navigator.sendBeacon(`${url}?token=${encodeURIComponent(token ?? "")}`, blob);
      } catch { /* ignore */ }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [session]);

  /** Mid-call switch helpers — changing LLM/voice/language while a call is
   *  active requires tearing down and reconnecting (CallSession reads its
   *  overrides at constructor time, not per-turn). We prompt the operator,
   *  then pass the *new* values explicitly to handleStart so it doesn't
   *  rely on a setState that hasn't flushed yet. */
  const switchAndRestart = async (
    label: string,
    apply: () => void,
    overrides: { llmProvider?: string; voice?: string; language?: string },
  ): Promise<void> => {
    if (!session) { apply(); return; }
    const ok = window.confirm(
      `Changing ${label} mid-call will end the current call and start a fresh one with the new setting. Continue?`,
    );
    if (!ok) return;
    apply();
    await handleEnd();
    await handleStart(overrides);
  };
  const handleLlmChange = (next: string) => {
    void switchAndRestart("LLM provider", () => setLlmProvider(next), { llmProvider: next });
  };
  const handleVoiceChange = (next: string) => {
    void switchAndRestart("voice", () => setVoice(next), { voice: next });
  };
  const handleLanguageChange = (next: string) => {
    void switchAndRestart("language", () => setLanguage(next), { language: next });
  };

  const handleStart = async (
    overrides?: { llmProvider?: string; voice?: string; language?: string },
  ) => {
    const effProvider = overrides?.llmProvider ?? llmProvider;
    const effVoice = overrides?.voice ?? voice;
    const effLanguage = overrides?.language ?? language;
    setError(null);
    setTranscript([]);
    setAllMetrics([]);
    setCurrentMetrics(null);
    setLogs([]);
    setStarting(true);
    try {
      const startRes = await apiFetch("/api/simulator/start", {
        method: "POST",
        body: JSON.stringify({
          leadName,
          leadPhone,
          llmProvider: effProvider,
          // Only send overrides when the operator picked something other
          // than "use platform default" — keeps the payload minimal and
          // lets the server resolve from agent_settings as usual.
          voice: effVoice === "default" ? undefined : effVoice,
          language: effLanguage === "default" ? undefined : effLanguage,
        }),
      });
      if (!startRes?.success) {
        throw new Error(startRes?.message ?? "Failed to start simulator");
      }
      const data: SessionInfo & { token: string; url: string; identity: string } = startRes.data;
      setSession({
        callId: data.callId,
        callSid: data.callSid,
        leadId: data.leadId,
        roomName: data.roomName,
      });

      // Connect to LiveKit and publish mic. Agent worker is already in
      // the room (server started it before responding), so the greeting
      // will arrive within ~1-2s after publishTrack resolves.
      const room = new Room({
        adaptiveStream: true,
        dynacast: false,
      });
      roomRef.current = room;
      room.on(RoomEvent.TrackSubscribed, (
        track: RemoteTrack,
        _pub: RemoteTrackPublication,
        _participant: RemoteParticipant,
      ) => {
        if (track.kind === Track.Kind.Audio && audioElRef.current) {
          track.attach(audioElRef.current);
        }
      });
      room.on(RoomEvent.Disconnected, () => {
        setConnected(false);
      });
      await room.connect(data.url, data.token, { autoSubscribe: true });
      await room.localParticipant.setMicrophoneEnabled(true);
      setConnected(true);

      // Open SSE for transcript/metrics/log events. EventSource can't set
      // headers — auth via `?token=` query param (same pattern as
      // /api/sse/events).
      const token = localStorage.getItem("auth_token");
      const sseUrl = `${BASE}/api/simulator/${data.callId}/stream${token ? `?token=${encodeURIComponent(token)}` : ""}`;
      const es = new EventSource(sseUrl);
      sseRef.current = es;
      es.addEventListener("transcript", (ev: MessageEvent) => {
        const parsed = JSON.parse(ev.data) as TranscriptTurn & { ts: number };
        setTranscript((t) => [
          ...t,
          {
            turn: parsed.turn,
            userText: parsed.userText,
            agentText: parsed.agentText,
            userAt: parsed.userAt,
            agentAt: parsed.agentAt,
          },
        ]);
      });
      es.addEventListener("metrics", (ev: MessageEvent) => {
        const parsed = JSON.parse(ev.data) as MetricRow & { ts: number };
        setCurrentMetrics(parsed);
        setAllMetrics((m) => [...m, parsed]);
      });
      es.addEventListener("log", (ev: MessageEvent) => {
        const parsed = JSON.parse(ev.data) as Record<string, unknown> & { ts: number; level: string; event: string | null };
        const { ts, level, event, ...rest } = parsed;
        setLogs((l) => {
          const next = [...l, { ts, level, event, body: rest }];
          // Cap log buffer so a runaway call doesn't OOM the tab.
          return next.length > 2000 ? next.slice(-2000) : next;
        });
      });
      es.onerror = () => {
        // EventSource auto-reconnects; surface a visual hint only.
        // No teardown — the call may still be live.
      };
    } catch (err) {
      setError((err as Error).message);
      await teardown();
      setSession(null);
    } finally {
      setStarting(false);
    }
  };

  const toggleMute = async () => {
    const room = roomRef.current;
    if (!room) return;
    const next = !micMuted;
    await room.localParticipant.setMicrophoneEnabled(!next);
    setMicMuted(next);
  };

  const p50 = useMemo(() => {
    const out: Record<string, number | null> = {};
    for (const spec of METRIC_SPECS) {
      if (spec.key === "ttsPlaybackStartAt") {
        out[spec.key] = null;
        continue;
      }
      const xs = allMetrics
        .map((m) => m[spec.key])
        .filter((v): v is number => typeof v === "number");
      out[spec.key] = median(xs);
    }
    return out;
  }, [allMetrics]);

  const filteredLogs = useMemo(() => {
    if (!logSearch.trim()) return logs;
    const q = logSearch.toLowerCase();
    return logs.filter((l) => {
      if ((l.event ?? "").toLowerCase().includes(q)) return true;
      try {
        return JSON.stringify(l.body).toLowerCase().includes(q);
      } catch {
        return false;
      }
    });
  }, [logs, logSearch]);

  return (
    <div className="space-y-4">
      <audio ref={audioElRef} autoPlay playsInline className="hidden" />

      {/* Top bar */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <PhoneCall className="h-5 w-5" /> Call Simulator
            {connected && <Badge variant="default" className="ml-2 bg-emerald-500">Live</Badge>}
            {session && !connected && <Badge variant="secondary" className="ml-2">Connecting…</Badge>}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-6 gap-3 items-end">
            <div className="space-y-1 md:col-span-2">
              <Label htmlFor="sim-name">Lead name</Label>
              <Input id="sim-name" value={leadName} onChange={(e) => setLeadName(e.target.value)} disabled={!!session} />
            </div>
            <div className="space-y-1 md:col-span-2">
              <Label htmlFor="sim-phone">Phone (display only)</Label>
              <Input id="sim-phone" value={leadPhone} onChange={(e) => setLeadPhone(e.target.value)} disabled={!!session} />
            </div>
            <div className="space-y-1 md:col-span-2">
              <Label>LLM provider</Label>
              <Select value={llmProvider} onValueChange={handleLlmChange}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {LLM_PROVIDERS.map((p) => (
                    <SelectItem key={p.id} value={p.id}>{p.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1 md:col-span-2">
              <Label>Voice</Label>
              <Select value={voice} onValueChange={handleVoiceChange}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {VOICE_OPTIONS.map((p) => (
                    <SelectItem key={p.id} value={p.id}>{p.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1 md:col-span-2">
              <Label>Language</Label>
              <Select value={language} onValueChange={handleLanguageChange}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {LANGUAGE_OPTIONS.map((p) => (
                    <SelectItem key={p.id} value={p.id}>{p.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex gap-2 md:col-span-2 justify-end">
              {!session ? (
                <Button onClick={() => void handleStart()} disabled={starting} className="w-full md:w-auto">
                  <PhoneCall className="h-4 w-4 mr-2" /> {starting ? "Starting…" : "Start call"}
                </Button>
              ) : (
                <>
                  <Button variant="outline" onClick={toggleMute} disabled={!connected}>
                    {micMuted ? <MicOff className="h-4 w-4 mr-2" /> : <Mic className="h-4 w-4 mr-2" />}
                    {micMuted ? "Unmute" : "Mute"}
                  </Button>
                  <Button variant="destructive" onClick={handleEnd}>
                    <PhoneOff className="h-4 w-4 mr-2" /> End call
                  </Button>
                </>
              )}
            </div>
          </div>
          {error && (
            <div className="mt-3 p-2 rounded bg-red-500/10 text-red-500 text-sm">{error}</div>
          )}
          {session && (
            <div className="mt-3 text-xs text-muted-foreground font-mono">
              callId={session.callId} · callSid={session.callSid} · room={session.roomName}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Transcript + Metrics */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="lg:col-span-2">
          <CardHeader><CardTitle>Transcript</CardTitle></CardHeader>
          <CardContent>
            <div className="space-y-3 max-h-[420px] overflow-y-auto pr-2">
              {transcript.length === 0 && (
                <div className="text-sm text-muted-foreground">
                  No turns yet. {session ? "Speak after the agent's greeting." : "Start a call to begin."}
                </div>
              )}
              {transcript.map((t) => {
                const userTs = t.userAt ? new Date(t.userAt).toLocaleTimeString() : null;
                const agentTs = t.agentAt ? new Date(t.agentAt).toLocaleTimeString() : null;
                return (
                  <div key={t.turn} className="space-y-1">
                    <div className="text-xs text-muted-foreground">Turn {t.turn}</div>
                    <div className="rounded-lg bg-muted/50 px-3 py-2 text-sm">
                      <div className="flex items-center justify-between mb-0.5">
                        <span className="text-[10px] uppercase text-muted-foreground">You</span>
                        {userTs && <span className="text-[10px] text-muted-foreground font-mono">{userTs}</span>}
                      </div>
                      {t.userText || <span className="text-muted-foreground italic">(silence)</span>}
                    </div>
                    <div className="rounded-lg bg-primary/10 px-3 py-2 text-sm">
                      <div className="flex items-center justify-between mb-0.5">
                        <span className="text-[10px] uppercase text-muted-foreground">Agent</span>
                        {agentTs && <span className="text-[10px] text-muted-foreground font-mono">{agentTs}</span>}
                      </div>
                      {t.agentText}
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between">
              <span>Metrics</span>
              <span className="text-xs font-normal text-muted-foreground">
                {allMetrics.length} turn{allMetrics.length === 1 ? "" : "s"}
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-1.5 text-xs">
              <div className="grid grid-cols-[1fr_auto_auto] gap-2 text-[10px] uppercase text-muted-foreground mb-1 pb-1 border-b">
                <span>Metric</span>
                <span className="text-right">Current</span>
                <span className="text-right w-12">p50</span>
              </div>
              {METRIC_SPECS.map((spec) => {
                const currentVal = currentMetrics ? currentMetrics[spec.key] : null;
                const p50Val = p50[spec.key] ?? null;
                const currentNum = typeof currentVal === "number" ? currentVal : null;
                return (
                  <div key={spec.key} className="grid grid-cols-[1fr_auto_auto] gap-2 items-baseline">
                    <span className="text-muted-foreground truncate" title={spec.label}>
                      {spec.label}
                    </span>
                    <span className={`text-right font-mono ${metricColorClass(currentNum, spec)}`}>
                      {formatMetric(currentVal ?? null, spec)}
                    </span>
                    <span className="text-right font-mono w-12 text-muted-foreground">
                      {p50Val == null ? "—" : (spec.digits != null ? p50Val.toFixed(spec.digits) : Math.round(p50Val))}
                    </span>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Log tail */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between gap-3">
            <span>Server logs</span>
            <div className="flex items-center gap-2">
              <Input
                value={logSearch}
                onChange={(e) => setLogSearch(e.target.value)}
                placeholder="filter…"
                className="h-8 w-48 text-xs"
              />
              <Button
                variant="outline"
                size="sm"
                onClick={() => setLogPaused((p) => !p)}
              >
                {logPaused ? <Play className="h-3 w-3 mr-1" /> : <Pause className="h-3 w-3 mr-1" />}
                {logPaused ? "Resume" : "Pause"}
              </Button>
            </div>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div
            ref={logsHostRef}
            className="h-72 overflow-y-auto font-mono text-[11px] leading-snug bg-black/90 text-green-200 rounded p-2"
            onMouseEnter={() => setLogPaused(true)}
            onMouseLeave={() => setLogPaused(false)}
          >
            {filteredLogs.length === 0 && (
              <div className="text-muted-foreground">No log entries yet.</div>
            )}
            {filteredLogs.map((l, i) => {
              const colour =
                l.level === "error" ? "text-red-400" :
                l.level === "warn"  ? "text-amber-300" :
                                       "text-green-200";
              const ts = new Date(l.ts).toLocaleTimeString();
              return (
                <div key={i} className={colour}>
                  <span className="text-muted-foreground">{ts}</span>{" "}
                  <span className="uppercase text-[9px]">[{l.level}]</span>{" "}
                  <span className="font-semibold">{l.event ?? "(no event)"}</span>{" "}
                  <span className="text-green-300/70">
                    {Object.entries(l.body)
                      .filter(([k]) => k !== "call_id" && k !== "level" && k !== "event")
                      .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
                      .join(" ")}
                  </span>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
