import { useUser, useClerk } from "@clerk/react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  PhoneCall, Clock, ShieldCheck, AlertTriangle,
  CheckCircle, Upload, Settings, LogOut, Zap, BarChart3
} from "lucide-react";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

async function fetchPortalMe() {
  const res = await fetch(`${basePath}/api/portal/me`, {
    credentials: "include",
  });
  if (!res.ok) throw new Error("Failed to fetch tenant info");
  return res.json();
}

export default function Dashboard() {
  const { user } = useUser();
  const { signOut } = useClerk();

  const { data, isLoading, error } = useQuery({
    queryKey: ["portal-me"],
    queryFn: fetchPortalMe,
    retry: 1,
  });

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
      {/* Header */}
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
            <button
              onClick={() => signOut({ redirectUrl: basePath + "/" })}
              className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-900 transition-colors"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-8">
        {/* Welcome */}
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-gray-900">
            Welcome back, {user?.firstName || user?.username || "there"} 👋
          </h1>
          <p className="text-gray-500 mt-1">Here's your AI calling overview</p>
        </div>

        {/* KYC Banner */}
        {tenant && tenant.kycStatus !== "approved" && (
          <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 mb-6 flex items-start gap-3">
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
              <Link
                to="/kyc"
                className="text-sm font-semibold text-amber-700 border border-amber-300 bg-amber-100 px-3 py-1.5 rounded-lg hover:bg-amber-200 transition-colors flex-shrink-0"
              >
                Verify Now
              </Link>
            )}
          </div>
        )}

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
            Could not load account info. Please refresh the page.
          </div>
        )}

        {tenant && (
          <>
            {/* Stats cards */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
              <div className="bg-white rounded-2xl border border-gray-100 p-5">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-sm font-medium text-gray-500">Calls Used (Trial)</span>
                  <PhoneCall className="h-4 w-4 text-indigo-400" />
                </div>
                <div className="text-2xl font-bold text-gray-900">
                  {tenant.trialCallsUsed}/{tenant.trialLimit}
                </div>
                <div className="text-xs text-gray-400 mt-1">trial calls</div>
              </div>

              <div className="bg-white rounded-2xl border border-gray-100 p-5">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-sm font-medium text-gray-500">Minutes Balance</span>
                  <Clock className="h-4 w-4 text-purple-400" />
                </div>
                <div className="text-2xl font-bold text-gray-900">{tenant.minutesBalance}</div>
                <div className="text-xs text-gray-400 mt-1">minutes remaining</div>
              </div>

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
                <div className="text-2xl font-bold text-gray-900">
                  ₹{pricing?.perMinuteRateRupees ?? 5}
                </div>
                <div className="text-xs text-gray-400 mt-1">per minute</div>
              </div>
            </div>

            {/* Quick actions */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <Link to="/leads" className="group bg-white border border-gray-100 rounded-2xl p-6 hover:shadow-md hover:border-indigo-200 transition-all">
                <div className="flex items-center gap-3 mb-3">
                  <div className="h-10 w-10 bg-indigo-50 rounded-xl flex items-center justify-center group-hover:bg-indigo-100 transition-colors">
                    <PhoneCall className="h-5 w-5 text-indigo-600" />
                  </div>
                  <h3 className="font-semibold text-gray-900">Start Calling</h3>
                </div>
                <p className="text-sm text-gray-500">Add leads and launch your AI calling campaign.</p>
              </Link>

              <Link to="/kyc" className="group bg-white border border-gray-100 rounded-2xl p-6 hover:shadow-md hover:border-indigo-200 transition-all">
                <div className="flex items-center gap-3 mb-3">
                  <div className="h-10 w-10 bg-green-50 rounded-xl flex items-center justify-center group-hover:bg-green-100 transition-colors">
                    <Upload className="h-5 w-5 text-green-600" />
                  </div>
                  <h3 className="font-semibold text-gray-900">Complete KYC</h3>
                </div>
                <p className="text-sm text-gray-500">Upload your Aadhaar & GST to unlock full access.</p>
              </Link>

              <Link to="/settings" className="group bg-white border border-gray-100 rounded-2xl p-6 hover:shadow-md hover:border-indigo-200 transition-all">
                <div className="flex items-center gap-3 mb-3">
                  <div className="h-10 w-10 bg-purple-50 rounded-xl flex items-center justify-center group-hover:bg-purple-100 transition-colors">
                    <Settings className="h-5 w-5 text-purple-600" />
                  </div>
                  <h3 className="font-semibold text-gray-900">Connect Calling</h3>
                </div>
                <p className="text-sm text-gray-500">Link your Twilio or Exotel account to make calls.</p>
              </Link>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
