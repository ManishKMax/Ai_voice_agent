import React from "react";
import { Badge } from "@/components/ui/badge";

type BadgeProps = React.ComponentProps<typeof Badge>;

export function LeadStatusBadge({ status, className, ...props }: { status: string } & BadgeProps) {
  let variant: "default" | "secondary" | "destructive" | "outline" = "default";
  let classes = "";

  switch (status) {
    case "pending":
      classes = "bg-slate-100 text-slate-700 hover:bg-slate-200 border-slate-200";
      break;
    case "calling":
      classes = "bg-blue-100 text-blue-700 hover:bg-blue-200 border-blue-200";
      break;
    case "completed":
      classes = "bg-green-100 text-green-700 hover:bg-green-200 border-green-200";
      break;
    case "interested":
      classes = "bg-emerald-100 text-emerald-700 hover:bg-emerald-200 border-emerald-200";
      break;
    case "not_interested":
      classes = "bg-red-100 text-red-700 hover:bg-red-200 border-red-200";
      break;
    case "no_response":
      classes = "bg-orange-100 text-orange-700 hover:bg-orange-200 border-orange-200";
      break;
    default:
      classes = "bg-slate-100 text-slate-700 hover:bg-slate-200";
  }

  return (
    <Badge variant="outline" className={`${classes} font-medium capitalize ${className}`} {...props}>
      {status.replace("_", " ")}
    </Badge>
  );
}

export function CallStatusBadge({ status, className, ...props }: { status: string } & BadgeProps) {
  let classes = "";

  switch (status) {
    case "initiated":
    case "ringing":
      classes = "bg-blue-100 text-blue-700 hover:bg-blue-200 border-blue-200";
      break;
    case "answered":
    case "completed":
      classes = "bg-green-100 text-green-700 hover:bg-green-200 border-green-200";
      break;
    case "no-answer":
    case "busy":
    case "failed":
      classes = "bg-red-100 text-red-700 hover:bg-red-200 border-red-200";
      break;
    default:
      classes = "bg-slate-100 text-slate-700 hover:bg-slate-200";
  }

  return (
    <Badge variant="outline" className={`${classes} font-medium capitalize ${className}`} {...props}>
      {status.replace("-", " ")}
    </Badge>
  );
}
