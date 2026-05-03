import { Link } from "wouter";
import { PhoneCall, Zap, ShieldCheck, BarChart3, Clock, Users } from "lucide-react";

export default function Landing() {
  return (
    <div className="min-h-screen bg-white">
      {/* Nav */}
      <nav className="border-b border-gray-100 bg-white/80 backdrop-blur sticky top-0 z-50">
        <div className="max-w-6xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <img src="/portal/logo.svg" alt="Logo" className="h-8 w-8" />
            <span className="font-bold text-gray-900 text-lg">VoiceAgent</span>
          </div>
          <div className="flex items-center gap-3">
            <Link to="/sign-in" className="text-sm font-medium text-gray-600 hover:text-gray-900 transition-colors">
              Sign In
            </Link>
            <Link
              to="/sign-up"
              className="text-sm font-semibold bg-indigo-600 text-white px-4 py-2 rounded-lg hover:bg-indigo-700 transition-colors"
            >
              Start Free Trial
            </Link>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section className="relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-br from-indigo-50 via-white to-purple-50 -z-10" />
        <div className="absolute top-0 right-0 w-[600px] h-[600px] bg-gradient-to-bl from-indigo-100/50 to-transparent rounded-full blur-3xl -z-10" />
        <div className="max-w-6xl mx-auto px-4 pt-20 pb-24">
          <div className="max-w-3xl">
            <div className="inline-flex items-center gap-2 bg-indigo-50 text-indigo-700 text-sm font-medium px-3 py-1.5 rounded-full mb-6">
              <Zap className="h-3.5 w-3.5" />
              AI-powered calling in Hindi & English
            </div>
            <h1 className="text-5xl font-bold text-gray-900 leading-tight mb-6">
              Let AI Call Your Leads <br />
              <span className="text-indigo-600">While You Focus on Sales</span>
            </h1>
            <p className="text-xl text-gray-500 mb-8 leading-relaxed">
              Automate outbound calls, qualify leads, and schedule follow-ups — all with a human-sounding AI agent. Start with 5 free calls, no credit card needed.
            </p>
            <div className="flex flex-col sm:flex-row items-start gap-3">
              <Link
                to="/sign-up"
                className="inline-flex items-center gap-2 bg-indigo-600 text-white px-6 py-3 rounded-xl font-semibold hover:bg-indigo-700 transition-colors shadow-lg shadow-indigo-200"
              >
                <PhoneCall className="h-4 w-4" />
                Start 5 Free Calls
              </Link>
              <Link
                to="/sign-in"
                className="inline-flex items-center gap-2 border border-gray-200 text-gray-700 px-6 py-3 rounded-xl font-semibold hover:bg-gray-50 transition-colors"
              >
                Sign In
              </Link>
            </div>
            <p className="text-sm text-gray-400 mt-4">No credit card • 5 free trial calls • KYC verification after trial</p>
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="max-w-6xl mx-auto px-4 py-20">
        <div className="text-center mb-14">
          <h2 className="text-3xl font-bold text-gray-900 mb-3">Everything you need to convert leads</h2>
          <p className="text-gray-500 text-lg">Built for Indian businesses, powered by Sarvam AI</p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {[
            {
              icon: PhoneCall,
              title: "AI Voice Calling",
              desc: "Natural conversations in Hindi, English, and regional languages with Sarvam AI's voice technology.",
              color: "bg-indigo-50 text-indigo-600",
            },
            {
              icon: BarChart3,
              title: "Lead Qualification",
              desc: "AI scores each call — Interested, Not Interested, or No Answer — with smart follow-up scheduling.",
              color: "bg-purple-50 text-purple-600",
            },
            {
              icon: Clock,
              title: "Smart Retries",
              desc: "Automatically retry unanswered calls at the lead's preferred time. Never miss a prospect.",
              color: "bg-blue-50 text-blue-600",
            },
            {
              icon: ShieldCheck,
              title: "DNC Compliance",
              desc: "Built-in Do Not Call list management. Stay compliant without any manual effort.",
              color: "bg-green-50 text-green-600",
            },
            {
              icon: Zap,
              title: "Instant Transcripts",
              desc: "Full call transcripts and AI summaries delivered after every call, ready for your CRM.",
              color: "bg-amber-50 text-amber-600",
            },
            {
              icon: Users,
              title: "Bring Your Numbers",
              desc: "Use your own Twilio or Exotel account with Indian numbers. Full control over your calling infrastructure.",
              color: "bg-rose-50 text-rose-600",
            },
          ].map((f) => (
            <div key={f.title} className="bg-white border border-gray-100 rounded-2xl p-6 hover:shadow-md transition-shadow">
              <div className={`inline-flex items-center justify-center h-10 w-10 rounded-xl ${f.color} mb-4`}>
                <f.icon className="h-5 w-5" />
              </div>
              <h3 className="font-semibold text-gray-900 mb-2">{f.title}</h3>
              <p className="text-gray-500 text-sm leading-relaxed">{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Pricing */}
      <section className="bg-gray-50 py-20">
        <div className="max-w-4xl mx-auto px-4 text-center">
          <h2 className="text-3xl font-bold text-gray-900 mb-3">Simple, transparent pricing</h2>
          <p className="text-gray-500 mb-10">One plan, no hidden fees. Pay only for the minutes you use.</p>
          <div className="bg-white rounded-3xl border border-gray-100 shadow-xl p-8 max-w-md mx-auto">
            <div className="mb-6">
              <span className="text-5xl font-bold text-gray-900">₹2,000</span>
              <span className="text-gray-500">/month</span>
            </div>
            <ul className="text-left space-y-3 mb-8">
              {[
                "400 minutes included (worth ₹2,000)",
                "₹5 per additional minute",
                "Hindi + English AI voice agent",
                "Real-time transcripts & AI summaries",
                "Twilio or Exotel integration",
                "Smart retry scheduling",
                "DNC compliance built-in",
              ].map((item) => (
                <li key={item} className="flex items-center gap-2 text-sm text-gray-700">
                  <ShieldCheck className="h-4 w-4 text-indigo-500 flex-shrink-0" />
                  {item}
                </li>
              ))}
            </ul>
            <Link
              to="/sign-up"
              className="block w-full bg-indigo-600 text-white py-3 rounded-xl font-semibold hover:bg-indigo-700 transition-colors text-center"
            >
              Start with 5 Free Calls
            </Link>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-gray-100 py-10">
        <div className="max-w-6xl mx-auto px-4 flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <img src="/portal/logo.svg" alt="Logo" className="h-6 w-6" />
            <span className="font-semibold text-gray-700">VoiceAgent</span>
          </div>
          <p className="text-sm text-gray-400">© 2025 VoiceAgent. All rights reserved.</p>
        </div>
      </footer>
    </div>
  );
}
