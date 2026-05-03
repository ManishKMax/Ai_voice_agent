import { Link } from "wouter";
import { ArrowLeft, CreditCard, Zap, Clock, ShieldCheck } from "lucide-react";

export default function Billing() {
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

      <main className="max-w-3xl mx-auto px-4 py-8">
        <div className="mb-8">
          <div className="flex items-center gap-2 mb-2">
            <CreditCard className="h-5 w-5 text-indigo-600" />
            <h1 className="text-xl font-bold text-gray-900">Billing & Plans</h1>
          </div>
          <p className="text-gray-500 text-sm">Manage your subscription and purchase additional minutes</p>
        </div>

        {/* Current plan */}
        <div className="bg-gradient-to-br from-indigo-600 to-indigo-700 rounded-2xl p-6 text-white mb-5">
          <div className="flex items-start justify-between mb-4">
            <div>
              <p className="text-indigo-200 text-sm font-medium">Current Plan</p>
              <h2 className="text-2xl font-bold mt-1">Trial</h2>
            </div>
            <div className="bg-white/20 rounded-xl px-3 py-1.5">
              <span className="text-sm font-semibold">Free</span>
            </div>
          </div>
          <div className="flex items-center gap-4 text-sm text-indigo-100">
            <span className="flex items-center gap-1.5"><Clock className="h-3.5 w-3.5" />5 trial calls included</span>
            <span className="flex items-center gap-1.5"><ShieldCheck className="h-3.5 w-3.5" />KYC required to upgrade</span>
          </div>
        </div>

        {/* Upgrade plan */}
        <div className="bg-white border border-gray-100 rounded-2xl p-6 mb-5">
          <div className="flex items-start justify-between mb-5">
            <div>
              <h3 className="font-bold text-gray-900 text-lg">Pro Plan</h3>
              <p className="text-gray-500 text-sm mt-0.5">Everything you need to scale your calling</p>
            </div>
            <div className="text-right">
              <span className="text-3xl font-bold text-gray-900">₹2,000</span>
              <span className="text-gray-500 text-sm">/month</span>
            </div>
          </div>
          <ul className="space-y-2.5 mb-6">
            {[
              "400 minutes/month included",
              "₹5 per additional minute",
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
          <p className="text-center text-xs text-gray-400 mt-3">Razorpay payment integration coming soon. KYC verification required first.</p>
        </div>

        {/* Top-up */}
        <div className="bg-white border border-gray-100 rounded-2xl p-6">
          <h3 className="font-semibold text-gray-900 mb-1">Buy Additional Minutes</h3>
          <p className="text-sm text-gray-500 mb-4">Top up your balance anytime at ₹5/minute</p>
          <div className="grid grid-cols-3 gap-3 mb-4">
            {[
              { minutes: 100, price: 500 },
              { minutes: 200, price: 1000 },
              { minutes: 500, price: 2500 },
            ].map((pack) => (
              <button
                key={pack.minutes}
                className="border border-gray-200 rounded-xl p-3 text-center hover:border-indigo-300 hover:bg-indigo-50 transition-colors"
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
          <p className="text-center text-xs text-gray-400 mt-2">Requires active Pro subscription · Razorpay payment</p>
        </div>
      </main>
    </div>
  );
}
