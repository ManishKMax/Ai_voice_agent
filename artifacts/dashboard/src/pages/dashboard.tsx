import React from "react";
import { useGetDashboardStats } from "@workspace/api-client-react";
import { Link } from "wouter";
import { format } from "date-fns";
import { Users, PhoneCall, PhoneForwarded, Clock, ArrowRight } from "lucide-react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { LeadStatusBadge, CallStatusBadge } from "@/components/status-badge";

export default function Dashboard() {
  const { data: stats, isLoading, isError } = useGetDashboardStats();

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
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-7">
          <Card className="col-span-4">
            <CardHeader>
              <Skeleton className="h-5 w-[150px]" />
            </CardHeader>
            <CardContent>
              <Skeleton className="h-[300px] w-full" />
            </CardContent>
          </Card>
          <Card className="col-span-3">
            <CardHeader>
              <Skeleton className="h-5 w-[150px]" />
            </CardHeader>
            <CardContent>
              <Skeleton className="h-[300px] w-full" />
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  if (isError || !stats) {
    return (
      <div className="p-8 text-center">
        <h2 className="text-xl font-semibold text-destructive">Failed to load dashboard stats</h2>
        <p className="text-muted-foreground mt-2">Please try again later.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Overview</h1>
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
              {stats.calls.byStatus.completed || 0} completed calls
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
            <CardTitle className="text-sm font-medium">Call Queue</CardTitle>
            <Clock className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.queue.total}</div>
            <p className="text-xs text-muted-foreground mt-1">
              {stats.queue.pending} pending, {stats.queue.scheduled} scheduled
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
      </div>
    </div>
  );
}
