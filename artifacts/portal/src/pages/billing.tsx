import { Link } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth, useClerk } from "@clerk/react";
import {
  ArrowLeft, CreditCard, Zap, Clock, ShieldCheck,
  AlertTriangle, TrendingDown, CheckCircle,
} from "lucide-react";
import { useCallStatusSSE } from "@/hooks/useCallStatusSSE";
import { portalFetch } from "@/lib/portalFetch";

function minuteLevel(min: number): "empty" | "critical" | "low" | "ok" {
  if (min === 0) return "empty";
  if (min < 15) return "critical";
  if (min < 60) return "low";
  return "ok";
}

export default function Billing() {
  const { signOut } = useClerk();
  const { getToken } = useAuth();
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["portal-me"],
    queryFn: async () => {
      const token = await getToken();
      return portalFetch("/api/portal/me", token);
    },
    retry: false,
    staleTime: 10_000,
  });

  useCallStatusSSE((type) => {
    if (type === "call.ended" || type === "call.status") {
      queryClient.invalidateQueries({ queryKey: ["portal-me"] });
    }
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

        {isLoading ? (
          <div className="bg-white border border-gray-100 rounded-2xl p-6 animate-pulse h-28" />
        ) : tenant ? (
          <>
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
