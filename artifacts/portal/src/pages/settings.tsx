import { useState } from "react";
import { Link } from "wouter";
import { ArrowLeft, Phone, Save, Eye, EyeOff } from "lucide-react";

export default function Settings() {
  const [provider, setProvider] = useState<"twilio" | "exotel">("twilio");
  const [showToken, setShowToken] = useState(false);
  const [saved, setSaved] = useState(false);

  function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaved(true);
    setTimeout(() => setSaved(false), 3000);
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-100">
        <div className="max-w-3xl mx-auto px-4 py-4 flex items-center gap-3">
          <Link to="/dashboard" className="flex items-center gap-2 text-gray-500 hover:text-gray-900 text-sm font-medium transition-colors">
            <ArrowLeft className="h-4 w-4" />
            Dashboard
          </Link>
          <span className="text-gray-300">/</span>
          <span className="text-sm font-semibold text-gray-900">Telephony Settings</span>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 py-8">
        <div className="mb-8">
          <div className="flex items-center gap-2 mb-2">
            <Phone className="h-5 w-5 text-indigo-600" />
            <h1 className="text-xl font-bold text-gray-900">Connect Your Calling Account</h1>
          </div>
          <p className="text-gray-500 text-sm">
            Link your Twilio or Exotel account. Your credentials are stored securely and used only to make calls on your behalf.
          </p>
        </div>

        {/* Provider toggle */}
        <div className="bg-white border border-gray-100 rounded-2xl p-6 mb-5">
          <h3 className="font-semibold text-gray-900 mb-4">Select your telephony provider</h3>
          <div className="grid grid-cols-2 gap-3">
            {[
              { id: "twilio", name: "Twilio", desc: "International — supports Indian numbers with business registration" },
              { id: "exotel", name: "Exotel", desc: "India-native — built for Indian telecom, no overseas compliance" },
            ].map((p) => (
              <button
                key={p.id}
                onClick={() => setProvider(p.id as "twilio" | "exotel")}
                className={`text-left p-4 rounded-xl border-2 transition-all ${provider === p.id ? "border-indigo-500 bg-indigo-50" : "border-gray-100 hover:border-gray-200"}`}
              >
                <div className={`font-semibold text-sm mb-1 ${provider === p.id ? "text-indigo-700" : "text-gray-700"}`}>{p.name}</div>
                <div className="text-xs text-gray-500">{p.desc}</div>
              </button>
            ))}
          </div>
        </div>

        <form onSubmit={handleSave} className="bg-white border border-gray-100 rounded-2xl p-6 space-y-4">
          <h3 className="font-semibold text-gray-900">{provider === "twilio" ? "Twilio" : "Exotel"} credentials</h3>

          {provider === "twilio" ? (
            <>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">Account SID</label>
                <input type="text" placeholder="ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">Auth Token</label>
                <div className="relative">
                  <input type={showToken ? "text" : "password"} placeholder="••••••••••••••••••••" className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent pr-10" />
                  <button type="button" onClick={() => setShowToken(!showToken)} className="absolute right-3 top-2.5 text-gray-400 hover:text-gray-600">
                    {showToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">Phone Number (E.164 format)</label>
                <input type="text" placeholder="+919876543210" className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent" />
              </div>
            </>
          ) : (
            <>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">Account SID</label>
                <input type="text" placeholder="your-exotel-account-sid" className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">API Key</label>
                <input type="text" placeholder="your-exotel-api-key" className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">API Token</label>
                <div className="relative">
                  <input type={showToken ? "text" : "password"} placeholder="••••••••••••••••" className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent pr-10" />
                  <button type="button" onClick={() => setShowToken(!showToken)} className="absolute right-3 top-2.5 text-gray-400 hover:text-gray-600">
                    {showToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">ExoPhone Number</label>
                <input type="text" placeholder="+919876543210" className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent" />
              </div>
            </>
          )}

          <button type="submit" className="flex items-center gap-2 bg-indigo-600 text-white px-5 py-2.5 rounded-xl font-semibold hover:bg-indigo-700 transition-colors text-sm">
            <Save className="h-4 w-4" />
            {saved ? "Saved!" : "Save Credentials"}
          </button>
        </form>
      </main>
    </div>
  );
}
