import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { useClerk } from "@clerk/react";
import {
  ArrowLeft, CreditCard, Zap, Clock, ShieldCheck,
  AlertTriangle, TrendingDown, CheckCircle,
} from "lucide-react";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

async function fetchPortalMe() {
  const res = await fetch(`${basePath}/api/portal/me`, { credentials: "include" });
  if (!res.ok) throw new Error("Failed to fetch");
  return res.json();
}

function minuteLevel(min: number): "empty" | "critical" | "low" | "ok" {
  if (min === 0) return "empty";
  if (min < 15) return "critical";
  if (min < 60) return "low";
  return "ok";
}

export default function Billing() {
  const { signOut } = useClerk();
  const { data, isLoading } = useQuery({
    queryKey: ["portal-me"],
    queryFn: fetchPortalMe,
    retry: 1,
  });

  const tenant = data?.tenant;
  const pricing = data?.pricing;
  const balance = tenant?.minutesBalance ?? 0;
  const level = minuteLevel(balance);
  const isApproved = tenant?.kycStatus === "approved";

  const rateRupees = pricing?.perMinuteRateRupees ?? 5;

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-100">
        <div className="max-w-3xl mx-auto px-4 py-4 flex items-center gap-3">
          <Link to="/dashboard" className="flex items-center gap-2 text-gray-500 hover:text-gray-900 text-sm font-medium transition-colors">
            <ArrowLeft className="h-4 w-4" />
            Dashboard
          </Link>
          <span className="text-gray-300">/</span>
          <span className="text-sm font-semibold text-gray-900">Billing</span>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 py-8 space-y-5">
        <div className="flex items-center gap-2 mb-6">
          <CreditCard className="h-5 w-5 text-indigo-600" />
          <h1 className="text-xl font-bold text-gray-900">Billing & Plans</h1>
        </div>

        {/* Live balance widget */}
        {isLoading ? (
          <div className="bg-white border border-gray-100 rounded-2xl p-6 animate-pulse h-28" />
        ) : tenant ? (
          <>
            {/* Low / empty balance alert */}
            {isApproved && (level === "empty" || level === "critical" || level === "low") && (
              <div className={`rounded-2xl p-4 flex items-start gap-3 border ${
                level === "empty"    ? "bg-red-50 border-red-200" :
                level === "critical" ? "bg-red-50 border-red-100" :
                                       "bg-amber-50 border-amber-200"
              }`}>
                {level === "empty" || level === "critical"
                  ? <TrendingDown className={`h-5 w-5 flex-shrink-0 mt-0.5 ${level === "empty" ? "text-red-600" : "text-red-400"}`} />
                  : <AlertTriangle className="h-5 w-5 text-amber-500 flex-shrink-0 mt-0.5" />
                }
                <div>
                  <p className={`font-semibold ${
                    level === "empty" ? "text-red-800" :
                    level === "critical" ? "text-red-700" : "text-amber-800"
                  }`}>
                    {level === "empty"
                      ? "You have no calling minutes left"
                      : level === "critical"
                      ? `Only ${balance} minute${balance !== 1 ? "s" : ""} remaining — calls may stop soon`
                      : `Balance is low — ${balance} minutes remaining`}
                  </p>
                  <p className={`text-sm mt-0.5 ${
                    level === "empty" ? "text-red-600" :
                    level === "critical" ? "text-red-500" : "text-amber-600"
                  }`}>
                    {level === "empty"
                      ? "Your campaigns are paused. Contact your administrator to add minutes."
                      : "Top up your minutes to keep your campaigns running without interruption."}
                  </p>
                </div>
              </div>
            )}

            {/* Balance card */}
            <div className={`rounded-2xl border p-6 ${
              level === "ok" ? "bg-gradient-to-br from-indigo-600 to-indigo-700 text-white border-indigo-600" :
              level === "low" ? "bg-gradient-to-br from-amber-500 to-amber-600 text-white border-amber-500" :
              "bg-gradient-to-br from-red-500 to-red-600 text-white border-red-500"
            }`}>
              <div className="flex items-start justify-between mb-4">
                <div>
                  <p className="text-white/70 text-sm font-medium">Current Balance</p>
                  <div className="flex items-end gap-2 mt-1">
                    <span className="text-4xl font-bold">{balance}</span>
                    <span className="text-white/70 text-lg mb-1">minutes</span>
                  </div>
                </div>
                <div className="bg-white/20 rounded-xl px-3 py-1.5">
                  <Clock className="h-5 w-5" />
                </div>
              </div>

              {/* Balance bar */}
              <div className="bg-white/20 rounded-full h-2 mb-3">
                <div
                  className="bg-white rounded-full h-2 transition-all duration-500"
                  style={{ width: `${Math.min(100, (balance / 300) * 100)}%` }}
                />
              </div>

              <div className="flex items-center gap-4 text-sm text-white/80">
                <span className="flex items-center gap-1.5">
                  <Zap className="h-3.5 w-3.5" />
                  ₹{rateRupees}/min
                </span>
                {isApproved
                  ? <span className="flex items-center gap-1.5"><CheckCircle className="h-3.5 w-3.5" />KYC verified</span>
                  : <span className="flex items-center gap-1.5"><ShieldCheck className="h-3.5 w-3.5" />KYC required to go live</span>
                }
              </div>
            </div>
          </>
        ) : null}

        {/* Current plan */}
        <div className="bg-white border border-gray-100 rounded-2xl p-6">
          <div className="flex items-start justify-between mb-4">
            <div>
              <p className="text-gray-500 text-sm font-medium">Current Plan</p>
              <h2 className="text-2xl font-bold text-gray-900 mt-1">
                {isApproved ? "Pro" : "Trial"}
              </h2>
            </div>
            <div className="bg-indigo-50 text-indigo-700 rounded-xl px-3 py-1.5 text-sm font-semibold">
              {isApproved ? "Active" : "Free"}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-4 text-sm text-gray-500">
            <span className="flex items-center gap-1.5">
              <Clock className="h-3.5 w-3.5" />
              {isApproved ? `${pricing?.monthlyMinutesQuota ?? 400} minutes/month included` : "5 trial calls included"}
            </span>
            <span className="flex items-center gap-1.5">
              <ShieldCheck className="h-3.5 w-3.5" />
              {isApproved ? "KYC verified" : "KYC required to upgrade"}
            </span>
          </div>
        </div>

        {/* Upgrade plan — only shown in trial */}
        {!isApproved && (
          <div className="bg-white border border-gray-100 rounded-2xl p-6">
            <div className="flex items-start justify-between mb-5">
              <div>
                <h3 className="font-bold text-gray-900 text-lg">Pro Plan</h3>
                <p className="text-gray-500 text-sm mt-0.5">Everything you need to scale your calling</p>
              </div>
              <div className="text-right">
                <span className="text-3xl font-bold text-gray-900">₹{pricing?.monthlyPlanCostRupees ?? 2000}</span>
                <span className="text-gray-500 text-sm">/month</span>
              </div>
            </div>
            <ul className="space-y-2.5 mb-6">
              {[
                `${pricing?.monthlyMinutesQuota ?? 400} minutes/month included`,
                `₹${rateRupees} per additional minute`,
                "Hindi + English AI voice",
                "Full call transcripts & AI analysis",
                "Smart retry scheduling",
                "Priority support",
              ].map((f) => (
                <li key={f} className="flex items-center gap-2 text-sm text-gray-700">
                  <Zap className="h-3.5 w-3.5 text-indigo-500 flex-shrink-0" />
                  {f}
                </li>
              ))}
            </ul>
            <button className="w-full bg-indigo-600 text-white py-3 rounded-xl font-semibold hover:bg-indigo-700 transition-colors flex items-center justify-center gap-2">
              <CreditCard className="h-4 w-4" />
              Subscribe via Razorpay
            </button>
            <p className="text-center text-xs text-gray-400 mt-3">
              <Link to="/kyc" className="underline hover:text-gray-600">Complete KYC</Link> first to activate your plan.
            </p>
          </div>
        )}

        {/* Top-up */}
        <div className="bg-white border border-gray-100 rounded-2xl p-6">
          <h3 className="font-semibold text-gray-900 mb-1">Buy Additional Minutes</h3>
          <p className="text-sm text-gray-500 mb-4">
            Top up your balance anytime at ₹{rateRupees}/minute
            {balance > 0 && <span className="ml-1 text-gray-400">(current: {balance} min)</span>}
          </p>
          <div className="grid grid-cols-3 gap-3 mb-4">
            {[
              { minutes: 100, price: 100 * rateRupees },
              { minutes: 200, price: 200 * rateRupees },
              { minutes: 500, price: 500 * rateRupees },
            ].map((pack) => (
              <button
                key={pack.minutes}
                className={`border rounded-xl p-3 text-center hover:border-indigo-300 hover:bg-indigo-50 transition-colors ${
                  level !== "ok" && pack.minutes === 100 ? "border-indigo-300 ring-2 ring-indigo-100" : "border-gray-200"
                }`}
              >
                <div className="font-bold text-gray-900 text-lg">{pack.minutes}</div>
                <div className="text-xs text-gray-500">minutes</div>
                <div className="text-sm font-semibold text-indigo-600 mt-1">₹{pack.price}</div>
              </button>
            ))}
          </div>
          <button className="w-full border border-indigo-200 text-indigo-600 py-2.5 rounded-xl font-semibold hover:bg-indigo-50 transition-colors text-sm">
            Purchase Minutes
          </button>
          <p className="text-center text-xs text-gray-400 mt-2">
            Requires active Pro subscription · Razorpay payment coming soon
          </p>
        </div>
      </main>
    </div>
  );
}
