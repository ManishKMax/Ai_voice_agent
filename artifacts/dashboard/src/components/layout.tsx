import React from "react";
import { useAuth } from "@/lib/auth";
import { Link, useLocation } from "wouter";
import {
  LayoutDashboard,
  Users,
  PhoneCall,
  LogOut,
  Activity,
  Bot,
  Settings,
  Trophy,
  ShieldCheck,
  Radio,
  CreditCard,
  BarChart2,
  UserCog,
  Headphones,
} from "lucide-react";
import { useHealthCheck } from "@workspace/api-client-react";

export function Layout({ children }: { children: React.ReactNode }) {
  const { logout } = useAuth();
  const [location] = useLocation();
  const { data: health } = useHealthCheck();

  const navItems = [
    { href: "/",              label: "Dashboard",       icon: LayoutDashboard },
    { href: "/leads",         label: "Leads",           icon: Users },
    { href: "/calls",         label: "Calls Log",       icon: PhoneCall },
    { href: "/reports",       label: "Reports",         icon: BarChart2 },
    { href: "/leaderboard",   label: "Leaderboard",     icon: Trophy },
    { href: "/agent",         label: "Agent Settings",  icon: Bot },
    { href: "/settings",      label: "Integrations",    icon: Settings },
    { href: "/kyc",           label: "KYC Review",      icon: ShieldCheck },
    { href: "/subscriptions", label: "Subscriptions",   icon: CreditCard },
    { href: "/users",         label: "Users",           icon: UserCog },
    { href: "/monitor",       label: "Live Monitor",    icon: Radio },
    { href: "/simulator",     label: "Call Simulator",  icon: Headphones },
  ];

  return (
    <div className="min-h-screen w-full flex bg-background">
      <aside className="w-64 bg-sidebar border-r border-sidebar-border flex flex-col hidden md:flex">
        <div className="h-16 flex items-center px-6 border-b border-sidebar-border">
          <div className="flex items-center gap-2 font-bold text-sidebar-foreground">
            <Activity className="h-5 w-5 text-sidebar-primary" />
            <span>AI Lead System</span>
          </div>
        </div>

        <nav className="flex-1 px-3 py-6 space-y-1 overflow-y-auto">
          {navItems.map((item) => {
            const isActive = location === item.href || (item.href !== "/" && location.startsWith(item.href));
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`flex items-center gap-3 px-3 py-2.5 rounded-md transition-colors ${
                  isActive
                    ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                    : "text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
                }`}
              >
                <item.icon className="h-4 w-4" />
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="p-4 border-t border-sidebar-border">
          <div className="mb-4 flex items-center gap-2 px-3 text-xs text-sidebar-foreground/50">
            <div className={`h-2 w-2 rounded-full ${health?.status === "ok" ? "bg-green-500" : "bg-red-500"}`}></div>
            System {health?.status === "ok" ? "Online" : "Offline"}
          </div>
          <button
            onClick={logout}
            className="flex items-center gap-3 w-full px-3 py-2.5 rounded-md text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground transition-colors"
          >
            <LogOut className="h-4 w-4" />
            Logout
          </button>
        </div>
      </aside>

      <main className="flex-1 flex flex-col min-w-0 h-screen overflow-hidden">
        {/* Mobile Header */}
        <header className="h-16 border-b bg-card flex items-center justify-between px-4 md:hidden">
          <div className="flex items-center gap-2 font-bold text-foreground">
            <Activity className="h-5 w-5 text-primary" />
            <span>AI Lead System</span>
          </div>
        </header>

        {/* Content */}
        <div className="flex-1 overflow-auto bg-background p-6">
          <div className="max-w-7xl mx-auto space-y-6">
            {children}
          </div>
        </div>
      </main>
    </div>
  );
}
