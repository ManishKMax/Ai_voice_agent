import { useEffect } from "react";
import { useUser, useClerk, useAuth } from "@clerk/react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  PhoneCall, Clock, ShieldCheck, AlertTriangle,
  CheckCircle, Upload, Settings, LogOut, Zap, BarChart3,
  CreditCard, TrendingDown,
} from "lucide-react";
import { portalFetch } from "@/lib/portalFetch";

function minuteLevel(min: number): "empty" | "critical" | "low" | "ok" {
  if (min === 0) return "empty";
  if (min < 15) return "critical";
  if (min < 60) return "low";
  return "ok";
}

const levelStyles = {
  empty: { bar: "bg-red-500", card: "border-red-200 bg-red-50", text: "text-red-700", label: "Out of minutes" },
  critical: { bar: "bg-red-400", card: "border-red-100 bg-red-50/60", text: "text-red-600", label: "Critically low" },
  low: { bar: "bg-amber-400", card: "border-amber-100 bg-amber-50/40", text: "text-amber-600", label: "Low balance" },
  ok: { bar: "bg-indigo-500", card: "border-gray-100 bg-white", text: "text-gray-900", label: "" },
};

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

export default function Dashboard() {
  const { isLoaded, user } = useUser();
  const { signOut } = useClerk();
  const { getToken } = useAuth();

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["portal-me"],
    queryFn: async () => {
      const token = await getToken();
      return portalFetch("/api/portal/me", token);
    },
    enabled: isLoaded && !!user,
    retry: false,
    staleTime: 10_000,
  });

  useEffect(() => {
    if (isLoaded && user) {
      refetch();
    }
  }, [isLoaded, user]);

  const tenant = data?.tenant;
  const pricing = data?.pricing;

  const kycStatusColor: Record<string, string> = {
    pending: "text-amber-600 bg-amber-50",
    submitted: "text-blue-600 bg-blue-50",
    approved: "text-green-600 bg-green-50",
    rejected: "text-red-600 bg-red-50",
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-100">
        <div className="max-w-6xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <img src={`${basePath}/logo.svg`} alt="Logo" className="h-8 w-8" />
            <span className="font-bold text-gray-900">VoiceAgent</span>
          </div>
          <nav className="hidden md:flex items-center gap-6">
            {[
              { to: "/dashboard", label: "Dashboard" },
              { to: "/leads", label: "Leads" },
              { to: "/billing", label: "Billing" },
              { to: "/usage", label: "Usage" },
              { to: "/kyc", label: "KYC" },
              { to: "/settings", label: "Settings" },
            ].map((n) => (
              <Link key={n.to} to={n.to} className="text-sm text-gray-600 hover:text-indigo-600 font-medium transition-colors">
                {n.label}
              </Link>
            ))}
          </nav>
          <div className="flex items-center gap-3">
            <span className="text-sm text-gray-500">{user?.primaryEmailAddress?.emailAddress}</span>
            <button onClick={() => signOut({ redirectUrl: basePath + "/" })} className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-900 transition-colors">
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-8">
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-gray-900">Welcome back, {user?.firstName || user?.username || "there"} 👋</h1>
          <p className="text-gray-500 mt-1">Here's your AI calling overview</p>
        </div>

        {tenant && tenant.kycStatus !== "approved" && (
          <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 mb-4 flex items-start gap-3">
            <AlertTriangle className="h-5 w-5 text-amber-500 flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="font-semibold text-amber-800">
                {tenant.kycStatus === "pending"
                  ? `Trial Mode — ${tenant.trialCallsRemaining} of ${tenant.trialLimit} free calls remaining`
                  : tenant.kycStatus === "submitted"
                  ? "KYC submitted — under review (1-2 business days)"
                  : "KYC rejected — please re-upload your documents"}
              </p>
              <p className="text-sm text-amber-600 mt-0.5">
                {tenant.kycStatus === "pending"
                  ? "Upload your Aadhaar card and GST certificate to unlock unlimited calling."
                  : tenant.kycStatus === "rejected"
                  ? "Check your documents and re-upload to continue calling."
                  : "You'll be notified once verification is complete."}
              </p>
            </div>
            {(tenant.kycStatus === "pending" || tenant.kycStatus === "rejected") && (
              <Link to="/kyc" className="text-sm font-semibold text-amber-700 border border-amber-300 bg-amber-100 px-3 py-1.5 rounded-lg hover:bg-amber-200 transition-colors flex-shrink-0">Verify Now</Link>
            )}
          </div>
        )}

        {tenant && tenant.kycStatus === "approved" && (() => {
          const level = minuteLevel(tenant.minutesBalance);
          if (level === "ok") return null;
          const isEmpty = level === "empty";
          const isCritical = level === "critical";
          return (
            <div className={`rounded-2xl p-4 mb-4 flex items-start gap-3 border ${isEmpty || isCritical ? "bg-red-50 border-red-200" : "bg-amber-50 border-amber-200"}`}>
              {isEmpty || isCritical
                ? <TrendingDown className={`h-5 w-5 flex-shrink-0 mt-0.5 ${isEmpty ? "text-red-600" : "text-red-400"}`} />
                : <AlertTriangle className="h-5 w-5 text-amber-500 flex-shrink-0 mt-0.5" />}
              <div className="flex-1">
                <p className={`font-semibold ${isEmpty ? "text-red-800" : isCritical ? "text-red-700" : "text-amber-800"}`}>
                  {isEmpty
                    ? "No calling minutes remaining — campaigns are paused"
                    : isCritical
                    ? `Only ${tenant.minutesBalance} minute${tenant.minutesBalance !== 1 ? "s" : ""} left — calls may stop soon`
                    : `Balance running low — ${tenant.minutesBalance} minutes remaining`}
                </p>
                <p className={`text-sm mt-0.5 ${isEmpty ? "text-red-600" : isCritical ? "text-red-500" : "text-amber-600"}`}>
                  Contact your administrator to add minutes, or visit Billing to top up.
                </p>
              </div>
              <Link to="/billing" className={`text-sm font-semibold px-3 py-1.5 rounded-lg transition-colors flex-shrink-0 border ${isEmpty || isCritical ? "text-red-700 border-red-300 bg-red-100 hover:bg-red-200" : "text-amber-700 border-amber-300 bg-amber-100 hover:bg-amber-200"}`}>
                View Billing
              </Link>
            </div>
          );
        })()}

        {isLoading && (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
            {[1, 2, 3].map((i) => (
              <div key={i} className="bg-white rounded-2xl border border-gray-100 p-6 animate-pulse">
                <div className="h-4 bg-gray-100 rounded w-24 mb-3" />
                <div className="h-8 bg-gray-100 rounded w-16" />
              </div>
            ))}
          </div>
        )}

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-2xl p-4 mb-6 text-red-700 text-sm">
            {String((error as Error)?.message ?? "Failed to load account info")}
          </div>
        )}

        {tenant && (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
              <div className="bg-white rounded-2xl border border-gray-100 p-5">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-sm font-medium text-gray-500">Calls Used (Trial)</span>
                  <PhoneCall className="h-4 w-4 text-indigo-400" />
                </div>
                <div className="text-2xl font-bold text-gray-900">{tenant.trialCallsUsed}/{tenant.trialLimit}</div>
                <div className="text-xs text-gray-400 mt-1">trial calls</div>
              </div>

              {(() => {
                const level = minuteLevel(tenant.minutesBalance);
                const s = levelStyles[level];
                const pct = Math.min(100, (tenant.minutesBalance / 300) * 100);
                return (
                  <Link to="/billing" className={`rounded-2xl border p-5 block hover:shadow-sm transition-shadow ${s.card}`}>
                    <div className="flex items-center justify-between mb-3">
                      <span className="text-sm font-medium text-gray-500">Minutes Balance</span>
                      <Clock className={`h-4 w-4 ${level === "ok" ? "text-purple-400" : level === "low" ? "text-amber-400" : "text-red-400"}`} />
                    </div>
                    <div className={`text-2xl font-bold ${s.text}`}>{tenant.minutesBalance}</div>
                    <div className="mt-2 bg-gray-200 rounded-full h-1.5">
                      <div className={`${s.bar} rounded-full h-1.5 transition-all`} style={{ width: `${pct}%` }} />
                    </div>
                    <div className="flex items-center justify-between mt-1">
                      <div className="text-xs text-gray-400">minutes remaining</div>
                      {s.label && <div className={`text-xs font-medium ${s.text}`}>{s.label}</div>}
                    </div>
                  </Link>
                );
              })()}

              <div className="bg-white rounded-2xl border border-gray-100 p-5">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-sm font-medium text-gray-500">KYC Status</span>
                  <ShieldCheck className="h-4 w-4 text-green-400" />
                </div>
                <div className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-lg text-sm font-medium ${kycStatusColor[tenant.kycStatus] || "text-gray-600 bg-gray-50"}`}>
                  {tenant.kycStatus === "approved" && <CheckCircle className="h-3.5 w-3.5" />}
                  {tenant.kycStatus.charAt(0).toUpperCase() + tenant.kycStatus.slice(1)}
                </div>
              </div>

              <div className="bg-white rounded-2xl border border-gray-100 p-5">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-sm font-medium text-gray-500">Per Minute Rate</span>
                  <BarChart3 className="h-4 w-4 text-blue-400" />
                </div>
                <div className="text-2xl font-bold text-gray-900">₹{pricing?.perMinuteRateRupees ?? 5}</div>
                <div className="text-xs text-gray-400 mt-1">per minute</div>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <Link to="/kyc" className="bg-white rounded-2xl border border-gray-100 p-5 hover:shadow-sm transition-shadow flex items-start gap-4">
                <div className="h-10 w-10 bg-indigo-50 rounded-xl flex items-center justify-center flex-shrink-0">
                  <ShieldCheck className="h-5 w-5 text-indigo-500" />
                </div>
                <div>
                  <div className="font-semibold text-gray-900 text-sm">KYC Verification</div>
                  <div className="text-xs text-gray-500 mt-0.5">Upload documents to unlock full access</div>
                </div>
              </Link>
              <Link to="/billing" className="bg-white rounded-2xl border border-gray-100 p-5 hover:shadow-sm transition-shadow flex items-start gap-4">
                <div className="h-10 w-10 bg-purple-50 rounded-xl flex items-center justify-center flex-shrink-0">
                  <CreditCard className="h-5 w-5 text-purple-500" />
                </div>
                <div>
                  <div className="font-semibold text-gray-900 text-sm">Billing</div>
                  <div className="text-xs text-gray-500 mt-0.5">Manage minutes and view usage</div>
                </div>
              </Link>
              <Link to="/settings" className="bg-white rounded-2xl border border-gray-100 p-5 hover:shadow-sm transition-shadow flex items-start gap-4">
                <div className="h-10 w-10 bg-green-50 rounded-xl flex items-center justify-center flex-shrink-0">
                  <Settings className="h-5 w-5 text-green-500" />
                </div>
                <div>
                  <div className="font-semibold text-gray-900 text-sm">Telephony Settings</div>
                  <div className="text-xs text-gray-500 mt-0.5">Connect your Twilio or Exotel account</div>
                </div>
              </Link>
            </div>
          </>
        )}

        {!isLoading && !tenant && !error && (
          <div className="bg-white rounded-2xl border border-gray-100 p-12 text-center">
            <div className="h-14 w-14 bg-indigo-50 rounded-2xl flex items-center justify-center mx-auto mb-4">
              <Zap className="h-7 w-7 text-indigo-400" />
            </div>
            <h3 className="font-semibold text-gray-900 mb-2">Setting up your account…</h3>
            <p className="text-sm text-gray-500">Just a moment while we load your profile.</p>
          </div>
        )}
      </main>
    </div>
  );
}
