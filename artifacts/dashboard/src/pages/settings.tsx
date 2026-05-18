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
  Key,
  Plus,
  Trash2,
  Send,
  Zap,
  Mail,
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
  retryDelay1: number;
  retryDelay2: number;
  retryDelay3: number;
  webhookUrl: string;
  webhookSecret: string;
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPass: string;
  smtpFrom: string;
  twilioConnected: boolean;
  sarvamConnected: boolean;
  webhookConfigured: boolean;
  smtpConfigured: boolean;
}

interface WebhookInfo {
  baseUrl: string;
  voiceWebhookUrl: string;
  statusCallbackUrl: string;
}

interface ApiKeyRecord {
  id: number;
  name: string;
  keyPrefix: string;
  createdAt: string;
  lastUsedAt: string | null;
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

function hourLabel(h: number): string {
  if (h === 0) return "12:00 AM";
  if (h < 12) return `${h}:00 AM`;
  if (h === 12) return "12:00 PM";
  return `${h - 12}:00 PM`;
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
    callRetries: 3,
    callHoursStart: 9,
    callHoursEnd: 20,
    retryDelay1: 30,
    retryDelay2: 120,
    retryDelay3: 1440,
    webhookUrl: "",
    webhookSecret: "",
    smtpHost: "",
    smtpPort: 587,
    smtpUser: "",
    smtpPass: "",
    smtpFrom: "",
  });

  const [currentStatus, setCurrentStatus] = useState<{
    twilioConnected: boolean;
    sarvamConnected: boolean;
    webhookConfigured: boolean;
    smtpConfigured: boolean;
  }>({ twilioConnected: false, sarvamConnected: false, webhookConfigured: false, smtpConfigured: false });

  const [twilioStatus, setTwilioStatus] = useState<ConnectionStatus>("idle");
  const [sarvamStatus, setSarvamStatus] = useState<ConnectionStatus>("idle");
  const [webhookTestStatus, setWebhookTestStatus] = useState<ConnectionStatus>("idle");
  const [twilioMessage, setTwilioMessage] = useState("");
  const [sarvamMessage, setSarvamMessage] = useState("");
  const [webhookMessage, setWebhookMessage] = useState("");

  const [emailTestStatus, setEmailTestStatus] = useState<ConnectionStatus>("idle");
  const [emailTestMessage, setEmailTestMessage] = useState("");
  const [emailTestRecipient, setEmailTestRecipient] = useState("");
  const [lowBalanceTestStatus, setLowBalanceTestStatus] = useState<ConnectionStatus>("idle");
  const [lowBalanceTestMessage, setLowBalanceTestMessage] = useState("");

  const [webhookInfo, setWebhookInfo] = useState<WebhookInfo | null>(null);
  const [twilioNumbers, setTwilioNumbers] = useState<{ phoneNumber: string; friendlyName: string }[]>([]);

  const [apiKeys, setApiKeys] = useState<ApiKeyRecord[]>([]);
  const [newKeyName, setNewKeyName] = useState("");
  const [creatingKey, setCreatingKey] = useState(false);
  const [newKeyValue, setNewKeyValue] = useState<string | null>(null);
  const [deletingKeyId, setDeletingKeyId] = useState<number | null>(null);

  // ── LLM Provider state ────────────────────────────────────────────────
  type LlmProviderId = "sarvam" | "groq" | "openai" | "gemini";
  interface LlmProviderRow {
    id: LlmProviderId;
    label: string;
    defaultModel: string;
    model: string;
    apiKeyMasked: string;
    configured: boolean;
  }
  const [llmActiveId, setLlmActiveId] = useState<LlmProviderId>("sarvam");
  const [llmProviders, setLlmProviders] = useState<LlmProviderRow[]>([]);
  // Edits the user has typed but not saved yet, keyed by provider id.
  const [llmEdits, setLlmEdits] = useState<Partial<Record<LlmProviderId, { apiKey?: string; model?: string }>>>({});
  const [llmSaving, setLlmSaving] = useState(false);
  const [llmTestStatus, setLlmTestStatus] = useState<Record<string, ConnectionStatus>>({});
  const [llmTestMessage, setLlmTestMessage] = useState<Record<string, string>>({});

  useEffect(() => {
    Promise.all([
      apiFetch("/api/settings"),
      apiFetch("/api/settings/webhook-info"),
      apiFetch("/api/settings/api-keys"),
      apiFetch("/api/settings/llm"),
    ]).then(([settingsRes, webhookRes, keysRes, llmRes]) => {
      if (llmRes?.success) {
        setLlmActiveId(llmRes.data.activeProviderId);
        setLlmProviders(llmRes.data.providers);
      }
      if (settingsRes.success) {
        const d: SettingsData = settingsRes.data;
        setCurrentStatus({
          twilioConnected: d.twilioConnected,
          sarvamConnected: d.sarvamConnected,
          webhookConfigured: d.webhookConfigured,
          smtpConfigured: d.smtpConfigured,
        });
        setForm({
          twilioAccountSid: "",
          twilioAuthToken: "",
          twilioPhoneNumber: d.twilioPhoneNumber ?? "",
          sarvamApiKey: "",
          callRetries: d.callRetries ?? 3,
          callHoursStart: d.callHoursStart ?? 9,
          callHoursEnd: d.callHoursEnd ?? 20,
          retryDelay1: d.retryDelay1 ?? 30,
          retryDelay2: d.retryDelay2 ?? 120,
          retryDelay3: d.retryDelay3 ?? 1440,
          webhookUrl: d.webhookUrl ?? "",
          webhookSecret: "",
          smtpHost: d.smtpHost ?? "",
          smtpPort: d.smtpPort ?? 587,
          smtpUser: d.smtpUser ?? "",
          smtpPass: "",
          smtpFrom: d.smtpFrom ?? "",
        });
      }
      if (webhookRes.success) setWebhookInfo(webhookRes.data);
      if (keysRes.success) setApiKeys(keysRes.data ?? []);
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
        retryDelay1: form.retryDelay1,
        retryDelay2: form.retryDelay2,
        retryDelay3: form.retryDelay3,
        webhookUrl: form.webhookUrl,
      };
      // Task #28: Twilio credentials live on the dedicated telephony endpoint
      // so they round-trip the same surface that GET /settings/telephony reads.
      // Phone number is sent even when empty so the user can clear it.
      if (form.twilioAccountSid || form.twilioAuthToken || form.twilioPhoneNumber !== undefined) {
        const telephonyPayload: Record<string, string> = {};
        if (form.twilioAccountSid) telephonyPayload.twilioAccountSid = form.twilioAccountSid;
        if (form.twilioAuthToken)  telephonyPayload.twilioAuthToken  = form.twilioAuthToken;
        if (typeof form.twilioPhoneNumber === "string") telephonyPayload.twilioPhoneNumber = form.twilioPhoneNumber;
        await apiFetch("/api/settings/telephony", {
          method: "PATCH",
          body: JSON.stringify(telephonyPayload),
        });
      }
      if (form.sarvamApiKey)     payload.sarvamApiKey     = form.sarvamApiKey;
      if (form.webhookSecret)    payload.webhookSecret    = form.webhookSecret;

      payload.smtpHost = form.smtpHost;
      payload.smtpPort = form.smtpPort;
      payload.smtpUser = form.smtpUser;
      payload.smtpFrom = form.smtpFrom;
      if (form.smtpPass) payload.smtpPass = form.smtpPass;

      const res = await apiFetch("/api/settings", {
        method: "PATCH",
        body: JSON.stringify(payload),
      });

      if (res.success) {
        setCurrentStatus({
          twilioConnected: res.data.twilioConnected,
          sarvamConnected: res.data.sarvamConnected,
          webhookConfigured: res.data.webhookConfigured,
          smtpConfigured: res.data.smtpConfigured,
        });
        setForm((f) => ({ ...f, twilioAccountSid: "", twilioAuthToken: "", sarvamApiKey: "", webhookSecret: "", smtpPass: "" }));
        toast({ title: "Settings saved", description: "All changes are now active." });
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
    const res = await apiFetch("/api/settings/telephony/test", {
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

  async function handleTestWebhook() {
    setWebhookTestStatus("testing");
    setWebhookMessage("");
    const res = await apiFetch("/api/settings/test-webhook", {
      method: "POST",
      body: JSON.stringify({ webhookUrl: form.webhookUrl || undefined }),
    });
    setWebhookTestStatus(res.success ? "ok" : "error");
    setWebhookMessage(res.message ?? "");
  }

  async function handleTestEmail() {
    if (!emailTestRecipient) return;
    setEmailTestStatus("testing");
    setEmailTestMessage("");
    const res = await apiFetch("/api/settings/test-email", {
      method: "POST",
      body: JSON.stringify({ to: emailTestRecipient }),
    });
    setEmailTestStatus(res.success ? "ok" : "error");
    setEmailTestMessage(res.message ?? "");
  }

  async function handleTestLowBalanceEmail() {
    if (!emailTestRecipient) return;
    setLowBalanceTestStatus("testing");
    setLowBalanceTestMessage("");
    const res = await apiFetch("/api/settings/test-low-balance-email", {
      method: "POST",
      body: JSON.stringify({ to: emailTestRecipient }),
    });
    setLowBalanceTestStatus(res.success ? "ok" : "error");
    setLowBalanceTestMessage(res.message ?? "");
  }

  async function loadTwilioNumbers() {
    const res = await apiFetch("/api/settings/twilio-numbers");
    if (res.success) setTwilioNumbers(res.data);
    else toast({ title: "Could not fetch numbers", description: res.message, variant: "destructive" });
  }

  async function handleCreateKey() {
    if (!newKeyName.trim()) return;
    setCreatingKey(true);
    try {
      const res = await apiFetch("/api/settings/api-keys", {
        method: "POST",
        body: JSON.stringify({ name: newKeyName.trim() }),
      });
      if (res.success) {
        setNewKeyValue(res.data.key);
        setNewKeyName("");
        setApiKeys((prev) => [
          ...prev,
          { id: res.data.id, name: res.data.name, keyPrefix: res.data.keyPrefix, createdAt: res.data.createdAt, lastUsedAt: null },
        ]);
        toast({ title: "API key created", description: res.message });
      } else {
        toast({ title: "Failed", description: res.message, variant: "destructive" });
      }
    } finally {
      setCreatingKey(false);
    }
  }

  function setLlmEdit(id: LlmProviderId, field: "apiKey" | "model", value: string) {
    setLlmEdits((e) => ({ ...e, [id]: { ...(e[id] ?? {}), [field]: value } }));
  }

  async function handleSaveLlm() {
    setLlmSaving(true);
    try {
      const credentials: Record<string, { apiKey?: string; model?: string }> = {};
      for (const [id, slot] of Object.entries(llmEdits)) {
        if (!slot) continue;
        const entry: { apiKey?: string; model?: string } = {};
        if (typeof slot.apiKey === "string" && slot.apiKey !== "") entry.apiKey = slot.apiKey;
        // Always send model (incl. empty) so user can clear back to default.
        const row = llmProviders.find((p) => p.id === id);
        if (typeof slot.model === "string" && slot.model !== row?.model) entry.model = slot.model;
        if (Object.keys(entry).length > 0) credentials[id] = entry;
      }
      const res = await apiFetch("/api/settings/llm", {
        method: "PATCH",
        body: JSON.stringify({ activeProviderId: llmActiveId, credentials }),
      });
      if (res.success) {
        setLlmActiveId(res.data.activeProviderId);
        setLlmProviders(res.data.providers);
        setLlmEdits({});
        toast({ title: "LLM provider saved", description: `Active: ${res.data.activeProviderId}` });
      } else {
        toast({ title: "Save failed", description: res.message ?? "Unknown error", variant: "destructive" });
      }
    } finally {
      setLlmSaving(false);
    }
  }

  async function handleTestLlm(providerId: LlmProviderId) {
    setLlmTestStatus((s) => ({ ...s, [providerId]: "testing" }));
    setLlmTestMessage((m) => ({ ...m, [providerId]: "" }));
    const edit = llmEdits[providerId] ?? {};
    const res = await apiFetch("/api/settings/llm/test", {
      method: "POST",
      body: JSON.stringify({
        providerId,
        apiKey: edit.apiKey || undefined,
        model: edit.model || undefined,
      }),
    });
    setLlmTestStatus((s) => ({ ...s, [providerId]: res.success ? "ok" : "error" }));
    setLlmTestMessage((m) => ({ ...m, [providerId]: res.message ?? "" }));
  }

  async function handleDeleteKey(id: number) {
    setDeletingKeyId(id);
    try {
      await apiFetch(`/api/settings/api-keys/${id}`, { method: "DELETE" });
      setApiKeys((prev) => prev.filter((k) => k.id !== id));
      toast({ title: "API key revoked" });
    } finally {
      setDeletingKeyId(null);
    }
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
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Integrations & Settings</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Configure credentials and call behaviour. Changes take effect immediately.
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
              <div className="flex items-center gap-2">
                <h2 className="font-semibold text-foreground">Twilio</h2>
                <span
                  className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300 border border-amber-200 dark:border-amber-900"
                  title="Twilio Programmable Voice is now the fallback transport. New tenants default to LiveKit SIP for outbound PSTN."
                >
                  Legacy
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                Fallback transport — new tenants default to LiveKit SIP. Keep credentials configured for existing Twilio-routed tenants and as a failover.
              </p>
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

      {/* LLM Provider Section */}
      <section className="rounded-xl border border-border bg-card shadow-sm overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border bg-card">
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-lg bg-indigo-50 dark:bg-indigo-950 flex items-center justify-center">
              <Zap className="h-4 w-4 text-indigo-600" />
            </div>
            <div>
              <h2 className="font-semibold text-foreground">LLM Provider</h2>
              <p className="text-xs text-muted-foreground">Pick the chat brain for live conversations</p>
            </div>
          </div>
          <button
            onClick={handleSaveLlm}
            disabled={llmSaving}
            className="flex items-center gap-2 bg-primary text-primary-foreground px-3 py-1.5 rounded-md text-sm font-medium hover:bg-primary/90 disabled:opacity-60 transition-colors"
          >
            {llmSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Save LLM Settings
          </button>
        </div>

        <div className="p-6 space-y-6">
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">Active provider</label>
            <p className="text-xs text-muted-foreground">
              Used for every live call's chat turns. Sarvam stays as automatic fallback if the chosen provider returns empty.
            </p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-1">
              {llmProviders.map((p) => (
                <button
                  key={p.id}
                  onClick={() => setLlmActiveId(p.id)}
                  className={`px-3 py-2 rounded-md border text-sm font-medium transition-colors ${
                    llmActiveId === p.id
                      ? "bg-primary text-primary-foreground border-primary"
                      : "border-border hover:bg-accent"
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-5 pt-2">
            {llmProviders.map((p) => {
              const edit = llmEdits[p.id] ?? {};
              const apiKeyValue = edit.apiKey ?? "";
              const modelValue = edit.model ?? p.model ?? "";
              const status = llmTestStatus[p.id] ?? "idle";
              const message = llmTestMessage[p.id] ?? "";
              return (
                <div key={p.id} className="rounded-lg border border-border p-4 space-y-3 bg-muted/20">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-foreground">{p.label}</span>
                      {llmActiveId === p.id && (
                        <span className="text-[10px] uppercase tracking-wide text-primary border border-primary/40 rounded px-1.5 py-0.5">
                          Active
                        </span>
                      )}
                    </div>
                    <StatusBadge status={status} connected={p.configured} />
                  </div>
                  <SecretInput
                    label={`${p.label} API Key${p.configured ? ` (saved: ${p.apiKeyMasked})` : ""}`}
                    value={apiKeyValue}
                    onChange={(v) => setLlmEdit(p.id, "apiKey", v)}
                    placeholder={p.configured ? "Leave blank to keep existing" : "Paste API key…"}
                  />
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium text-foreground">Model (optional)</label>
                    <input
                      type="text"
                      value={modelValue}
                      onChange={(e) => setLlmEdit(p.id, "model", e.target.value)}
                      placeholder={`Default: ${p.defaultModel}`}
                      className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring placeholder:text-muted-foreground"
                    />
                  </div>
                  <div className="flex items-center gap-3 pt-1">
                    <button
                      onClick={() => handleTestLlm(p.id)}
                      disabled={status === "testing"}
                      className="flex items-center gap-2 px-3 py-1.5 rounded-md border border-border text-sm hover:bg-accent disabled:opacity-60 transition-colors"
                    >
                      {status === "testing" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                      Test {p.label}
                    </button>
                    {message && (
                      <p className={`text-sm ${status === "ok" ? "text-green-600" : "text-red-500"}`}>
                        {message}
                      </p>
                    )}
                  </div>
                </div>
              );
            })}
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

        <div className="p-6 space-y-6">
          {/* Calling hours */}
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">Allowed calling hours</label>
            <p className="text-xs text-muted-foreground">Calls queued outside this window are held until it opens. Voicemail retries also respect this window.</p>
            <div className="flex items-center gap-3 flex-wrap">
              <div className="space-y-1">
                <span className="text-xs text-muted-foreground">From</span>
                <select
                  value={form.callHoursStart}
                  onChange={(e) => setField("callHoursStart", Number(e.target.value))}
                  className="block rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                >
                  {Array.from({ length: 24 }, (_, i) => (
                    <option key={i} value={i}>{hourLabel(i)}</option>
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
                    <option key={i} value={i}>{hourLabel(i)}</option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          {/* Retry attempts */}
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">Max retry attempts on no-answer / voicemail</label>
            <p className="text-xs text-muted-foreground">How many times to retry a lead that didn't pick up or went to voicemail.</p>
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

          {/* Retry delays */}
          <div className="space-y-3">
            <div>
              <label className="text-sm font-medium text-foreground">Retry backoff delays</label>
              <p className="text-xs text-muted-foreground mt-0.5">How long to wait before each retry attempt (in minutes).</p>
            </div>
            <div className="grid grid-cols-3 gap-3">
              {(["retryDelay1", "retryDelay2", "retryDelay3"] as const).map((field, i) => (
                <div key={field} className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground">Retry {i + 1}</label>
                  <div className="flex items-center gap-1.5">
                    <input
                      type="number"
                      min={1}
                      max={10080}
                      value={form[field]}
                      onChange={(e) => setField(field, Number(e.target.value))}
                      className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                    <span className="text-xs text-muted-foreground whitespace-nowrap">min</span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {form[field] < 60
                      ? `${form[field]}m`
                      : form[field] < 1440
                        ? `${(form[field] / 60).toFixed(1)}h`
                        : `${(form[field] / 1440).toFixed(1)}d`}
                  </p>
                </div>
              ))}
            </div>
            <div className="flex gap-2 flex-wrap">
              {[
                { label: "Quick (30m / 2h / 8h)", values: [30, 120, 480] },
                { label: "Standard (1h / 4h / 24h)", values: [60, 240, 1440] },
                { label: "Gentle (4h / 24h / 72h)", values: [240, 1440, 4320] },
              ].map(({ label, values }) => (
                <button
                  key={label}
                  onClick={() => {
                    setField("retryDelay1", values[0]);
                    setField("retryDelay2", values[1]);
                    setField("retryDelay3", values[2]);
                  }}
                  className="px-2.5 py-1 rounded text-xs border border-border hover:bg-accent transition-colors"
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Outbound Webhook Section */}
      <section className="rounded-xl border border-border bg-card shadow-sm overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border bg-card">
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-lg bg-orange-50 dark:bg-orange-950 flex items-center justify-center">
              <Zap className="h-4 w-4 text-orange-600" />
            </div>
            <div>
              <h2 className="font-semibold text-foreground">CRM Webhook</h2>
              <p className="text-xs text-muted-foreground">Push lead outcomes to your CRM or automation tool</p>
            </div>
          </div>
          <StatusBadge status={webhookTestStatus} connected={currentStatus.webhookConfigured} />
        </div>

        <div className="p-6 space-y-5">
          <div className="flex items-start gap-2 rounded-md bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 p-3 text-sm text-blue-700 dark:text-blue-300">
            <Shield className="h-4 w-4 mt-0.5 flex-shrink-0" />
            <span>
              A POST request is sent to your URL whenever a lead reaches a terminal status:
              <strong> interested, not interested, callback, completed, DNC, no response</strong>.
              An HMAC-SHA256 signature is included in <code className="text-xs">X-Webhook-Signature</code> when a secret is configured.
            </span>
          </div>

          <div className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">Webhook URL</label>
              <input
                type="url"
                value={form.webhookUrl}
                onChange={(e) => setField("webhookUrl", e.target.value)}
                placeholder="https://your-crm.com/webhooks/lead-outcome"
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring placeholder:text-muted-foreground"
              />
            </div>
            <SecretInput
              label="Signing Secret (optional)"
              value={form.webhookSecret}
              onChange={(v) => setField("webhookSecret", v)}
              placeholder="Leave blank to keep existing secret"
            />
          </div>

          <div className="flex items-center gap-3 pt-1">
            <button
              onClick={handleTestWebhook}
              disabled={webhookTestStatus === "testing" || !form.webhookUrl}
              className="flex items-center gap-2 px-3 py-1.5 rounded-md border border-border text-sm hover:bg-accent disabled:opacity-60 transition-colors"
            >
              {webhookTestStatus === "testing" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
              Send Test Payload
            </button>
            {webhookMessage && (
              <p className={`text-sm ${webhookTestStatus === "ok" ? "text-green-600" : "text-red-500"}`}>
                {webhookMessage}
              </p>
            )}
          </div>
        </div>
      </section>

      {/* Email Notifications Section */}
      <section className="rounded-xl border border-border bg-card shadow-sm overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border bg-card">
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-lg bg-sky-50 dark:bg-sky-950 flex items-center justify-center">
              <Mail className="h-4 w-4 text-sky-600" />
            </div>
            <div>
              <h2 className="font-semibold text-foreground">Email Notifications</h2>
              <p className="text-xs text-muted-foreground">KYC decision emails and low-balance alerts for tenants</p>
            </div>
          </div>
          <StatusBadge status={emailTestStatus} connected={currentStatus.smtpConfigured} />
        </div>

        <div className="p-6 space-y-5">
          <SetupGuide
            title="SMTP configuration tips"
            link="https://support.google.com/mail/answer/185833"
            linkLabel="Create a Gmail App Password"
            steps={[
              "For Gmail: enable 2-Step Verification, then create an App Password under your Google Account → Security",
              "Use smtp.gmail.com / port 587 / your Gmail address / App Password (not your main password)",
              "For other providers (Outlook, Zoho, Mailgun SMTP): use their respective SMTP host and port",
              "The 'From' field can be a friendly name like: YourCompany <noreply@yourcompany.com>",
            ]}
          />

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">SMTP Host</label>
              <input
                type="text"
                value={form.smtpHost}
                onChange={(e) => setField("smtpHost", e.target.value)}
                placeholder="smtp.gmail.com"
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring placeholder:text-muted-foreground"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">Port</label>
              <select
                value={form.smtpPort}
                onChange={(e) => setField("smtpPort", Number(e.target.value))}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              >
                <option value={587}>587 — STARTTLS (recommended)</option>
                <option value={465}>465 — SSL/TLS</option>
                <option value={25}>25 — Plain (not recommended)</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">Username / Email</label>
              <input
                type="text"
                value={form.smtpUser}
                onChange={(e) => setField("smtpUser", e.target.value)}
                placeholder="you@yourcompany.com"
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring placeholder:text-muted-foreground"
              />
            </div>
            <SecretInput
              label="Password / App Password"
              value={form.smtpPass}
              onChange={(v) => setField("smtpPass", v)}
              placeholder={currentStatus.smtpConfigured ? "Leave blank to keep existing" : "Enter password…"}
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium text-foreground">From Address</label>
            <input
              type="text"
              value={form.smtpFrom}
              onChange={(e) => setField("smtpFrom", e.target.value)}
              placeholder='YourCompany <noreply@yourcompany.com>'
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring placeholder:text-muted-foreground"
            />
            <p className="text-xs text-muted-foreground">Defaults to the username above if left blank.</p>
          </div>

          <div className="rounded-md border border-sky-200 dark:border-sky-800 bg-sky-50 dark:bg-sky-950/30 p-3 text-sm text-sky-700 dark:text-sky-300 flex items-start gap-2">
            <Mail className="h-4 w-4 mt-0.5 flex-shrink-0" />
            <span>Tenants automatically receive emails when you approve or reject their KYC, and when their minutes balance drops below 30 or hits zero.</span>
          </div>

          <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3 pt-1 border-t border-border">
            <div className="flex-1 space-y-1.5 w-full sm:w-auto">
              <label className="text-xs font-medium text-muted-foreground">Send a test email to</label>
              <input
                type="email"
                value={emailTestRecipient}
                onChange={(e) => setEmailTestRecipient(e.target.value)}
                placeholder="yourself@example.com"
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring placeholder:text-muted-foreground"
              />
            </div>
            <div className="flex flex-wrap items-center gap-3 sm:mt-5">
              <button
                onClick={handleTestEmail}
                disabled={emailTestStatus === "testing" || !emailTestRecipient}
                className="flex items-center gap-2 px-3 py-1.5 rounded-md border border-border text-sm hover:bg-accent disabled:opacity-60 transition-colors whitespace-nowrap"
              >
                {emailTestStatus === "testing" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                Test KYC Email
              </button>
              <button
                onClick={handleTestLowBalanceEmail}
                disabled={lowBalanceTestStatus === "testing" || !emailTestRecipient}
                className="flex items-center gap-2 px-3 py-1.5 rounded-md border border-amber-300 text-amber-700 dark:border-amber-700 dark:text-amber-400 text-sm hover:bg-amber-50 dark:hover:bg-amber-950/30 disabled:opacity-60 transition-colors whitespace-nowrap"
              >
                {lowBalanceTestStatus === "testing" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                Test Low-Balance Alert
              </button>
            </div>
          </div>
          {(emailTestMessage || lowBalanceTestMessage) && (
            <div className="space-y-1">
              {emailTestMessage && (
                <p className={`text-sm ${emailTestStatus === "ok" ? "text-green-600" : "text-red-500"}`}>{emailTestMessage}</p>
              )}
              {lowBalanceTestMessage && (
                <p className={`text-sm ${lowBalanceTestStatus === "ok" ? "text-green-600" : "text-red-500"}`}>{lowBalanceTestMessage}</p>
              )}
            </div>
          )}
        </div>
      </section>

      {/* API Keys Section */}
      <section className="rounded-xl border border-border bg-card shadow-sm overflow-hidden">
        <div className="flex items-center gap-3 px-6 py-4 border-b border-border bg-card">
          <div className="h-9 w-9 rounded-lg bg-emerald-50 dark:bg-emerald-950 flex items-center justify-center">
            <Key className="h-4 w-4 text-emerald-600" />
          </div>
          <div>
            <h2 className="font-semibold text-foreground">API Keys</h2>
            <p className="text-xs text-muted-foreground">Allow external systems to create leads via REST API</p>
          </div>
        </div>

        <div className="p-6 space-y-5">
          <div className="flex items-start gap-2 rounded-md bg-muted/40 border border-border p-3 text-sm text-muted-foreground">
            <Shield className="h-4 w-4 mt-0.5 flex-shrink-0 text-foreground" />
            <span>
              Send the key in the <code className="text-xs text-foreground">X-API-Key</code> header when calling{" "}
              <code className="text-xs text-foreground">POST /api/leads</code>. Keys are hashed — copy each key when created.
            </span>
          </div>

          {newKeyValue && (
            <div className="rounded-md border border-emerald-300 bg-emerald-50 dark:bg-emerald-950/30 p-4 space-y-2">
              <p className="text-sm font-medium text-emerald-800 dark:text-emerald-200">New API key — copy it now, it won't be shown again:</p>
              <div className="flex items-center gap-2 bg-white dark:bg-card rounded border border-border px-3 py-2">
                <code className="flex-1 text-xs font-mono text-foreground break-all">{newKeyValue}</code>
                <CopyButton text={newKeyValue} />
              </div>
              <button onClick={() => setNewKeyValue(null)} className="text-xs text-muted-foreground hover:text-foreground underline">Dismiss</button>
            </div>
          )}

          {apiKeys.length > 0 && (
            <div className="rounded-md border border-border divide-y divide-border">
              {apiKeys.map((key) => (
                <div key={key.id} className="flex items-center justify-between px-4 py-3">
                  <div>
                    <p className="text-sm font-medium">{key.name}</p>
                    <p className="text-xs text-muted-foreground font-mono">
                      {key.keyPrefix}••••••••
                      {key.lastUsedAt ? ` · Last used ${new Date(key.lastUsedAt).toLocaleDateString()}` : " · Never used"}
                    </p>
                  </div>
                  <button
                    onClick={() => handleDeleteKey(key.id)}
                    disabled={deletingKeyId === key.id}
                    className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30 rounded transition-colors disabled:opacity-60"
                  >
                    {deletingKeyId === key.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                    Revoke
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="flex gap-2">
            <input
              type="text"
              value={newKeyName}
              onChange={(e) => setNewKeyName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleCreateKey()}
              placeholder="Key name (e.g. CRM Integration)"
              className="flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring placeholder:text-muted-foreground"
            />
            <button
              onClick={handleCreateKey}
              disabled={creatingKey || !newKeyName.trim()}
              className="flex items-center gap-1.5 px-3 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-60 transition-colors"
            >
              {creatingKey ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
              Create Key
            </button>
          </div>
        </div>
      </section>

      {/* Twilio Webhook URLs Section */}
      {webhookInfo && (
        <section className="rounded-xl border border-border bg-card shadow-sm overflow-hidden">
          <div className="flex items-center gap-3 px-6 py-4 border-b border-border bg-card">
            <div className="h-9 w-9 rounded-lg bg-green-50 dark:bg-green-950 flex items-center justify-center">
              <Webhook className="h-4 w-4 text-green-600" />
            </div>
            <div>
              <h2 className="font-semibold text-foreground">Twilio Webhook URLs</h2>
              <p className="text-xs text-muted-foreground">Configure these in your Twilio console for inbound calls</p>
            </div>
          </div>

          <div className="p-6 space-y-4">
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
                Outbound calls (initiated from your dashboard) automatically use these URLs — no manual configuration needed.
              </span>
            </div>
          </div>
        </section>
      )}

      <div className="flex justify-end pb-8">
        <button
          onClick={handleSave}
          disabled={saving}
          className="flex items-center gap-2 bg-primary text-primary-foreground px-4 py-2 rounded-md text-sm font-medium hover:bg-primary/90 disabled:opacity-60 transition-colors"
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          Save Changes
        </button>
      </div>
    </div>
  );
}
