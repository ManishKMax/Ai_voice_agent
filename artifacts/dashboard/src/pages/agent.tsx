import React, { useState, useEffect, useMemo, useRef } from "react";
import { Bot, Volume2, Save, RefreshCw, RotateCcw, ChevronDown, ChevronUp, Loader2 } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

function apiCall(path: string, opts?: RequestInit) {
  const token = localStorage.getItem("auth_token");
  return fetch(`${BASE}${path}`, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(opts?.headers ?? {}),
    },
  });
}

interface AgentConfig {
  name: string;
  language: string;
  voice: string;
  tone: "professional" | "friendly" | "casual";
  companyName: string;
  productName: string;
  maxTurns: number;
  customSystemPrompt: string | null;
  greetingTemplate: string | null;
}

interface VoiceOption { value: string; label: string; }
interface LangOption { value: string; label: string; }

const TONES = [
  { value: "professional", label: "Professional", desc: "Formal and business-like" },
  { value: "friendly", label: "Friendly", desc: "Warm and conversational" },
  { value: "casual", label: "Casual", desc: "Relaxed and easy-going" },
] as const;

export default function AgentSettings() {
  const { toast } = useToast();
  const [config, setConfig] = useState<AgentConfig | null>(null);
  const [voices, setVoices] = useState<VoiceOption[]>([]);
  const [languages, setLanguages] = useState<LangOption[]>([]);
  const [computedPrompt, setComputedPrompt] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Voice preview state
  const [previewVoice, setPreviewVoice] = useState("");
  const [previewLang, setPreviewLang] = useState("");
  const [previewText, setPreviewText] = useState("");
  const [previewing, setPreviewing] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // System prompt editor
  const [showPromptEditor, setShowPromptEditor] = useState(false);
  const [useCustomPrompt, setUseCustomPrompt] = useState(false);
  const [customPrompt, setCustomPrompt] = useState("");

  // Greeting editor — the opening line the agent says when the lead
  // picks up. `defaultGreeting` (server-rendered template for the
  // currently SAVED tone/language) is shown as the textarea placeholder
  // so users see "blank = use the default". The live preview itself is
  // computed client-side from current unsaved form state so it updates
  // as the user types (server only knows about saved values).
  const [defaultGreeting, setDefaultGreeting] = useState("");

  async function loadConfig() {
    setLoading(true);
    try {
      const res = await apiCall("/api/agent-config");
      const data = await res.json() as {
        config: AgentConfig;
        computedSystemPrompt: string;
        defaultGreetingTemplate: string;
        computedGreeting: string;
        voices: VoiceOption[];
        languages: LangOption[];
      };
      setConfig(data.config);
      setVoices(data.voices);
      setLanguages(data.languages);
      setComputedPrompt(data.computedSystemPrompt);
      setDefaultGreeting(data.defaultGreetingTemplate);
      setPreviewVoice(data.config.voice);
      setPreviewLang(data.config.language);
      setPreviewText(`Hello! This is ${data.config.name} from ${data.config.companyName}. How are you today?`);
      const hasCustom = !!data.config.customSystemPrompt;
      setUseCustomPrompt(hasCustom);
      setCustomPrompt(data.config.customSystemPrompt ?? data.computedSystemPrompt);
    } catch {
      toast({ title: "Failed to load agent config", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadConfig(); }, []);

  async function handleSave() {
    if (!config) return;
    setSaving(true);
    try {
      const payload: Partial<AgentConfig> & {
        customSystemPrompt?: string | null;
        greetingTemplate?: string | null;
      } = {
        ...config,
        customSystemPrompt: useCustomPrompt ? customPrompt : null,
        // Empty string → server treats as "use built-in default".
        greetingTemplate: config.greetingTemplate?.trim() ? config.greetingTemplate : null,
      };
      const res = await apiCall("/api/agent-config", {
        method: "PATCH",
        body: JSON.stringify(payload),
      });
      const data = await res.json() as {
        config: AgentConfig;
        computedSystemPrompt: string;
        defaultGreetingTemplate: string;
        computedGreeting: string;
      };
      setConfig(data.config);
      setComputedPrompt(data.computedSystemPrompt);
      setDefaultGreeting(data.defaultGreetingTemplate);
      toast({ title: "Agent settings saved", description: "Changes will apply to the next call." });
    } catch {
      toast({ title: "Failed to save settings", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  async function handlePreview() {
    setPreviewing(true);
    try {
      if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; }
      const res = await apiCall("/api/agent-config/voice-preview", {
        method: "POST",
        body: JSON.stringify({ voice: previewVoice, language: previewLang, text: previewText }),
      });
      const data = await res.json() as { audioBase64: string; contentType: string };
      const bytes = atob(data.audioBase64);
      const arr = new Uint8Array(bytes.length);
      for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
      const blob = new Blob([arr], { type: data.contentType });
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.play();
      audio.onended = () => URL.revokeObjectURL(url);
    } catch {
      toast({ title: "Voice preview failed", variant: "destructive" });
    } finally {
      setPreviewing(false);
    }
  }

  function updateConfig(patch: Partial<AgentConfig>) {
    setConfig((c) => c ? { ...c, ...patch } : c);
  }

  // Live preview of the spoken greeting using current (possibly unsaved)
  // form state. Mirrors `buildGreetingText` + `fillGreetingTemplate` on
  // the server: same four placeholders, same null/empty → default
  // fallback, same 200-char ceiling. Lead name is a fixed example since
  // the real value only exists at call time.
  const computedGreeting = useMemo(() => {
    if (!config) return "";
    const template = config.greetingTemplate?.trim() ? config.greetingTemplate : defaultGreeting;
    if (!template) return "";
    const filled = template
      .replaceAll("{leadName}", "<lead name>")
      .replaceAll("{agentName}", config.name)
      .replaceAll("{companyName}", config.companyName)
      .replaceAll("{productName}", config.productName)
      .trim();
    return filled.length > 200 ? filled.slice(0, 200) : filled;
  }, [config, defaultGreeting]);

  if (loading) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold tracking-tight">Agent Settings</h1>
        <div className="grid gap-4 md:grid-cols-2">
          {[1,2,3,4].map(i => (
            <Card key={i}><CardContent className="p-6"><div className="h-32 bg-muted animate-pulse rounded" /></CardContent></Card>
          ))}
        </div>
      </div>
    );
  }

  if (!config) return null;

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Bot className="h-6 w-6 text-primary" />
            Agent Settings
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Configure how your AI sales agent sounds, behaves, and thinks.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={loadConfig} disabled={loading}>
            <RefreshCw className="h-4 w-4 mr-2" />
            Reload
          </Button>
          <Button size="sm" onClick={handleSave} disabled={saving}>
            {saving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Save className="h-4 w-4 mr-2" />}
            Save Changes
          </Button>
        </div>
      </div>

      {/* Identity */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Identity</CardTitle>
          <CardDescription>Who is the agent and what company do they represent?</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label>Agent Name</Label>
            <Input
              value={config.name}
              onChange={e => updateConfig({ name: e.target.value })}
              placeholder="e.g. Priya"
            />
          </div>
          <div className="space-y-2">
            <Label>Company Name</Label>
            <Input
              value={config.companyName}
              onChange={e => updateConfig({ companyName: e.target.value })}
              placeholder="e.g. TechCorp"
            />
          </div>
          <div className="space-y-2 sm:col-span-2">
            <Label>Product / Service Name</Label>
            <Input
              value={config.productName}
              onChange={e => updateConfig({ productName: e.target.value })}
              placeholder="e.g. CRM Suite"
            />
          </div>

          <div className="space-y-2 sm:col-span-2">
            <div className="flex items-center justify-between">
              <Label>Opening Line (Greeting)</Label>
              {config.greetingTemplate?.trim() && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => updateConfig({ greetingTemplate: null })}
                >
                  <RotateCcw className="h-3 w-3 mr-1" />
                  Reset to default
                </Button>
              )}
            </div>
            <Textarea
              value={config.greetingTemplate ?? ""}
              onChange={e => updateConfig({ greetingTemplate: e.target.value })}
              rows={3}
              placeholder={defaultGreeting}
              className="text-sm"
            />
            <p className="text-xs text-muted-foreground">
              First thing the agent says when the lead picks up. Leave blank to use the default shown above.
              Use placeholders <code className="px-1 rounded bg-muted">{"{leadName}"}</code>,{" "}
              <code className="px-1 rounded bg-muted">{"{agentName}"}</code>,{" "}
              <code className="px-1 rounded bg-muted">{"{companyName}"}</code>,{" "}
              <code className="px-1 rounded bg-muted">{"{productName}"}</code>.
            </p>
            {computedGreeting && (
              <div className="rounded-md border bg-muted/40 px-3 py-2 text-xs">
                <span className="font-medium text-muted-foreground">Preview: </span>
                <span>{computedGreeting}</span>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Voice */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Voice</CardTitle>
          <CardDescription>Choose the agent's language and voice. Preview any combination before committing.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>Language</Label>
              <select
                className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                value={config.language}
                onChange={e => updateConfig({ language: e.target.value })}
              >
                {languages.map(l => (
                  <option key={l.value} value={l.value}>{l.label}</option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <Label>Voice</Label>
              <select
                className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                value={config.voice}
                onChange={e => updateConfig({ voice: e.target.value })}
              >
                {voices.map(v => (
                  <option key={v.value} value={v.value}>{v.label}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Preview strip */}
          <div className="rounded-lg border bg-muted/40 p-4 space-y-3">
            <p className="text-sm font-medium">Preview a Voice</p>
            <p className="text-xs text-muted-foreground">Test any voice and language combination — it won't change your current settings until you save.</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label className="text-xs">Preview Language</Label>
                <select
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  value={previewLang}
                  onChange={e => setPreviewLang(e.target.value)}
                >
                  {languages.map(l => (
                    <option key={l.value} value={l.value}>{l.label}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Preview Voice</Label>
                <select
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  value={previewVoice}
                  onChange={e => setPreviewVoice(e.target.value)}
                >
                  {voices.map(v => (
                    <option key={v.value} value={v.value}>{v.label}</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Preview Text</Label>
              <Input
                value={previewText}
                onChange={e => setPreviewText(e.target.value)}
                placeholder="Type what you want the agent to say..."
              />
            </div>
            <Button size="sm" onClick={handlePreview} disabled={previewing} className="w-full sm:w-auto">
              {previewing
                ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Generating…</>
                : <><Volume2 className="h-4 w-4 mr-2" /> Play Preview</>
              }
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Behavior */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Behavior</CardTitle>
          <CardDescription>Control the agent's tone and how long it keeps a lead on the call.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="space-y-2">
            <Label>Conversation Tone</Label>
            <div className="grid gap-2 sm:grid-cols-3">
              {TONES.map(t => (
                <button
                  key={t.value}
                  onClick={() => updateConfig({ tone: t.value as AgentConfig["tone"] })}
                  className={`rounded-lg border p-3 text-left transition-colors ${
                    config.tone === t.value
                      ? "border-primary bg-primary/5 text-primary"
                      : "border-border hover:border-muted-foreground"
                  }`}
                >
                  <p className="font-medium text-sm">{t.label}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">{t.desc}</p>
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <Label>Max Conversation Turns</Label>
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={2}
                max={16}
                value={config.maxTurns}
                onChange={e => updateConfig({ maxTurns: parseInt(e.target.value) })}
                className="flex-1"
              />
              <span className="text-sm font-medium w-16 text-center">
                {config.maxTurns} turns
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              Each turn is one exchange (lead speaks → agent responds). {config.maxTurns} turns ≈ ~{Math.round(config.maxTurns * 30 / 60)} min call.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* AI Brain / System Prompt */}
      <Card>
        <CardHeader>
          <button
            className="w-full flex items-center justify-between text-left"
            onClick={() => setShowPromptEditor(p => !p)}
          >
            <div>
              <CardTitle className="text-base">AI Brain (System Prompt)</CardTitle>
              <CardDescription className="mt-1">
                Train the agent by customising its instructions.
                {useCustomPrompt && <span className="ml-1 text-amber-600 font-medium">Custom prompt active</span>}
              </CardDescription>
            </div>
            {showPromptEditor ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
          </button>
        </CardHeader>

        {showPromptEditor && (
          <CardContent className="space-y-4">
            <div className="flex items-center gap-3 p-3 rounded-lg border bg-muted/30">
              <input
                type="checkbox"
                id="use-custom"
                checked={useCustomPrompt}
                onChange={e => {
                  setUseCustomPrompt(e.target.checked);
                  if (e.target.checked && !customPrompt) setCustomPrompt(computedPrompt);
                }}
                className="h-4 w-4"
              />
              <label htmlFor="use-custom" className="text-sm cursor-pointer">
                Use custom prompt instead of auto-generated one
              </label>
            </div>

            {useCustomPrompt ? (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>Custom System Prompt</Label>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => setCustomPrompt(computedPrompt)}
                  >
                    <RotateCcw className="h-3 w-3 mr-1" />
                    Reset to auto-generated
                  </Button>
                </div>
                <Textarea
                  value={customPrompt}
                  onChange={e => setCustomPrompt(e.target.value)}
                  rows={14}
                  className="font-mono text-xs leading-relaxed"
                  placeholder="Write your full system prompt here…"
                />
                <p className="text-xs text-muted-foreground">
                  Tip: The agent's current lead name and opening line are automatically appended to whatever you write here.
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                <Label className="text-muted-foreground">Auto-generated Prompt (read-only)</Label>
                <div className="rounded-md border bg-muted/40 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground max-h-64 overflow-y-auto">
                  {computedPrompt}
                </div>
                <p className="text-xs text-muted-foreground">
                  This prompt is built automatically from your Identity, Voice, and Behavior settings above.
                  Enable the custom prompt above to take full control.
                </p>
              </div>
            )}
          </CardContent>
        )}
      </Card>

      {/* Save footer */}
      <div className="flex justify-end gap-2 pb-4">
        <Button variant="outline" onClick={loadConfig} disabled={loading}>Discard Changes</Button>
        <Button onClick={handleSave} disabled={saving}>
          {saving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Save className="h-4 w-4 mr-2" />}
          Save All Settings
        </Button>
      </div>
    </div>
  );
}
