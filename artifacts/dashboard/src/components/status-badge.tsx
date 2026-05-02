import React from "react";
import { Badge } from "@/components/ui/badge";

type BadgeProps = React.ComponentProps<typeof Badge>;

export function LeadStatusBadge({ status, className, ...props }: { status: string } & BadgeProps) {
  let classes = "";

  switch (status) {
    case "pending":
      classes = "bg-slate-100 text-slate-700 hover:bg-slate-200 border-slate-200";
      break;
    case "calling":
      classes = "bg-blue-100 text-blue-700 hover:bg-blue-200 border-blue-200 animate-pulse";
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
    case "callback":
      classes = "bg-purple-100 text-purple-700 hover:bg-purple-200 border-purple-200";
      break;
    case "dnc":
      classes = "bg-gray-200 text-gray-600 hover:bg-gray-300 border-gray-300";
      break;
    default:
      classes = "bg-slate-100 text-slate-700 hover:bg-slate-200";
  }

  const label = status === "dnc" ? "DNC" : status.replace(/_/g, " ");

  return (
    <Badge variant="outline" className={`${classes} font-medium capitalize ${className ?? ""}`} {...props}>
      {label}
    </Badge>
  );
}

export function PriorityBadge({ priority, className }: { priority: number; className?: string }) {
  const map: Record<number, { label: string; classes: string }> = {
    1: { label: "Low",    classes: "bg-gray-100 text-gray-500 border-gray-200" },
    2: { label: "Normal", classes: "bg-blue-50 text-blue-500 border-blue-100" },
    3: { label: "High",   classes: "bg-amber-100 text-amber-700 border-amber-200" },
    4: { label: "Urgent", classes: "bg-red-100 text-red-700 border-red-200" },
  };
  const p = map[priority] ?? map[2];
  return (
    <Badge variant="outline" className={`${p.classes} font-medium text-[11px] py-0 px-1.5 ${className ?? ""}`}>
      {p.label}
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
    <Badge variant="outline" className={`${classes} font-medium capitalize ${className ?? ""}`} {...props}>
      {status.replace("-", " ")}
    </Badge>
  );
}
