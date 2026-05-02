import React, { useState } from "react";
import { useGetCalls, useGetCallById, getGetCallByIdQueryKey } from "@workspace/api-client-react";
import { format } from "date-fns";
import { Link } from "wouter";
import {
  Filter, Bot, User, MessageSquare, Clock, Phone,
  Calendar, Hash, ChevronRight, MessagesSquare,
} from "lucide-react";
import {
  Table, TableBody, TableCell, TableHead,
  TableHeader, TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { CallStatusBadge } from "@/components/status-badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select, SelectContent, SelectItem,
  SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";

// ── Transcript parsing ────────────────────────────────────────────────────────

interface Turn { speaker: "Agent" | "Lead"; text: string; }

function parseTranscript(raw: string | null | undefined): Turn[] {
  if (!raw) return [];
  const turns: Turn[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("Agent:")) turns.push({ speaker: "Agent", text: trimmed.slice(6).trim() });
    else if (trimmed.startsWith("Lead:")) turns.push({ speaker: "Lead", text: trimmed.slice(5).trim() });
  }
  return turns;
}

// ── Chat bubble ──────────────────────────────────────────────────────────────

function TurnBubble({ turn, index }: { turn: Turn; index: number }) {
  const isAgent = turn.speaker === "Agent";

  return (
    <div className={`flex gap-2.5 ${isAgent ? "justify-start" : "justify-end"}`}>
      {isAgent && (
        <div className="flex-shrink-0 w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center mt-0.5">
          <Bot className="h-3.5 w-3.5 text-primary" />
        </div>
      )}

      <div className={`max-w-[78%] space-y-0.5 ${isAgent ? "" : "items-end flex flex-col"}`}>
        <span className="text-[10px] font-medium text-muted-foreground px-1">
          {isAgent ? "Agent" : "Lead"} · Turn {Math.floor(index / 2) + 1}
        </span>
        <div
          className={`rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed ${
            isAgent
              ? "bg-primary/8 text-foreground rounded-tl-sm border border-primary/10"
              : "bg-muted text-foreground rounded-tr-sm"
          }`}
        >
          {turn.text}
        </div>
      </div>

      {!isAgent && (
        <div className="flex-shrink-0 w-7 h-7 rounded-full bg-muted-foreground/10 flex items-center justify-center mt-0.5">
          <User className="h-3.5 w-3.5 text-muted-foreground" />
        </div>
      )}
    </div>
  );
}

// ── Transcript dialog ────────────────────────────────────────────────────────

function TranscriptDialog({
  callId, open, onOpenChange,
}: { callId: number | null; open: boolean; onOpenChange: (o: boolean) => void }) {
  const { data, isLoading } = useGetCallById(callId ?? 0, {
    query: {
      queryKey: getGetCallByIdQueryKey(callId ?? 0),
      enabled: !!callId && open,
    },
  });

  const turns = parseTranscript(data?.call?.transcript);
  const agentTurns = turns.filter(t => t.speaker === "Agent").length;
  const leadTurns = turns.filter(t => t.speaker === "Lead").length;
  const hasTranscript = turns.length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[640px] p-0 gap-0 overflow-hidden">
        <DialogHeader className="px-5 pt-5 pb-4 border-b bg-muted/30">
          <DialogTitle className="flex items-center gap-2 text-base">
            <MessagesSquare className="h-4 w-4 text-primary" />
            Call Transcript
            {callId && (
              <span className="text-muted-foreground font-normal text-sm">#{callId}</span>
            )}
          </DialogTitle>

          {/* Metadata bar */}
          {!isLoading && data?.call && (
            <div className="flex flex-wrap gap-3 mt-2.5">
              <MetaBadge icon={<Phone className="h-3 w-3" />}>
                <CallStatusBadge status={data.call.callStatus} />
              </MetaBadge>
              {data.call.duration != null && (
                <MetaBadge icon={<Clock className="h-3 w-3" />}>
                  {data.call.duration}s
                </MetaBadge>
              )}
              <MetaBadge icon={<Calendar className="h-3 w-3" />}>
                {format(new Date(data.call.createdAt), "MMM d, yyyy · h:mm a")}
              </MetaBadge>
              {hasTranscript && (
                <MetaBadge icon={<MessageSquare className="h-3 w-3" />}>
                  {agentTurns} agent · {leadTurns} lead
                </MetaBadge>
              )}
            </div>
          )}
        </DialogHeader>

        {/* Body */}
        <div className="flex flex-col" style={{ height: "480px" }}>
          {isLoading ? (
            <div className="p-5 space-y-4">
              {[1, 2, 3, 4].map(i => (
                <div key={i} className={`flex gap-2.5 ${i % 2 === 0 ? "justify-end" : ""}`}>
                  {i % 2 !== 0 && <Skeleton className="h-7 w-7 rounded-full flex-shrink-0" />}
                  <Skeleton className={`h-14 rounded-2xl ${i % 2 !== 0 ? "w-64" : "w-48"}`} />
                  {i % 2 === 0 && <Skeleton className="h-7 w-7 rounded-full flex-shrink-0" />}
                </div>
              ))}
            </div>
          ) : !hasTranscript ? (
            <div className="flex-1 flex flex-col items-center justify-center gap-3 text-muted-foreground p-8">
              <MessageSquare className="h-10 w-10 opacity-20" />
              <div className="text-center">
                <p className="font-medium text-sm">No transcript available</p>
                <p className="text-xs mt-1 opacity-70">
                  {data?.call?.callStatus === "completed"
                    ? "This call completed but no conversation was recorded."
                    : "Transcript will appear here once the call finishes."}
                </p>
              </div>
            </div>
          ) : (
            <ScrollArea className="flex-1">
              <div className="p-5 space-y-4">
                {turns.map((turn, i) => (
                  <TurnBubble key={i} turn={turn} index={i} />
                ))}
              </div>
            </ScrollArea>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function MetaBadge({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
      {icon}
      {children}
    </div>
  );
}

// ── Main Calls page ──────────────────────────────────────────────────────────

export default function Calls() {
  const [statusFilter, setStatusFilter] = useState<string | undefined>(undefined);
  const [selectedCallId, setSelectedCallId] = useState<number | null>(null);

  const { data, isLoading } = useGetCalls({
    status: statusFilter === "all" ? undefined : statusFilter,
    limit: 50,
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Call Log</h1>
          <p className="text-sm text-muted-foreground mt-1">
            History of all outbound AI interactions
          </p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row items-center gap-4 bg-card p-4 border rounded-lg">
        <div className="w-full sm:w-52 flex items-center gap-2">
          <Filter className="h-4 w-4 text-muted-foreground shrink-0" />
          <Select value={statusFilter ?? "all"} onValueChange={v => setStatusFilter(v)}>
            <SelectTrigger>
              <SelectValue placeholder="Filter by status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Statuses</SelectItem>
              <SelectItem value="initiated">Initiated</SelectItem>
              <SelectItem value="ringing">Ringing</SelectItem>
              <SelectItem value="answered">Answered</SelectItem>
              <SelectItem value="completed">Completed</SelectItem>
              <SelectItem value="no-answer">No Answer</SelectItem>
              <SelectItem value="busy">Busy</SelectItem>
              <SelectItem value="failed">Failed</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Table */}
      <div className="border rounded-lg bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-16">ID</TableHead>
              <TableHead>Lead</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Duration</TableHead>
              <TableHead>Date</TableHead>
              <TableHead>Twilio SID</TableHead>
              <TableHead className="text-right">Transcript</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell><Skeleton className="h-4 w-[20px]" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-[120px]" /></TableCell>
                  <TableCell><Skeleton className="h-6 w-[80px] rounded-full" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-[40px]" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-[100px]" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-[120px]" /></TableCell>
                  <TableCell className="text-right"><Skeleton className="h-8 w-[90px] ml-auto" /></TableCell>
                </TableRow>
              ))
            ) : data?.calls.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="h-24 text-center text-muted-foreground">
                  No calls found.
                </TableCell>
              </TableRow>
            ) : (
              data?.calls.map(call => {
                const hasTranscript = !!call.transcript;
                return (
                  <TableRow key={call.id} className="group">
                    <TableCell>
                      <span className="font-mono text-xs text-muted-foreground">#{call.id}</span>
                    </TableCell>
                    <TableCell>
                      <Link
                        href={`/leads/${call.leadId}`}
                        className="hover:underline font-medium text-foreground flex items-center gap-1"
                      >
                        Lead {call.leadId}
                        <ChevronRight className="h-3 w-3 opacity-0 group-hover:opacity-60 transition-opacity" />
                      </Link>
                    </TableCell>
                    <TableCell>
                      <CallStatusBadge status={call.callStatus} />
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {call.duration ? (
                        <span className="flex items-center gap-1">
                          <Clock className="h-3 w-3 opacity-50" />
                          {call.duration}s
                        </span>
                      ) : "—"}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {format(new Date(call.createdAt), "MMM d, h:mm a")}
                    </TableCell>
                    <TableCell>
                      {call.twilioCallSid ? (
                        <span className="font-mono text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded">
                          {call.twilioCallSid.substring(0, 10)}…
                        </span>
                      ) : "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant={hasTranscript ? "default" : "ghost"}
                        size="sm"
                        className="h-8 text-xs"
                        disabled={!hasTranscript}
                        onClick={() => setSelectedCallId(call.id)}
                        title={hasTranscript ? "View conversation transcript" : "No transcript available"}
                      >
                        <MessagesSquare className="h-3.5 w-3.5 mr-1.5" />
                        {hasTranscript ? "View Chat" : "No Chat"}
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>

        {data && (
          <div className="p-4 border-t text-xs text-muted-foreground flex justify-between items-center">
            <span>Showing {data.calls.length} of {data.count} calls</span>
            <span>
              {data.calls.filter(c => c.transcript).length} with transcripts
            </span>
          </div>
        )}
      </div>

      <TranscriptDialog
        callId={selectedCallId}
        open={selectedCallId !== null}
        onOpenChange={open => !open && setSelectedCallId(null)}
      />
    </div>
  );
}
