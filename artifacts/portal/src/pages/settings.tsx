import { useEffect, useState } from "react";
import { Link } from "wouter";
import { useAuth } from "@clerk/react";
import { ArrowLeft, Phone, Save, Eye, EyeOff, CheckCircle2, AlertCircle, Loader2 } from "lucide-react";
import { portalFetch } from "@/lib/portalFetch";

type Provider = "twilio" | "exotel";
type TestState = { state: "idle" | "loading" | "ok" | "error"; message?: string };

export default function Settings() {
  const { getToken } = useAuth();
  const [provider, setProvider] = useState<Provider>("twilio");
  const [showToken, setShowToken] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [test, setTest] = useState<TestState>({ state: "idle" });

  const [twAccountSid, setTwAccountSid] = useState("");
  const [twAuthToken, setTwAuthToken] = useState("");
  const [twPhoneNumber, setTwPhoneNumber] = useState("");
  const [twAuthTokenMasked, setTwAuthTokenMasked] = useState("");

  const [exAccountSid, setExAccountSid] = useState("");
  const [exApiKey, setExApiKey] = useState("");
  const [exApiToken, setExApiToken] = useState("");
  const [exPhoneNumber, setExPhoneNumber] = useState("");
  const [exApiTokenMasked, setExApiTokenMasked] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const token = await getToken();
        const data = await portalFetch("/api/portal/credentials", token);
        setProvider((data.telephonyProvider as Provider) ?? "twilio");
        setTwAccountSid(data.twilio?.accountSid ?? "");
        setTwPhoneNumber(data.twilio?.phoneNumber ?? "");
        setTwAuthTokenMasked(data.twilio?.authTokenMasked ?? "");
        setExAccountSid(data.exotel?.accountSid ?? "");
        setExApiKey(data.exotel?.apiKey ?? "");
        setExPhoneNumber(data.exotel?.phoneNumber ?? "");
        setExApiTokenMasked(data.exotel?.apiTokenMasked ?? "");
      } catch (e) {
        setErrMsg(e instanceof Error ? e.message : "Failed to load credentials");
      } finally {
        setLoading(false);
      }
    })();
  }, [getToken]);

  async function handleTest() {
    setTest({ state: "loading" });
    try {
      const token = await getToken();
      const body = provider === "twilio"
        ? { provider, twilio: { accountSid: twAccountSid, authToken: twAuthToken } }
        : { provider, exotel: { accountSid: exAccountSid, apiKey: exApiKey, apiToken: exApiToken } };
      const res = await portalFetch("/api/portal/credentials/test", token, {
        method: "POST",
        body: JSON.stringify(body),
      });
      setTest({ state: res.success ? "ok" : "error", message: res.message });
    } catch (e) {
      setTest({ state: "error", message: e instanceof Error ? e.message : "Test failed" });
    }
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setErrMsg(null);
    try {
      const token = await getToken();
      const body: any = { telephonyProvider: provider };
      if (provider === "twilio") {
        body.twilio = {
          accountSid: twAccountSid || undefined,
          authToken: twAuthToken || undefined,
          phoneNumber: twPhoneNumber || undefined,
        };
      } else {
        body.exotel = {
          accountSid: exAccountSid || undefined,
          apiKey: exApiKey || undefined,
          apiToken: exApiToken || undefined,
          phoneNumber: exPhoneNumber || undefined,
        };
      }
      await portalFetch("/api/portal/credentials", token, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      setSavedAt(Date.now());
      setTwAuthToken("");
      setExApiToken("");
      if (provider === "twilio" && body.twilio?.authToken) setTwAuthTokenMasked("••••••••");
      if (provider === "exotel" && body.exotel?.apiToken) setExApiTokenMasked("••••••••");
      setTimeout(() => setSavedAt(null), 4000);
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
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
            Link your Twilio or Exotel account. Credentials are stored securely and used only to make calls on your behalf.
          </p>
        </div>

        {loading ? (
          <div className="bg-white border border-gray-100 rounded-2xl p-8 flex items-center justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
          </div>
        ) : (
          <>
            <div className="bg-white border border-gray-100 rounded-2xl p-6 mb-5">
              <h3 className="font-semibold text-gray-900 mb-4">Select your telephony provider</h3>
              <div className="grid grid-cols-2 gap-3">
                {[
                  { id: "twilio" as const, name: "Twilio", desc: "International — supports Indian numbers with business registration" },
                  { id: "exotel" as const, name: "Exotel", desc: "India-native — built for Indian telecom, no overseas compliance" },
                ].map((p) => (
                  <button
                    type="button"
                    key={p.id}
                    onClick={() => { setProvider(p.id); setTest({ state: "idle" }); }}
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
                    <input value={twAccountSid} onChange={(e) => setTwAccountSid(e.target.value)} type="text" placeholder="ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1.5">Auth Token {twAuthTokenMasked && !twAuthToken && <span className="text-xs text-gray-400 font-normal">(saved · enter new value to replace)</span>}</label>
                    <div className="relative">
                      <input value={twAuthToken} onChange={(e) => setTwAuthToken(e.target.value)} type={showToken ? "text" : "password"} placeholder={twAuthTokenMasked || "your_twilio_auth_token"} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent pr-10" />
                      <button type="button" onClick={() => setShowToken(!showToken)} className="absolute right-3 top-2.5 text-gray-400 hover:text-gray-600">
                        {showToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </button>
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1.5">Phone Number (E.164 format)</label>
                    <input value={twPhoneNumber} onChange={(e) => setTwPhoneNumber(e.target.value)} type="text" placeholder="+919876543210" className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent" />
                  </div>
                </>
              ) : (
                <>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1.5">Account SID</label>
                    <input value={exAccountSid} onChange={(e) => setExAccountSid(e.target.value)} type="text" placeholder="your-exotel-account-sid" className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1.5">API Key</label>
                    <input value={exApiKey} onChange={(e) => setExApiKey(e.target.value)} type="text" placeholder="your-exotel-api-key" className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1.5">API Token {exApiTokenMasked && !exApiToken && <span className="text-xs text-gray-400 font-normal">(saved · enter new value to replace)</span>}</label>
                    <div className="relative">
                      <input value={exApiToken} onChange={(e) => setExApiToken(e.target.value)} type={showToken ? "text" : "password"} placeholder={exApiTokenMasked || "your-exotel-api-token"} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent pr-10" />
                      <button type="button" onClick={() => setShowToken(!showToken)} className="absolute right-3 top-2.5 text-gray-400 hover:text-gray-600">
                        {showToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </button>
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1.5">ExoPhone Number</label>
                    <input value={exPhoneNumber} onChange={(e) => setExPhoneNumber(e.target.value)} type="text" placeholder="+919876543210" className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent" />
                  </div>
                </>
              )}

              {test.state !== "idle" && (
                <div className={`flex items-start gap-2 p-3 rounded-lg text-sm ${
                  test.state === "ok" ? "bg-emerald-50 text-emerald-700 border border-emerald-200" :
                  test.state === "error" ? "bg-red-50 text-red-700 border border-red-200" :
                  "bg-gray-50 text-gray-600 border border-gray-200"
                }`}>
                  {test.state === "loading" && <Loader2 className="h-4 w-4 animate-spin mt-0.5" />}
                  {test.state === "ok" && <CheckCircle2 className="h-4 w-4 mt-0.5" />}
                  {test.state === "error" && <AlertCircle className="h-4 w-4 mt-0.5" />}
                  <span>{test.message ?? (test.state === "loading" ? "Testing credentials…" : "")}</span>
                </div>
              )}

              {errMsg && (
                <div className="flex items-start gap-2 p-3 rounded-lg text-sm bg-red-50 text-red-700 border border-red-200">
                  <AlertCircle className="h-4 w-4 mt-0.5" />
                  <span>{errMsg}</span>
                </div>
              )}

              <div className="flex items-center gap-2 pt-2">
                <button type="submit" disabled={saving} className="flex items-center gap-2 bg-indigo-600 text-white px-5 py-2.5 rounded-xl font-semibold hover:bg-indigo-700 disabled:opacity-60 transition-colors text-sm">
                  {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                  {savedAt ? "Saved!" : "Save Credentials"}
                </button>
                <button type="button" onClick={handleTest} disabled={test.state === "loading"} className="flex items-center gap-2 border border-gray-200 text-gray-700 px-4 py-2.5 rounded-xl font-medium hover:bg-gray-50 disabled:opacity-60 transition-colors text-sm">
                  Test Credentials
                </button>
              </div>
            </form>
          </>
        )}
      </main>
    </div>
  );
}
