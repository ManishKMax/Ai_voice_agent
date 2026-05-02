import React, { useState, useEffect } from "react";
import { useToast } from "@/hooks/use-toast";
import {
  CheckCircle2,
  XCircle,
  Loader2,
  Eye,
  EyeOff,
  ExternalLink,
  ChevronDown,
  ChevronUp,
  PhoneCall,
  Brain,
  Shield,
  Webhook,
  Copy,
  RefreshCw,
  Clock,
  RotateCcw,
} from "lucide-react";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

async function apiFetch(path: string, options?: RequestInit) {
  const token = localStorage.getItem("auth_token");
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options?.headers ?? {}),
    },
  });
  return res.json();
}

type ConnectionStatus = "idle" | "testing" | "ok" | "error";

interface SettingsData {
  twilioAccountSid: string;
  twilioAuthToken: string;
  twilioPhoneNumber: string;
  sarvamApiKey: string;
  callRetries: number;
  callHoursStart: number;
  callHoursEnd: number;
  twilioConnected: boolean;
  sarvamConnected: boolean;
}

interface WebhookInfo {
  baseUrl: string;
  voiceWebhookUrl: string;
  statusCallbackUrl: string;
}

function StatusBadge({ status, connected }: { status: ConnectionStatus; connected?: boolean }) {
  if (status === "testing") return (
    <span className="flex items-center gap-1.5 text-sm text-yellow-600">
      <Loader2 className="h-4 w-4 animate-spin" /> Testing...
    </span>
  );
  if (status === "ok") return (
    <span className="flex items-center gap-1.5 text-sm text-green-600 font-medium">
      <CheckCircle2 className="h-4 w-4" /> Connected
    </span>
  );
  if (status === "error") return (
    <span className="flex items-center gap-1.5 text-sm text-red-500 font-medium">
      <XCircle className="h-4 w-4" /> Failed
    </span>
  );
  if (connected) return (
    <span className="flex items-center gap-1.5 text-sm text-green-600 font-medium">
      <CheckCircle2 className="h-4 w-4" /> Saved
    </span>
  );
  return (
    <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
      <XCircle className="h-4 w-4" /> Not configured
    </span>
  );
}

function SecretInput({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="space-y-1.5">
      <label className="text-sm font-medium text-foreground">{label}</label>
      <div className="relative">
        <input
          type={show ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder ?? "Enter value…"}
          className="w-full rounded-md border border-input bg-background px-3 py-2 pr-10 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring placeholder:text-muted-foreground"
        />
        <button
          type="button"
          onClick={() => setShow((s) => !s)}
          className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          tabIndex={-1}
        >
          {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>
      </div>
    </div>
  );
}

function SetupGuide({
  title,
  steps,
  link,
  linkLabel,
}: {
  title: string;
  steps: string[];
  link: string;
  linkLabel: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-md border border-border bg-muted/30">
      <button
        className="flex w-full items-center justify-between px-4 py-2.5 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
        onClick={() => setOpen((o) => !o)}
      >
        <span>📖 Setup guide — {title}</span>
        {open ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
      </button>
      {open && (
        <div className="border-t border-border px-4 pb-4 pt-3 space-y-2">
          <ol className="space-y-1.5 text-sm text-muted-foreground list-decimal list-inside">
            {steps.map((s, i) => <li key={i}>{s}</li>)}
          </ol>
          <a
            href={link}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline mt-2"
          >
            {linkLabel} <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </div>
      )}
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
      className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
      title="Copy"
    >
      {copied ? <CheckCircle2 className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

export default function Settings() {
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [form, setForm] = useState({
    twilioAccountSid: "",
    twilioAuthToken: "",
    twilioPhoneNumber: "",
    sarvamApiKey: "",
    callRetries: 1,
    callHoursStart: 9,
    callHoursEnd: 20,
  });

  const [currentStatus, setCurrentStatus] = useState<{
    twilioConnected: boolean;
    sarvamConnected: boolean;
  }>({ twilioConnected: false, sarvamConnected: false });

  const [twilioStatus, setTwilioStatus] = useState<ConnectionStatus>("idle");
  const [sarvamStatus, setSarvamStatus] = useState<ConnectionStatus>("idle");
  const [twilioMessage, setTwilioMessage] = useState("");
  const [sarvamMessage, setSarvamMessage] = useState("");

  const [webhookInfo, setWebhookInfo] = useState<WebhookInfo | null>(null);
  const [twilioNumbers, setTwilioNumbers] = useState<{ phoneNumber: string; friendlyName: string }[]>([]);

  useEffect(() => {
    Promise.all([
      apiFetch("/api/settings"),
      apiFetch("/api/settings/webhook-info"),
    ]).then(([settingsRes, webhookRes]) => {
      if (settingsRes.success) {
        const d: SettingsData = settingsRes.data;
        setCurrentStatus({ twilioConnected: d.twilioConnected, sarvamConnected: d.sarvamConnected });
        setForm({
          twilioAccountSid: "",
          twilioAuthToken: "",
          twilioPhoneNumber: d.twilioPhoneNumber ?? "",
          sarvamApiKey: "",
          callRetries: d.callRetries ?? 1,
          callHoursStart: d.callHoursStart ?? 9,
          callHoursEnd: d.callHoursEnd ?? 20,
        });
      }
      if (webhookRes.success) setWebhookInfo(webhookRes.data);
      setLoading(false);
    });
  }, []);

  function setField<K extends keyof typeof form>(key: K, val: typeof form[K]) {
    setForm((f) => ({ ...f, [key]: val }));
  }

  async function handleSave() {
    setSaving(true);
    try {
      const payload: Record<string, unknown> = {
        callRetries: form.callRetries,
        callHoursStart: form.callHoursStart,
        callHoursEnd: form.callHoursEnd,
      };
      if (form.twilioAccountSid) payload.twilioAccountSid = form.twilioAccountSid;
      if (form.twilioAuthToken)  payload.twilioAuthToken  = form.twilioAuthToken;
      if (form.twilioPhoneNumber) payload.twilioPhoneNumber = form.twilioPhoneNumber;
      if (form.sarvamApiKey)     payload.sarvamApiKey     = form.sarvamApiKey;

      const res = await apiFetch("/api/settings", {
        method: "PATCH",
        body: JSON.stringify(payload),
      });

      if (res.success) {
        setCurrentStatus({ twilioConnected: res.data.twilioConnected, sarvamConnected: res.data.sarvamConnected });
        setForm((f) => ({ ...f, twilioAccountSid: "", twilioAuthToken: "", sarvamApiKey: "" }));
        toast({ title: "Settings saved", description: "Credentials are now active for all new calls." });
      } else {
        toast({ title: "Save failed", description: res.message ?? "Unknown error", variant: "destructive" });
      }
    } finally {
      setSaving(false);
    }
  }

  async function handleTestTwilio() {
    setTwilioStatus("testing");
    setTwilioMessage("");
    const res = await apiFetch("/api/settings/test-twilio", {
      method: "POST",
      body: JSON.stringify({
        twilioAccountSid: form.twilioAccountSid || undefined,
        twilioAuthToken: form.twilioAuthToken || undefined,
      }),
    });
    setTwilioStatus(res.success ? "ok" : "error");
    setTwilioMessage(res.message ?? "");
  }

  async function handleTestSarvam() {
    setSarvamStatus("testing");
    setSarvamMessage("");
    const res = await apiFetch("/api/settings/test-sarvam", {
      method: "POST",
      body: JSON.stringify({ sarvamApiKey: form.sarvamApiKey || undefined }),
    });
    setSarvamStatus(res.success ? "ok" : "error");
    setSarvamMessage(res.message ?? "");
  }

  async function loadTwilioNumbers() {
    const res = await apiFetch("/api/settings/twilio-numbers");
    if (res.success) setTwilioNumbers(res.data);
    else toast({ title: "Could not fetch numbers", description: res.message, variant: "destructive" });
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-8 max-w-3xl">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Integrations & Settings</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Configure your API credentials. Changes take effect immediately — no server restart needed.
          </p>
        </div>
        <button
          onClick={handleSave}
          disabled={saving}
          className="flex items-center gap-2 bg-primary text-primary-foreground px-4 py-2 rounded-md text-sm font-medium hover:bg-primary/90 disabled:opacity-60 transition-colors"
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          Save Changes
        </button>
      </div>

      {/* Twilio Section */}
      <section className="rounded-xl border border-border bg-card shadow-sm overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border bg-card">
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-lg bg-red-50 dark:bg-red-950 flex items-center justify-center">
              <PhoneCall className="h-4 w-4 text-red-600" />
            </div>
            <div>
              <h2 className="font-semibold text-foreground">Twilio</h2>
              <p className="text-xs text-muted-foreground">Voice calls & SMS</p>
            </div>
          </div>
          <StatusBadge status={twilioStatus} connected={currentStatus.twilioConnected} />
        </div>

        <div className="p-6 space-y-5">
          <SetupGuide
            title="How to get Twilio credentials"
            link="https://www.twilio.com/try-twilio"
            linkLabel="Create a free Twilio account"
            steps={[
              "Go to twilio.com/try-twilio and sign up for a free account",
              "From the Twilio Console home page, copy your Account SID and Auth Token",
              "Click 'Get a Trial Number' (free) or buy a number under Phone Numbers",
              "Paste all three values below and click Save Changes",
            ]}
          />

          <div className="grid grid-cols-1 gap-4">
            <SecretInput
              label="Account SID"
              value={form.twilioAccountSid}
              onChange={(v) => setField("twilioAccountSid", v)}
              placeholder="ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx (leave blank to keep existing)"
            />
            <SecretInput
              label="Auth Token"
              value={form.twilioAuthToken}
              onChange={(v) => setField("twilioAuthToken", v)}
              placeholder="Leave blank to keep existing"
            />
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">Phone Number</label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={form.twilioPhoneNumber}
                  onChange={(e) => setField("twilioPhoneNumber", e.target.value)}
                  placeholder="+1234567890"
                  className="flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring placeholder:text-muted-foreground"
                />
                <button
                  type="button"
                  onClick={loadTwilioNumbers}
                  className="flex items-center gap-1.5 px-3 py-2 rounded-md border border-border text-sm hover:bg-accent transition-colors"
                  title="Load numbers from your Twilio account"
                >
                  <RefreshCw className="h-3.5 w-3.5" /> Load from Twilio
                </button>
              </div>
              {twilioNumbers.length > 0 && (
                <div className="mt-2 rounded-md border border-border divide-y divide-border">
                  {twilioNumbers.map((n) => (
                    <button
                      key={n.phoneNumber}
                      onClick={() => { setField("twilioPhoneNumber", n.phoneNumber); setTwilioNumbers([]); }}
                      className="flex items-center justify-between w-full px-3 py-2 text-sm hover:bg-accent transition-colors text-left"
                    >
                      <span className="font-medium">{n.phoneNumber}</span>
                      <span className="text-muted-foreground">{n.friendlyName}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Test button */}
          <div className="flex items-center gap-3 pt-1">
            <button
              onClick={handleTestTwilio}
              disabled={twilioStatus === "testing"}
              className="flex items-center gap-2 px-3 py-1.5 rounded-md border border-border text-sm hover:bg-accent disabled:opacity-60 transition-colors"
            >
              {twilioStatus === "testing" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
              Test Connection
            </button>
            {twilioMessage && (
              <p className={`text-sm ${twilioStatus === "ok" ? "text-green-600" : "text-red-500"}`}>
                {twilioMessage}
              </p>
            )}
          </div>
        </div>
      </section>

      {/* Sarvam AI Section */}
      <section className="rounded-xl border border-border bg-card shadow-sm overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border bg-card">
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-lg bg-purple-50 dark:bg-purple-950 flex items-center justify-center">
              <Brain className="h-4 w-4 text-purple-600" />
            </div>
            <div>
              <h2 className="font-semibold text-foreground">Sarvam AI</h2>
              <p className="text-xs text-muted-foreground">AI voice & conversation engine</p>
            </div>
          </div>
          <StatusBadge status={sarvamStatus} connected={currentStatus.sarvamConnected} />
        </div>

        <div className="p-6 space-y-5">
          <SetupGuide
            title="How to get your Sarvam API key"
            link="https://app.sarvam.ai"
            linkLabel="Open Sarvam AI dashboard"
            steps={[
              "Go to app.sarvam.ai and create an account",
              "Navigate to API Keys in your dashboard",
              "Click 'Generate New Key' and copy it",
              "Paste it below and click Save Changes",
            ]}
          />

          <SecretInput
            label="API Key"
            value={form.sarvamApiKey}
            onChange={(v) => setField("sarvamApiKey", v)}
            placeholder="Leave blank to keep existing"
          />

          <div className="flex items-center gap-3 pt-1">
            <button
              onClick={handleTestSarvam}
              disabled={sarvamStatus === "testing"}
              className="flex items-center gap-2 px-3 py-1.5 rounded-md border border-border text-sm hover:bg-accent disabled:opacity-60 transition-colors"
            >
              {sarvamStatus === "testing" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
              Test Connection
            </button>
            {sarvamMessage && (
              <p className={`text-sm ${sarvamStatus === "ok" ? "text-green-600" : "text-red-500"}`}>
                {sarvamMessage}
              </p>
            )}
          </div>
        </div>
      </section>

      {/* Call Behaviour Section */}
      <section className="rounded-xl border border-border bg-card shadow-sm overflow-hidden">
        <div className="flex items-center gap-3 px-6 py-4 border-b border-border bg-card">
          <div className="h-9 w-9 rounded-lg bg-blue-50 dark:bg-blue-950 flex items-center justify-center">
            <Clock className="h-4 w-4 text-blue-600" />
          </div>
          <div>
            <h2 className="font-semibold text-foreground">Call Behaviour</h2>
            <p className="text-xs text-muted-foreground">Control when and how calls are made</p>
          </div>
        </div>

        <div className="p-6 space-y-5">
          {/* Calling hours */}
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">Allowed calling hours</label>
            <p className="text-xs text-muted-foreground">Calls queued outside this window will wait until the window opens.</p>
            <div className="flex items-center gap-3">
              <div className="space-y-1">
                <span className="text-xs text-muted-foreground">From</span>
                <select
                  value={form.callHoursStart}
                  onChange={(e) => setField("callHoursStart", Number(e.target.value))}
                  className="block rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                >
                  {Array.from({ length: 24 }, (_, i) => (
                    <option key={i} value={i}>{i === 0 ? "12:00 AM" : i < 12 ? `${i}:00 AM` : i === 12 ? "12:00 PM" : `${i - 12}:00 PM`}</option>
                  ))}
                </select>
              </div>
              <span className="text-muted-foreground mt-4">—</span>
              <div className="space-y-1">
                <span className="text-xs text-muted-foreground">Until</span>
                <select
                  value={form.callHoursEnd}
                  onChange={(e) => setField("callHoursEnd", Number(e.target.value))}
                  className="block rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                >
                  {Array.from({ length: 24 }, (_, i) => (
                    <option key={i} value={i}>{i === 0 ? "12:00 AM" : i < 12 ? `${i}:00 AM` : i === 12 ? "12:00 PM" : `${i - 12}:00 PM`}</option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          {/* Retry attempts */}
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">Retry attempts on no-answer</label>
            <p className="text-xs text-muted-foreground">How many times to retry a lead that didn't pick up.</p>
            <div className="flex items-center gap-3">
              {[0, 1, 2, 3].map((n) => (
                <button
                  key={n}
                  onClick={() => setField("callRetries", n)}
                  className={`h-9 w-9 rounded-md text-sm font-medium transition-colors ${
                    form.callRetries === n
                      ? "bg-primary text-primary-foreground"
                      : "border border-border hover:bg-accent"
                  }`}
                >
                  {n}
                </button>
              ))}
              <span className="text-xs text-muted-foreground ml-1">retries</span>
            </div>
          </div>
        </div>
      </section>

      {/* Webhook Info Section */}
      {webhookInfo && (
        <section className="rounded-xl border border-border bg-card shadow-sm overflow-hidden">
          <div className="flex items-center gap-3 px-6 py-4 border-b border-border bg-card">
            <div className="h-9 w-9 rounded-lg bg-green-50 dark:bg-green-950 flex items-center justify-center">
              <Webhook className="h-4 w-4 text-green-600" />
            </div>
            <div>
              <h2 className="font-semibold text-foreground">Webhook URLs</h2>
              <p className="text-xs text-muted-foreground">Configure these in your Twilio console for inbound calls</p>
            </div>
          </div>

          <div className="p-6 space-y-4">
            <p className="text-sm text-muted-foreground">
              If you want to receive <strong>inbound calls</strong> to your Twilio number, paste the URL below into
              the <strong>Voice Configuration</strong> of your Twilio phone number.
            </p>
            <div className="space-y-3">
              {[
                { label: "Voice Webhook (A call comes in)", value: webhookInfo.voiceWebhookUrl },
                { label: "Status Callback", value: webhookInfo.statusCallbackUrl },
              ].map(({ label, value }) => (
                <div key={label} className="space-y-1">
                  <span className="text-xs font-medium text-muted-foreground">{label}</span>
                  <div className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2">
                    <code className="flex-1 text-xs text-foreground font-mono truncate">{value}</code>
                    <CopyButton text={value} />
                  </div>
                </div>
              ))}
            </div>
            <div className="flex items-start gap-2 rounded-md bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 p-3 text-sm text-blue-700 dark:text-blue-300">
              <Shield className="h-4 w-4 mt-0.5 flex-shrink-0" />
              <span>
                <strong>Note:</strong> Outbound calls (initiated from your dashboard) automatically use these URLs — no manual configuration needed for that flow.
              </span>
            </div>
          </div>
        </section>
      )}

      {/* Save button at bottom too */}
      <div className="flex justify-end">
        <button
          onClick={handleSave}
          disabled={saving}
          className="flex items-center gap-2 bg-primary text-primary-foreground px-5 py-2.5 rounded-md text-sm font-medium hover:bg-primary/90 disabled:opacity-60 transition-colors"
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          Save All Changes
        </button>
      </div>
    </div>
  );
}
