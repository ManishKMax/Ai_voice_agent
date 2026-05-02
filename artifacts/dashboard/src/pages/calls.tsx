import React, { useState } from "react";
import { useGetCalls, useAnalyzeCall, useGetCallById, getGetCallByIdQueryKey } from "@workspace/api-client-react";
import { format } from "date-fns";
import { Link } from "wouter";
import { Search, Filter, PlayCircle, ExternalLink, Activity, FileText } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CallStatusBadge } from "@/components/status-badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";

function CallDetailDialog({ callId, open, onOpenChange }: { callId: number | null, open: boolean, onOpenChange: (open: boolean) => void }) {
  const { data, isLoading } = useGetCallById(callId || 0, { query: { queryKey: getGetCallByIdQueryKey(callId || 0), enabled: !!callId && open } });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle>Call Details #{callId}</DialogTitle>
          <DialogDescription>
            Detailed information and analysis for this call.
          </DialogDescription>
        </DialogHeader>
        {isLoading ? (
          <div className="space-y-4 py-4">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-32 w-full" />
          </div>
        ) : data ? (
          <div className="space-y-4 py-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="text-sm font-medium text-muted-foreground">Status</p>
                <div className="mt-1"><CallStatusBadge status={data.call.callStatus} /></div>
              </div>
              <div>
                <p className="text-sm font-medium text-muted-foreground">Duration</p>
                <p className="mt-1">{data.call.duration ? `${data.call.duration}s` : "N/A"}</p>
              </div>
              <div>
                <p className="text-sm font-medium text-muted-foreground">Date</p>
                <p className="mt-1 text-sm">{format(new Date(data.call.createdAt), "MMM d, yyyy h:mm a")}</p>
              </div>
              <div>
                <p className="text-sm font-medium text-muted-foreground">Twilio SID</p>
                <p className="mt-1 text-sm font-mono">{data.call.twilioCallSid || "N/A"}</p>
              </div>
            </div>
            
            {data.call.recordingUrl && (
              <div>
                <p className="text-sm font-medium text-muted-foreground mb-2">Recording</p>
                <audio src={data.call.recordingUrl} controls className="w-full h-10" />
              </div>
            )}
            
            <div>
              <p className="text-sm font-medium text-muted-foreground mb-2 flex items-center gap-1">
                <FileText className="h-4 w-4" /> Transcript
              </p>
              <div className="bg-muted p-3 rounded-md text-sm whitespace-pre-wrap max-h-[300px] overflow-y-auto">
                {data.call.transcript || <span className="italic opacity-50">No transcript available.</span>}
              </div>
            </div>
          </div>
        ) : (
          <div className="py-8 text-center text-muted-foreground">Failed to load call details.</div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default function Calls() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<any>(undefined);
  const [selectedCallId, setSelectedCallId] = useState<number | null>(null);

  const { data, isLoading } = useGetCalls({
    status: statusFilter === "all" ? undefined : statusFilter,
    limit: 50,
  });

  const analyzeMutation = useAnalyzeCall();

  const handleAnalyze = (callId: number) => {
    analyzeMutation.mutate(
      { callId },
      {
        onSuccess: () => {
          toast({ title: "Analysis initiated", description: "Call is being analyzed by AI." });
        },
        onError: () => {
          toast({ title: "Analysis failed", variant: "destructive" });
        }
      }
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Call Log</h1>
          <p className="text-sm text-muted-foreground mt-1">History of all outbound AI interactions</p>
        </div>
      </div>

      <div className="flex flex-col sm:flex-row items-center gap-4 bg-card p-4 border rounded-lg">
        <div className="w-full sm:w-48 flex items-center gap-2">
          <Filter className="h-4 w-4 text-muted-foreground shrink-0" />
          <Select value={statusFilter || "all"} onValueChange={(v) => setStatusFilter(v)}>
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

      <div className="border rounded-lg bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-20">ID</TableHead>
              <TableHead>Lead</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Duration</TableHead>
              <TableHead>Date</TableHead>
              <TableHead>Twilio SID</TableHead>
              <TableHead className="text-right">Actions</TableHead>
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
                  <TableCell><Skeleton className="h-4 w-[150px]" /></TableCell>
                  <TableCell className="text-right"><Skeleton className="h-8 w-[80px] ml-auto" /></TableCell>
                </TableRow>
              ))
            ) : data?.calls.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="h-24 text-center text-muted-foreground">
                  No calls found.
                </TableCell>
              </TableRow>
            ) : (
              data?.calls.map((call) => (
                <TableRow key={call.id}>
                  <TableCell>
                    <button 
                      onClick={() => setSelectedCallId(call.id)}
                      className="font-medium text-primary hover:underline"
                    >
                      #{call.id}
                    </button>
                  </TableCell>
                  <TableCell>
                    <Link href={`/leads/${call.leadId}`} className="hover:underline font-medium text-foreground">
                      View Lead {call.leadId}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <CallStatusBadge status={call.callStatus} />
                  </TableCell>
                  <TableCell>
                    {call.duration ? `${call.duration}s` : "—"}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {format(new Date(call.createdAt), "MMM d, yyyy h:mm a")}
                  </TableCell>
                  <TableCell>
                    {call.twilioCallSid ? (
                      <span className="font-mono text-xs text-muted-foreground bg-muted px-2 py-1 rounded">
                        {call.twilioCallSid.substring(0, 8)}...
                      </span>
                    ) : "—"}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button 
                      variant="outline" 
                      size="sm" 
                      className="h-8 text-xs"
                      onClick={() => handleAnalyze(call.id)}
                      disabled={analyzeMutation.isPending || call.callStatus !== "completed"}
                    >
                      <Activity className="mr-2 h-3 w-3" />
                      {analyzeMutation.isPending ? "..." : "Analyze"}
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
        {data && (
          <div className="p-4 border-t text-xs text-muted-foreground flex justify-between items-center">
            <span>Showing {data.calls.length} of {data.count} calls</span>
          </div>
        )}
      </div>

      <CallDetailDialog 
        callId={selectedCallId} 
        open={selectedCallId !== null} 
        onOpenChange={(open) => !open && setSelectedCallId(null)} 
      />
    </div>
  );
}
