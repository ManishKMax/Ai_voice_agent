import React, { useEffect } from "react";
import { useGetLeadById, useGetCalls, useInitiateCall, getGetCallsQueryKey, getGetLeadByIdQueryKey } from "@workspace/api-client-react";
import { useParams, Link, useLocation } from "wouter";
import { format } from "date-fns";
import { ArrowLeft, Phone, Calendar, Clock, User, PhoneCall, Tag, FileText } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { LeadStatusBadge, CallStatusBadge } from "@/components/status-badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { Separator } from "@/components/ui/separator";

export default function LeadDetail() {
  const params = useParams();
  const leadId = parseInt(params.id || "0", 10);
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [location] = useLocation();

  const { data: leadData, isLoading: isLoadingLead } = useGetLeadById(leadId);
  const { data: callsData, isLoading: isLoadingCalls } = useGetCalls({ limit: 100 });
  const initiateCallMutation = useInitiateCall();

  // Filter calls for this lead on the client since API doesn't have leadId filter yet
  const leadCalls = callsData?.calls.filter(c => c.leadId === leadId) || [];

  // Check if we came here with ?call=true
  useEffect(() => {
    if (location.includes("?call=true") && !initiateCallMutation.isPending && leadData) {
      handleCall();
      // Remove query param to prevent infinite loops if they navigate away and back
      window.history.replaceState({}, document.title, window.location.pathname);
    }
  }, [location, leadData]);

  const handleCall = () => {
    initiateCallMutation.mutate(
      { leadId },
      {
        onSuccess: () => {
          toast({ title: "Call Initiated", description: "The AI agent is now dialing the lead." });
          queryClient.invalidateQueries({ queryKey: getGetCallsQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetLeadByIdQueryKey(leadId) });
        },
        onError: (err: any) => {
          toast({ 
            title: "Failed to initiate call", 
            description: err?.response?.data?.error || "An error occurred",
            variant: "destructive"
          });
        }
      }
    );
  };

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
        <p className="text-muted-foreground mt-2 mb-4">The lead you're looking for doesn't exist or has been deleted.</p>
        <Link href="/leads">
          <Button variant="outline">Back to Leads</Button>
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <Link href="/leads">
            <Button variant="outline" size="icon" className="h-8 w-8 rounded-full">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <h1 className="text-2xl font-bold tracking-tight">{lead.name}</h1>
          <LeadStatusBadge status={lead.status} />
        </div>
        
        <Button 
          onClick={handleCall} 
          disabled={initiateCallMutation.isPending || lead.status === 'completed' || lead.status === 'not_interested'}
          className="w-full sm:w-auto"
        >
          <Phone className="mr-2 h-4 w-4" />
          {initiateCallMutation.isPending ? "Initiating..." : "Call Now"}
        </Button>
      </div>

      <div className="grid md:grid-cols-3 gap-6">
        {/* Left Column - Details */}
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Contact Info</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-start gap-3">
                <User className="h-4 w-4 text-muted-foreground mt-0.5" />
                <div>
                  <p className="text-sm font-medium">Name</p>
                  <p className="text-sm text-muted-foreground">{lead.name}</p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <Phone className="h-4 w-4 text-muted-foreground mt-0.5" />
                <div>
                  <p className="text-sm font-medium">Phone</p>
                  <p className="text-sm text-muted-foreground">{lead.phone}</p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <Tag className="h-4 w-4 text-muted-foreground mt-0.5" />
                <div>
                  <p className="text-sm font-medium">Source</p>
                  <p className="text-sm text-muted-foreground">{lead.source || "Unknown"}</p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <Calendar className="h-4 w-4 text-muted-foreground mt-0.5" />
                <div>
                  <p className="text-sm font-medium">Added</p>
                  <p className="text-sm text-muted-foreground">{format(new Date(lead.createdAt), "MMMM d, yyyy")}</p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Notes</CardTitle>
            </CardHeader>
            <CardContent>
              {lead.notes ? (
                <div className="text-sm bg-muted/50 p-3 rounded-md whitespace-pre-wrap text-muted-foreground">
                  {lead.notes}
                </div>
              ) : (
                <div className="text-sm text-muted-foreground italic">No notes available.</div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Right Column - Call History */}
        <div className="md:col-span-2">
          <Card className="h-full flex flex-col">
            <CardHeader>
              <CardTitle className="text-lg">Call History</CardTitle>
              <CardDescription>
                {lead.retryCount} total attempts
              </CardDescription>
            </CardHeader>
            <CardContent className="flex-1">
              {isLoadingCalls ? (
                <div className="space-y-4">
                  {[1, 2, 3].map(i => <Skeleton key={i} className="h-16 w-full" />)}
                </div>
              ) : leadCalls.length === 0 ? (
                <div className="h-48 flex flex-col items-center justify-center text-muted-foreground">
                  <PhoneCall className="h-8 w-8 mb-2 opacity-20" />
                  <p className="text-sm">No calls have been made to this lead yet.</p>
                </div>
              ) : (
                <div className="space-y-4">
                  {leadCalls.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).map((call, idx) => (
                    <div key={call.id}>
                      {idx > 0 && <Separator className="my-4" />}
                      <div className="flex items-start justify-between">
                        <div className="flex items-start gap-3">
                          <div className={`mt-0.5 p-2 rounded-full ${call.callStatus === 'completed' ? 'bg-green-100 text-green-700' : 'bg-blue-100 text-blue-700'}`}>
                            <PhoneCall className="h-4 w-4" />
                          </div>
                          <div>
                            <div className="flex items-center gap-2 mb-1">
                              <span className="font-medium text-sm">Call #{call.id}</span>
                              <CallStatusBadge status={call.callStatus} className="text-[10px] h-5" />
                            </div>
                            <div className="flex items-center gap-3 text-xs text-muted-foreground">
                              <span className="flex items-center gap-1">
                                <Clock className="h-3 w-3" />
                                {format(new Date(call.createdAt), "MMM d, h:mm a")}
                              </span>
                              {call.duration && (
                                <span>Duration: {call.duration}s</span>
                              )}
                            </div>
                            {call.transcript && (
                              <div className="mt-3 text-sm bg-muted p-3 rounded-md border text-foreground/80">
                                <div className="flex items-center gap-1.5 font-medium mb-1 text-xs uppercase tracking-wider text-muted-foreground">
                                  <FileText className="h-3 w-3" /> Transcript snippet
                                </div>
                                <p className="line-clamp-3">{call.transcript}</p>
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
    </div>
  );
}
