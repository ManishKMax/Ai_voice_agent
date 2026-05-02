import React, { useState } from "react";
import {
  useGetLeadById, useGetCallsForLead, useInitiateCall,
  useUpdateLead, useDeleteLead,
  getGetCallsForLeadQueryKey, getGetLeadByIdQueryKey, getGetLeadsQueryKey,
} from "@workspace/api-client-react";
import { useParams, Link, useLocation } from "wouter";
import { format } from "date-fns";
import {
  ArrowLeft, Phone, Calendar, Clock, User, PhoneCall, Tag,
  FileText, Pencil, Trash2, X, Check, RotateCcw, PhoneOff,
  AlertTriangle, Bot, MessageSquare,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { LeadStatusBadge, CallStatusBadge, PriorityBadge } from "@/components/status-badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { Separator } from "@/components/ui/separator";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import type { Lead } from "@workspace/api-client-react";

const ALL_STATUSES = [
  "pending", "calling", "completed", "interested",
  "not_interested", "no_response", "callback", "dnc",
] as const;

const TAG_COLORS: Record<string, string> = {
  hot:      "bg-red-100 text-red-700 border-red-200",
  warm:     "bg-orange-100 text-orange-700 border-orange-200",
  cold:     "bg-blue-100 text-blue-600 border-blue-200",
  callback: "bg-purple-100 text-purple-700 border-purple-200",
  vip:      "bg-yellow-100 text-yellow-700 border-yellow-200",
};
function TagChip({ tag, onRemove }: { tag: string; onRemove?: () => void }) {
  const cls = TAG_COLORS[tag.toLowerCase()] ?? "bg-gray-100 text-gray-600 border-gray-200";
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border ${cls}`}>
      {tag}
      {onRemove && (
        <button onClick={onRemove} className="ml-0.5 hover:opacity-70">
          <X className="h-3 w-3" />
        </button>
      )}
    </span>
  );
}

// ── Transcript bubble viewer ─────────────────────────────────────────────────
function TranscriptBubbles({ transcript }: { transcript: string }) {
  const lines = transcript.split("\n").filter(l => l.trim());
  return (
    <div className="space-y-3 max-h-64 overflow-y-auto pr-1">
      {lines.map((line, i) => {
        const isAgent = line.startsWith("Agent:");
        const isLead  = line.startsWith("Lead:");
        const text    = line.replace(/^(Agent:|Lead:)\s*/, "");
        if (!text) return null;
        return (
          <div key={i} className={`flex gap-2 ${isAgent ? "" : "flex-row-reverse"}`}>
            <div className={`h-7 w-7 rounded-full flex items-center justify-center text-xs flex-shrink-0 ${isAgent ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"}`}>
              {isAgent ? <Bot className="h-3.5 w-3.5" /> : <MessageSquare className="h-3.5 w-3.5" />}
            </div>
            <div className={`rounded-xl px-3 py-1.5 text-sm max-w-[80%] ${isAgent ? "bg-primary/10 text-foreground rounded-tl-none" : "bg-muted text-foreground rounded-tr-none"}`}>
              {text}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────
export default function LeadDetail() {
  const params = useParams();
  const [, navigate] = useLocation();
  const leadId = parseInt(params.id || "0", 10);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [isEditing, setIsEditing] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  // Edit state
  const [editName, setEditName] = useState("");
  const [editPhone, setEditPhone] = useState("");
  const [editSource, setEditSource] = useState("");
  const [editNotes, setEditNotes] = useState("");
  const [editTagsInput, setEditTagsInput] = useState("");
  const [editTags, setEditTags] = useState<string[]>([]);
  const [editPriority, setEditPriority] = useState<string>("2");
  const [editStatus, setEditStatus] = useState<string>("");
  const [editDnc, setEditDnc] = useState(false);

  const { data: leadData, isLoading: isLoadingLead } = useGetLeadById(leadId);
  const { data: callsData, isLoading: isLoadingCalls } = useGetCallsForLead(leadId);

  const initiateCallMutation = useInitiateCall();
  const updateLeadMutation   = useUpdateLead();
  const deleteLeadMutation   = useDeleteLead();

  const leadCalls = callsData?.calls ?? [];

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: getGetCallsForLeadQueryKey(leadId) });
    queryClient.invalidateQueries({ queryKey: getGetLeadByIdQueryKey(leadId) });
    queryClient.invalidateQueries({ queryKey: getGetLeadsQueryKey() });
  }

  function startEditing(lead: Lead) {
    setEditName(lead.name);
    setEditPhone(lead.phone);
    setEditSource(lead.source ?? "");
    setEditNotes(lead.notes ?? "");
    const tagList = (lead.tags ?? "").split(",").map(t => t.trim()).filter(Boolean);
    setEditTags(tagList);
    setEditTagsInput("");
    setEditPriority(String(lead.priority ?? 2));
    setEditStatus(lead.status);
    setEditDnc(lead.dnc ?? false);
    setIsEditing(true);
  }

  function addTag(raw: string) {
    const tag = raw.trim().toLowerCase().replace(/,/g, "");
    if (tag && !editTags.includes(tag)) setEditTags(prev => [...prev, tag]);
    setEditTagsInput("");
  }

  function saveEdits() {
    updateLeadMutation.mutate(
      {
        id: leadId,
        data: {
          name: editName,
          phone: editPhone,
          source: editSource,
          notes: editNotes,
          tags: editTags.join(","),
          priority: parseInt(editPriority) as any,
          status: editStatus as any,
          dnc: editDnc,
        },
      },
      {
        onSuccess: () => { toast({ title: "Lead saved" }); setIsEditing(false); invalidate(); },
        onError: (err: any) => toast({ title: "Save failed", description: err?.response?.data?.error, variant: "destructive" }),
      }
    );
  }

  function handleDelete() {
    deleteLeadMutation.mutate(
      { id: leadId },
      {
        onSuccess: () => { toast({ title: "Lead deleted" }); navigate("/leads"); },
        onError: () => toast({ title: "Failed to delete lead", variant: "destructive" }),
      }
    );
  }

  const handleCall = () => {
    initiateCallMutation.mutate(
      { leadId },
      {
        onSuccess: () => { toast({ title: "Call Initiated", description: "The AI agent is now dialing the lead." }); invalidate(); },
        onError: (err: unknown) => {
          const apiErr = err as { data?: { error?: string } };
          toast({ title: "Failed to initiate call", description: apiErr?.data?.error || "An error occurred", variant: "destructive" });
        },
      }
    );
  };

  // ── Loading skeleton ─────────────────────────────────────────────────────
  if (isLoadingLead) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-4">
          <Skeleton className="h-8 w-8 rounded-full" />
          <Skeleton className="h-8 w-48" />
        </div>
        <div className="grid md:grid-cols-3 gap-6">
          <Card className="md:col-span-1"><CardContent className="p-6"><Skeleton className="h-[300px] w-full" /></CardContent></Card>
          <Card className="md:col-span-2"><CardContent className="p-6"><Skeleton className="h-[300px] w-full" /></CardContent></Card>
        </div>
      </div>
    );
  }

  const lead = leadData?.lead;
  if (!lead) {
    return (
      <div className="p-8 text-center bg-card border rounded-lg">
        <h2 className="text-xl font-semibold">Lead not found</h2>
        <p className="text-muted-foreground mt-2 mb-4">This lead doesn't exist or has been deleted.</p>
        <Link href="/leads"><Button variant="outline">Back to Leads</Button></Link>
      </div>
    );
  }

  const canCall = lead.status !== "calling" && lead.status !== "dnc" && !lead.dnc;
  const tagList = (lead.tags ?? "").split(",").map(t => t.trim()).filter(Boolean);

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-center gap-3 flex-wrap">
          <Link href="/leads">
            <Button variant="outline" size="icon" className="h-8 w-8 rounded-full"><ArrowLeft className="h-4 w-4" /></Button>
          </Link>
          <h1 className="text-2xl font-bold tracking-tight">{lead.name}</h1>
          <LeadStatusBadge status={lead.status} />
          <PriorityBadge priority={lead.priority ?? 2} />
          {lead.dnc && (
            <span className="flex items-center gap-1 text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded-full border">
              <PhoneOff className="h-3 w-3" /> DNC
            </span>
          )}
        </div>
        <div className="flex gap-2 flex-wrap">
          {!isEditing && (
            <>
              <Button variant="outline" size="sm" onClick={() => startEditing(lead)}>
                <Pencil className="mr-2 h-3.5 w-3.5" /> Edit
              </Button>
              <Button variant="outline" size="sm" className="text-destructive border-destructive/30 hover:bg-destructive/5" onClick={() => setShowDeleteConfirm(true)}>
                <Trash2 className="mr-2 h-3.5 w-3.5" /> Delete
              </Button>
            </>
          )}
          <Button onClick={handleCall} disabled={initiateCallMutation.isPending || !canCall} className="w-full sm:w-auto">
            <Phone className="mr-2 h-4 w-4" />
            {initiateCallMutation.isPending ? "Initiating..." : "Call Now"}
          </Button>
        </div>
      </div>

      <div className="grid md:grid-cols-3 gap-6">
        {/* Left column */}
        <div className="space-y-5">
          {isEditing ? (
            /* ── Edit Panel ─────────────────────────────────────────── */
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center justify-between">
                  Edit Lead
                  <div className="flex gap-2">
                    <Button size="sm" variant="outline" onClick={() => setIsEditing(false)}><X className="h-3.5 w-3.5" /></Button>
                    <Button size="sm" onClick={saveEdits} disabled={updateLeadMutation.isPending}><Check className="h-3.5 w-3.5" /></Button>
                  </div>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">Name</label>
                  <Input value={editName} onChange={e => setEditName(e.target.value)} />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">Phone</label>
                  <Input value={editPhone} onChange={e => setEditPhone(e.target.value)} />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">Source</label>
                  <Input value={editSource} onChange={e => setEditSource(e.target.value)} placeholder="Website, CSV…" />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">Status</label>
                  <Select value={editStatus} onValueChange={setEditStatus}>
                    <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {ALL_STATUSES.map(s => (
                        <SelectItem key={s} value={s} className="capitalize text-sm">{s.replace(/_/g, " ")}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">Priority</label>
                  <Select value={editPriority} onValueChange={setEditPriority}>
                    <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="1">1 — Low</SelectItem>
                      <SelectItem value="2">2 — Normal</SelectItem>
                      <SelectItem value="3">3 — High</SelectItem>
                      <SelectItem value="4">4 — Urgent</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground flex items-center gap-1"><Tag className="h-3 w-3" />Tags</label>
                  <div className="flex flex-wrap gap-1 mb-1">
                    {editTags.map(t => (
                      <TagChip key={t} tag={t} onRemove={() => setEditTags(prev => prev.filter(x => x !== t))} />
                    ))}
                  </div>
                  <Input
                    value={editTagsInput}
                    onChange={e => setEditTagsInput(e.target.value)}
                    placeholder="Type a tag and press Enter…"
                    onKeyDown={e => { if (e.key === "Enter" || e.key === ",") { e.preventDefault(); addTag(editTagsInput); } }}
                  />
                </div>
                <div className="flex items-center gap-2 pt-1">
                  <input
                    type="checkbox"
                    id="dnc-toggle"
                    checked={editDnc}
                    onChange={e => setEditDnc(e.target.checked)}
                    className="rounded"
                  />
                  <label htmlFor="dnc-toggle" className="text-sm flex items-center gap-1.5 cursor-pointer">
                    <PhoneOff className="h-3.5 w-3.5 text-muted-foreground" /> Do Not Call (DNC)
                  </label>
                </div>
                <div className="space-y-1 pt-1">
                  <label className="text-xs font-medium text-muted-foreground">Notes</label>
                  <Textarea rows={4} value={editNotes} onChange={e => setEditNotes(e.target.value)} />
                </div>
              </CardContent>
            </Card>
          ) : (
            /* ── Read-only Panel ─────────────────────────────────────── */
            <>
              <Card>
                <CardHeader><CardTitle className="text-base">Contact Info</CardTitle></CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex items-start gap-3">
                    <User className="h-4 w-4 text-muted-foreground mt-0.5" />
                    <div><p className="text-sm font-medium">Name</p><p className="text-sm text-muted-foreground">{lead.name}</p></div>
                  </div>
                  <div className="flex items-start gap-3">
                    <Phone className="h-4 w-4 text-muted-foreground mt-0.5" />
                    <div><p className="text-sm font-medium">Phone</p><p className="text-sm text-muted-foreground">{lead.phone}</p></div>
                  </div>
                  <div className="flex items-start gap-3">
                    <Tag className="h-4 w-4 text-muted-foreground mt-0.5" />
                    <div><p className="text-sm font-medium">Source</p><p className="text-sm text-muted-foreground">{lead.source || "Unknown"}</p></div>
                  </div>
                  <div className="flex items-start gap-3">
                    <Calendar className="h-4 w-4 text-muted-foreground mt-0.5" />
                    <div><p className="text-sm font-medium">Added</p><p className="text-sm text-muted-foreground">{format(new Date(lead.createdAt), "MMMM d, yyyy")}</p></div>
                  </div>
                  {tagList.length > 0 && (
                    <div className="flex items-start gap-3">
                      <Tag className="h-4 w-4 text-muted-foreground mt-0.5" />
                      <div>
                        <p className="text-sm font-medium mb-1.5">Tags</p>
                        <div className="flex flex-wrap gap-1">{tagList.map(t => <TagChip key={t} tag={t} />)}</div>
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>

              {lead.notes && (
                <Card>
                  <CardHeader><CardTitle className="text-base">Notes</CardTitle></CardHeader>
                  <CardContent>
                    <div className="text-sm bg-muted/50 p-3 rounded-md whitespace-pre-wrap text-muted-foreground">
                      {lead.notes}
                    </div>
                  </CardContent>
                </Card>
              )}
            </>
          )}
        </div>

        {/* Right column - Call History */}
        <div className="md:col-span-2">
          <Card className="h-full flex flex-col">
            <CardHeader>
              <CardTitle className="text-base">Call History</CardTitle>
              <CardDescription>{lead.retryCount} attempt{lead.retryCount !== "1" ? "s" : ""} made</CardDescription>
            </CardHeader>
            <CardContent className="flex-1">
              {isLoadingCalls ? (
                <div className="space-y-4">{[1, 2, 3].map(i => <Skeleton key={i} className="h-16 w-full" />)}</div>
              ) : leadCalls.length === 0 ? (
                <div className="h-48 flex flex-col items-center justify-center text-muted-foreground">
                  <PhoneCall className="h-8 w-8 mb-2 opacity-20" />
                  <p className="text-sm">No calls have been made yet.</p>
                </div>
              ) : (
                <div className="space-y-4">
                  {[...leadCalls]
                    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
                    .map((call, idx) => (
                      <div key={call.id}>
                        {idx > 0 && <Separator className="my-4" />}
                        <div className="flex items-start justify-between">
                          <div className="flex items-start gap-3 flex-1">
                            <div className={`mt-0.5 p-2 rounded-full ${call.callStatus === "completed" ? "bg-green-100 text-green-700" : "bg-blue-100 text-blue-700"}`}>
                              <PhoneCall className="h-4 w-4" />
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 mb-1 flex-wrap">
                                <span className="font-medium text-sm">Call #{call.id}</span>
                                <CallStatusBadge status={call.callStatus} className="text-[10px] h-5" />
                              </div>
                              <div className="flex items-center gap-3 text-xs text-muted-foreground mb-2">
                                <span className="flex items-center gap-1">
                                  <Clock className="h-3 w-3" />
                                  {format(new Date(call.createdAt), "MMM d, h:mm a")}
                                </span>
                                {call.duration && <span>Duration: {call.duration}s</span>}
                              </div>
                              {call.transcript && (
                                <div className="mt-2 bg-muted/40 border rounded-lg p-3">
                                  <div className="flex items-center gap-1.5 font-medium mb-2 text-xs uppercase tracking-wider text-muted-foreground">
                                    <FileText className="h-3 w-3" /> Conversation
                                  </div>
                                  <TranscriptBubbles transcript={call.transcript} />
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      </div>
                    ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Delete Confirm Dialog */}
      <Dialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-5 w-5" /> Delete Lead
            </DialogTitle>
            <DialogDescription>
              This will permanently delete <strong>{lead.name}</strong> and all {leadCalls.length} call record{leadCalls.length !== 1 ? "s" : ""}. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDeleteConfirm(false)}>Cancel</Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deleteLeadMutation.isPending}>
              <Trash2 className="mr-2 h-4 w-4" />
              {deleteLeadMutation.isPending ? "Deleting…" : "Delete Lead"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
