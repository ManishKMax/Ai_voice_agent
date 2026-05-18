# AI Lead Calling & Qualification System — VoiceAgent SaaS

## Overview

A production-ready AI-powered outbound call system with two products:

1. **Admin Dashboard** (`/`) — internal JWT-authenticated dashboard for managing leads, calls, settings
2. **User Portal** (`/portal/`) — multi-tenant SaaS portal for customers to sign up, trial, and use the AI calling service

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)
- **Admin auth**: JWT (jsonwebtoken + bcryptjs)
- **Portal auth**: Clerk (Google + email/password)
- **Queue**: In-memory job queue with retry logic (max 3 retries, 2hr delay)
- **Voice**: Twilio Programmable Voice (Gather + Play)
- **AI TTS**: Sarvam AI Bulbul v3 (`bulbul:v3`) — Indian-accent voice synthesis
- **AI STT**: Twilio built-in speech recognition (Gather input="speech")
- **AI Chat (pluggable)**: Live conversation LLM is selectable per-deployment from the Settings UI — Sarvam-M (default, ~1-2s), Groq Llama-3.3-70B (fastest non-Sarvam), OpenAI GPT-4o-mini, or Google Gemini 2.0 Flash. Per-call override is supported via `customParameters.llmProvider` on the MediaStream start envelope (used by the Call Simulator). Post-call analysis remains on `sarvam-105b`.
- **Credentials policy**: All third-party credentials (LLM keys, Twilio creds, Sarvam keys, SMTP, webhook secret) are managed from the dashboard Settings page. The env-var-prompt workflow is deprecated for new credentials — env vars are still honoured as a fallback for first-boot bootstrap only.
- **Frontend**: React + Vite + TailwindCSS + shadcn/ui

## Artifacts

- `artifacts/api-server` — Express backend at `/api`
- `artifacts/dashboard` — React admin frontend at `/`
- `artifacts/portal` — React user portal at `/portal/` (Clerk auth)

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)

## Database Schema

### Admin/Core tables
- `users` — registered users (JWT auth)
- `leads` — lead records with full Phase 1 fields
- `calls` — call log with Twilio SID, status, duration, transcript, recording URL
- `platform_settings` — runtime credentials (Twilio SID/token, Sarvam API key, call behavior)

### Multi-tenant Portal tables (Phase 1)
- `tenants` — per-customer tenant record linked to Clerk user ID
  - `clerk_user_id` (unique) — links to Clerk user
  - `kyc_status`: pending | submitted | approved | rejected
  - `trial_calls_used` — calls used during trial (limit: 5)
  - `minutes_balance` — purchased minutes balance
  - `telephony_provider` — twilio | exotel
  - Twilio/Exotel credential fields (per-tenant)
- `pricing_config` — singleton config row
  - `per_minute_rate_paise`: 500 (₹5/min)
  - `monthly_plan_cost_paise`: 200000 (₹2000/month)
  - `trial_calls_limit`: 5
  - `monthly_minutes_quota`: 400 min/month
- `kyc_documents` — uploaded KYC docs per tenant (aadhaar, gst)

## Portal API Routes

- `GET /api/portal/me` — get or create tenant by Clerk user ID, returns trial status + pricing

## Portal Frontend Pages

- `/portal/` — Landing page (public, redirects to /portal/dashboard if signed in)
- `/portal/sign-in` — Clerk sign-in (Google + email)
- `/portal/sign-up` — Clerk sign-up
- `/portal/dashboard` — User dashboard with trial banner, KYC status, stats
- `/portal/leads` — Lead management (scaffold, Phase 2)
- `/portal/billing` — Billing & top-up (scaffold, Phase 3)
- `/portal/kyc` — KYC document upload (Aadhaar + GST)
- `/portal/settings` — Twilio/Exotel credential management

## Agent Configuration

The AI agent is configurable via environment variables (or by editing `artifacts/api-server/src/config/agent.config.ts`):

| Variable | Default | Description |
|---|---|---|
| `AGENT_NAME` | `Priya` | Agent's displayed name |
| `AGENT_LANGUAGE` | `en-IN` | BCP-47 language code (en-IN, hi-IN, te-IN, etc.) |
| `AGENT_VOICE` | `priya` | Sarvam TTS voice (priya, rohan, neha, kavya, shubh, etc.) |
| `AGENT_TONE` | `professional` | Conversation tone (professional, friendly, casual) |
| `COMPANY_NAME` | `TechCorp CRM` | Company name spoken by agent |
| `PRODUCT_NAME` | `CRM Suite` | Product name mentioned in conversation |
| `AGENT_MAX_TURNS` | `6` | Max conversation turns before ending call |

**Valid Sarvam voices for bulbul:v3**: aditya, ritu, ashutosh, priya, neha, rahul, pooja, rohan, simran, kavya, amit, dev, ishita, shreya, ratan, varun, manan, sumit, roopa, kabir, aayan, shubh, advait, anand, tanya, tarun, sunny, mani, gokul, vijay, shruti, suhani, mohit, kavitha, rehan, soham, rupali, niharika

## Voice Call Pipeline

```
Lead created → enqueued → triggerCallForLead(leadId)
    ↓
Twilio initiates outbound call to lead
    ↓
POST /api/voice?leadId=X  (Twilio voice webhook)
    ↓ Sarvam TTS (bulbul:v3) generates greeting audio
    ↓ Audio stored in-memory (10 min TTL)
    ↓ Returns: <Gather input="speech"><Play audio_url/></Gather>
    ↓
Lead hears greeting → speaks
    ↓
Twilio STT transcribes speech → POST /api/voice/gather
    ↓ Sarvam Chat (sarvam-105b) generates agent response
    ↓ Sarvam TTS generates response audio
    ↓ Returns: next <Gather><Play> OR <Hangup>
    ↓
[Repeat for up to maxTurns, or until AI sends [DONE]]
    ↓
Call ends → transcript saved → Sarvam AI analysis runs
    ↓ interest level + next action determined
    ↓ Lead status updated (interested / not_interested / completed)
    ↓ Lead notes updated with call summary
```

## Sarvam AI APIs Used

- **TTS**: `POST https://api.sarvam.ai/text-to-speech` — auth: `api-subscription-key`, model: `bulbul:v3`
- **Chat/Conversation**: `POST https://api.sarvam.ai/v1/chat/completions` — auth: `Bearer`, model: `sarvam-105b` (max_tokens: 2000 required for thinking mode)
- **Post-call Analysis**: Same chat endpoint, different prompt

**Note**: `wss://api.sarvam.ai/v1/realtime` WebSocket is NOT publicly available (returns 403). The turn-based Gather pipeline achieves real AI voice conversations without it.

## API Modules

### Admin Auth
- `POST /api/auth/register` — register user
- `POST /api/auth/login` — login, returns JWT

### Leads
- `POST /api/leads` — create lead (auto-enqueues for calling)
- `POST /api/leads/upload` — CSV upload (bulk import)
- `POST /api/leads/bulk` — bulk action: delete | requeue | set_status | set_dnc
- `GET /api/leads` — list leads (filter by status, search, paginate)
- `GET /api/leads/export` — export as CSV
- `GET /api/leads/:id` — single lead
- `PATCH /api/leads/:id` — update lead
- `DELETE /api/leads/:id` — delete lead + all call history

### Calls
- `POST /api/call/initiate/:leadId` — manually trigger a call
- `POST /api/voice` — Twilio TwiML webhook
- `POST /api/voice/gather` — handles lead's speech → AI response → next TwiML
- `GET /api/voice/audio/:id` — serve TTS audio blob
- `POST /api/call-status` — Twilio call status webhook
- `GET /api/calls` — list calls
- `GET /api/calls/:id` — single call

### Settings (JWT, admin) — Task #28
- `GET/PATCH /api/settings/llm` — list providers (Sarvam / Groq / OpenAI / Gemini) with masked keys; save active provider + per-provider apiKey/model. Empty apiKey in PATCH leaves the stored secret untouched.
- `POST /api/settings/llm/test` — `{ providerId, apiKey?, model? }` → 1-token hello-world chat; returns latency + model echo.
- `GET/PATCH /api/settings/telephony` — Twilio Account SID / Auth Token / Phone Number (masked in responses). Mirrors LLM card UX.
- `POST /api/settings/telephony/test` — live Twilio credential validation (alias of `/api/settings/test-twilio`).

Live conversation provider precedence (in `resolveLlm`):
1. Per-call `customParameters.llmProvider` override (simulator only).
2. `agent_settings.config.llmProviderId`.
3. Default: `sarvam`.

Fallback: if the active non-Sarvam provider has no key, or returns empty, the system falls back to Sarvam-M (using the platform Sarvam key) for that turn so live calls never hang.

### Admin (JWT, COMPANY_ADMIN/SUPER_ADMIN)
- `GET/POST/PATCH/DELETE /api/admin/users` — user CRUD with role + active toggle
- `POST /api/admin/magic-link { tenantId }` — issue 10-min portal access link
- `GET /api/auth/magic-login?token=` — consume link, returns short JWT
- `GET/POST /api/admin/subscriptions` — list / create tenant subscription
- `PATCH /api/admin/tenants/:id/sarvam` — toggle sarvam access (caps at sarvamMaxUsers)
- `POST /api/calls/:id/outcome` — set INTERESTED|NOT_INTERESTED|NO_RESPONSE; INTERESTED requires followUpDate
- `POST /api/razorpay/webhook` — HMAC-verified (raw body) subscription webhook
- `GET /api/reports/overview` — leads/calls/conversion/monthly volume/by-outcome

**Auth rules**: First registered user becomes COMPANY_ADMIN. Role embedded in JWT. `requireRole(...)` middleware gates admin routes.

**Sarvam access control**: Calls only initiate if `platformSettings.sarvamEnabled` AND tenant.sarvamEnabled (enforced in `triggerCallForLead`). Per-tenant enable is capped by `platformSettings.sarvamMaxUsers`.

### Portal (Clerk-authenticated)
- `GET /api/portal/me` — get/create tenant, return trial + pricing info
- `GET /api/portal/credentials` — fetch saved telephony creds (tokens redacted)
- `PATCH /api/portal/credentials` — save Twilio/Exotel creds + provider
- `POST /api/portal/credentials/test` — live-validate creds against provider
- `GET/POST/DELETE /api/portal/leads` + `POST /leads/:id/retry` — tenant-scoped leads
- `GET /api/portal/usage` — tenant-scoped usage (tenantId-filtered)

### Telephony providers
- `services/twilio.service.ts` — `initiateCall(toPhone, leadId, creds?)` — per-tenant creds optional
- `services/exotel.service.ts` — `initiateExotelCall()` via Connect Two Numbers API
- `calls.service.dispatchCall()` routes by `lead.tenantId` → tenant.telephonyProvider

### IVR provider abstraction (Phase 4)

The voice/brain WS pipeline is decoupled from any specific carrier via the
`IvrProvider` interface in `artifacts/api-server/src/voice/ivr/types.ts`.
`CallSession` consumes a normalised PCM s16le @ 8 kHz frame stream and emits
PCM s16le @ 8 kHz frames; the provider does codec/envelope translation.

- `voice/ivr/twilio-provider.ts` — Twilio Media Streams (μ-law 8 kHz, TwiML
  `<Connect><Stream>`). Byte-identical to Phase-3 output.
- `voice/ivr/exotel-provider.ts` — Exotel Voicebot Streaming **scaffold**.
  Compiles, registered in the registry, but contains explicit `TODO(exotel)`
  comments where live wiring is required (envelope keys differ from Twilio's
  camelCase, default codec is PCM not μ-law, and the connect XML uses
  `<Voicebot>` not `<Connect><Stream>`).
- `voice/ivr/index.ts` — registry + `resolveProviderForLead(leadId)` which
  joins `leads → tenants` and returns the right provider singleton (default
  Twilio for platform calls and unknown values).
- `media-stream.ts` is carrier-agnostic — it delegates inbound envelope
  parsing (`parseInboundEnvelope`) and outbound message serialization
  (`serializeAudioMessage` / `serializeMarkMessage` / `serializeClearMessage`)
  to the active provider. The default provider (Twilio) handles the WS
  handshake; once the start envelope's `customParameters` carry a leadId or
  `provider` hint, the per-tenant provider takes over.

Webhook flow when `VOICE_PIPELINE=ws`:
1. `POST /api/voice` calls `resolveProviderForLead(leadId)`,
2. uses `provider.generateConnectResponse(leadId)` for the carrier-specific
   webhook body & content-type (TwiML for Twilio, app-bazaar XML for Exotel).
3. The `MediaStream` WS subscriber instantiates `CallSession`, which calls
   `resolveProviderForLead(leadId)` again at start() and uses
   `provider.decodeInboundFrame()` / `provider.encodeOutboundFrame()` for
   every frame, plus `provider.outboundFrameBytesPcm()` /
   `outboundFrameIntervalMs()` for chunking.

Adding a new IVR (e.g. Plivo):
1. Implement `IvrProvider` in `voice/ivr/plivo-provider.ts`.
2. Register it in the `REGISTRY` map of `voice/ivr/index.ts`.
3. Extend the `IvrProviderId` union in `voice/ivr/types.ts`.
4. Add the matching `tenants.telephony_provider` enum value (already a
   `text` column — no schema change needed for new providers).

### LiveKit transport (Phase 1 — Call Simulator)

Task #30 adds LiveKit as a third transport. Unlike Twilio/Exotel (text-
envelope WebSockets to `/api/voice/stream`), LiveKit is a WebRTC SFU —
audio flows over peer-published Opus tracks, not over the media-stream WS
endpoint.

Architecture:
- `voice/ivr/livekit-provider.ts` — `IvrProvider` impl. Codec functions
  are **identity passthroughs** because `@livekit/rtc-node`'s `AudioStream`
  and `AudioSource` natively handle Opus 48 kHz stereo ↔ PCM s16le 8 kHz
  mono resampling at the FFI layer. WS envelope methods return `null`/`""`
  because the WebRTC path bypasses `media-stream.ts` entirely.
- `services/livekit.service.ts` — `mintLiveKitToken()` (signed JWT via
  `livekit-server-sdk`) + boot-time `probeLiveKit()` (fail-soft if creds
  missing — LiveKit is opt-in transport).
- `voice/livekit/agent-worker.ts` — in-process agent. `startLiveKitAgent()`
  connects an agent participant to a room, subscribes to remote audio
  tracks at 8 kHz mono via `AudioStream(track, {sampleRate:8000,
  numChannels:1, frameSizeMs:20})`, and pumps each `AudioFrame` into a
  synthetic `MediaStreamSession` whose `sendAudio()` wraps outbound PCM
  into `AudioFrame` for `AudioSource.captureFrame()`. The brain
  (`CallSession`) runs unchanged.
- `modules/calls/livekit.routes.ts` — admin-JWT-gated:
  - `POST /api/voice/livekit/token` — mint participant join token for
    the browser-side Call Simulator. Body: `{identity?, roomName?, name?}`.
  - `POST /api/voice/livekit/start-agent` — spawn the in-process agent
    worker in the named room. Body: `{roomName, leadId?, llmProvider?,
    callSid?}`.

Env vars (Phase 1 — no Settings UI yet, env-only):
- `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` — from LiveKit Cloud project
- `LIVEKIT_URL` — `wss://<project>.livekit.cloud`

Frame size choice: 20 ms / 320 bytes PCM s16le 8 kHz mono on both
inbound and outbound — identical pacing to Twilio so `CallSession`'s
per-frame VAD, barge-in timing, and per-stage latency metrics remain
numerically comparable across carriers.

What's intentionally NOT in Phase 1:
- No Settings UI sub-card (creds live in env vars only).
- No PSTN bridge — Phase 2 will wire LiveKit SIP trunk so real lead
  calls can route through LiveKit instead of Twilio Media Streams.
- No tenant-scoped credentials (single platform-wide LiveKit project).

### LiveKit transport (Phase 2 — outbound PSTN via SIP trunk)

Task #32 routes outbound lead calls through a LiveKit SIP trunk instead
of Twilio Programmable Voice. Twilio remains as a fallback adapter
(per-tenant `telephony_provider="twilio"`) but new tenants default to
`"livekit"` and the Twilio Settings card is now badged **Legacy**.

Dispatch flow:
```
triggerCallForLead(leadId)
  ↓
dispatchCall(toPhone, leadId, tenantId)
  ↓  tenant.telephony_provider (defaults to "livekit" when unset)
  ↓
LiveKitProvider.initiateCall()
  ├─ pick room name      lead-<id>-<rand>
  ├─ pick participant id sip-lead-<id>-<rand>
  ├─ startLiveKitAgent({roomName, leadId, source:"production"})
  │   ↳ agent worker joins room hidden, runs CallSession on inbound
  │     PCM frames, publishes outbound PCM via AudioSource.
  └─ dialSipParticipant({roomName, toPhone, sipTrunkId, fromNumber,
                          participantIdentity, metadata:{leadId,tenantId}})
       ↳ SipClient.createSipParticipant — LiveKit Cloud rings the lead
         through the configured SIP trunk and joins them into the room.
  ↓
returns participantIdentity (string) → written to calls.twilio_call_sid
  (column name is legacy; identifier carries provider-specific value)
  ↓
LiveKit Cloud webhook → POST /api/livekit/webhook
  ├─ participant_joined  (identity starts sip-lead-*) → handleCallStatusUpdate("answered")
  ├─ participant_left                                  → handleCallStatusUpdate("completed")
  └─ participant_connection_aborted                    → handleCallStatusUpdate("completed")
```

Env vars (platform-wide defaults):
- `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `LIVEKIT_URL` — existing Phase-1 vars.
- `LIVEKIT_SIP_TRUNK_ID` — outbound SIP trunk SID from LiveKit Cloud → Settings → SIP.
- `LIVEKIT_SIP_OUTBOUND_NUMBER` — optional E.164 "From" number override. Trunk default is used if unset.
- `LIVEKIT_WEBHOOK_API_KEY` / `LIVEKIT_WEBHOOK_API_SECRET` — optional. Defaults to `LIVEKIT_API_KEY/SECRET` (what LiveKit Cloud signs with by default).

Per-tenant overrides (columns on `tenants`):
- `livekit_sip_trunk_id` — overrides env default for this tenant.
- `livekit_sip_outbound_number` — overrides env default "From" number.

Operational runbook — first-time SIP trunk setup:
1. Provision a SIP trunk with your PSTN carrier (Twilio Elastic SIP / Telnyx /
   Bandwidth / Indian carriers like Knowlarity all work). You need: SIP
   termination URI, auth username/password if required, and your DID(s).
2. In LiveKit Cloud → Settings → SIP → "Outbound trunks", create a trunk
   pointing at that carrier. Copy the trunk SID (format `ST_…`).
3. Set `LIVEKIT_SIP_TRUNK_ID=ST_…` and `LIVEKIT_SIP_OUTBOUND_NUMBER=<+E.164>`
   on the API-server deployment.
4. LiveKit Cloud → Settings → Webhooks → add `https://<your-host>/api/livekit/webhook`.
   No extra signing key needed unless you rotate.
5. Restart `artifacts/api-server: API Server`. Boot log will print
   `livekit_probe: OK` if creds + project URL line up. SIP creds are NOT
   exercised by the probe — first real dispatch reveals trunk-level issues.
6. Smoke test: create a lead on a tenant with no `telephony_provider`
   override (so dispatch picks "livekit"), click Call Now. Watch
   `livekit_outbound_dispatch` → `livekit_sip_participant_created` →
   `livekit_webhook_event participant_joined` in the api-server logs.
7. Failure modes:
   - `LiveKit SIP trunk not configured` — neither env nor per-tenant set.
   - LiveKit `503/twirp_error` from `createSipParticipant` — trunk doesn't
     own the destination number, carrier rejected the INVITE, or
     `fromNumber` isn't an assigned DID on the trunk.
   - Lead row stays "calling" with no answered event — webhook URL not
     configured in LiveKit Cloud, or `participant_joined` payload's
     `identity` doesn't start with `sip-lead-` (means the room was started
     via the simulator path, not outbound dispatch).
8. Twilio fallback for a single tenant:
   `UPDATE tenants SET telephony_provider='twilio' WHERE id=$1;` — that
   tenant's next call goes through the Twilio adapter (existing code path,
   unchanged).

What's intentionally NOT in Phase 2:
- No automated SIP trunk provisioning — operational, user-driven.
- No boot-time SIP trunk callability probe — `probeLiveKit()` exercises
  RoomService only. SIP creds are tested by the first real dispatch and
  surfaced via `livekit_outbound_dispatch` / `livekit_sip_participant_created`
  / Twirp error logs. Adding a `createSipParticipant` dry-run probe
  requires consuming a DID minute per boot, so it's deferred to the
  follow-up that adds the Settings UI test button.
- No `livekit_transport_ms` metric persisted yet (TODO once we can read
  WebRTC RTC stats off the room from agent-worker). The end-to-end
  per-turn latency in `call_metrics` already covers user-visible latency.
- No Settings UI form for the per-tenant LiveKit SIP fields — set via
  `PATCH /api/portal/credentials` `{telephonyProvider:"livekit",livekit:{sipTrunkId,outboundNumber}}`
  for now, full UI in a follow-up.
- No tenant trunk allowlist enforcement. Tenants can set arbitrary
  `livekit_sip_trunk_id`, and LiveKit Cloud will accept any trunk the
  account owns. For deployments with multiple tenants on the same
  LiveKit account, isolation must be enforced operationally by giving
  each tenant a separate LiveKit project (separate API key/secret pair)
  — schema-level allowlist is a follow-up.

Migration safety for pre-Phase-2 tenants:
- Tenants created before Phase 2 have `telephony_provider = NULL`.
  `dispatchCall()` treats NULL as "twilio" so existing customer calls
  keep routing through their previously-configured Twilio numbers and
  do **not** silently jump onto an unprovisioned LiveKit trunk after
  upgrade. The column default is now `'livekit'` so brand-new tenants
  default to the Phase 2 path.
- To migrate an existing tenant onto LiveKit:
  `UPDATE tenants SET telephony_provider='livekit' WHERE id=$1;` after
  confirming the platform or per-tenant SIP trunk is set.

### Voice acceptance test

`pnpm --filter @workspace/scripts run voice-acceptance-test` replays a
fixture audio buffer (synthetic 1 kHz tone by default; pass `--wav <path>`
for a real recording) through the same per-frame pipeline `CallSession`
uses and asserts:
- (a) inbound audio frames are received,
- (b) inbound payloads decode to non-empty PCM s16le @ 8 kHz,
- (c) per-frame RMS rises above `VOICE_SPEECH_RMS_THRESHOLD`,
- (d) the audio reaches STT (bytes are flushed upstream),
- (e) Sarvam STT returns a final transcript (SKIP if `SARVAM_API_KEY` unset),
- (f) the audio-health "I could not hear you" gate does NOT fire on healthy
  audio.

The script makes no real outbound calls. Failed STT runs save the offending
WAV under `tmp/voice-acceptance/` for inspection.

## Environment Variables Required

- `TWILIO_ACCOUNT_SID` — Twilio Console
- `TWILIO_AUTH_TOKEN` — Twilio Console
- `TWILIO_PHONE_NUMBER` — Your Twilio number
- `SARVAM_API_KEY` — Sarvam AI dashboard
- `JWT_SECRET` — Random secret for JWT signing (admin dashboard)
- `SESSION_SECRET` — Session secret
- `CLERK_SECRET_KEY` — Auto-provisioned by Replit Auth (Clerk)
- `CLERK_PUBLISHABLE_KEY` — Auto-provisioned by Replit Auth (Clerk)
- `VITE_CLERK_PUBLISHABLE_KEY` — Auto-provisioned by Replit Auth (Clerk)
- `DATABASE_URL` — Auto-provisioned by Replit

## Seed Data

Demo account: `admin@demo.com` / `password`
Test lead 13: `yk` at `+919078802278` (verified Twilio trial destination)

## Twilio Setup (Trial Account)

- Calls can only go to **verified** phone numbers on a trial account
- Point your Twilio number's webhook URLs to:
  - Voice URL: `https://<your-domain>/api/voice`
  - Status Callback: `https://<your-domain>/api/call-status`
- Error 21219 = unverified destination → lead is auto-marked `no_response`, never retried

## Voice pipeline implementation choices

### HTTP TTS (chosen) vs WebSocket TTS

Phase-2 protocol discovery proved the public Sarvam TTS WebSocket only emits
**MP3** frames — there is no PCM/WAV codec switch on the WS endpoint. Decoding
MP3 in pure-JS for every turn is heavy (≈25-50 ms/sentence with native libs,
much higher in pure JS) and would require a native dep that doesn't survive
Replit's Nix container rebuilds.

The HTTP TTS endpoint (`POST /text-to-speech`) returns 8 kHz mono WAV directly
— telephony native — so we can strip the 44-byte RIFF header, μ-law encode,
chunk into 160-byte (20 ms) frames and pace at real-time without any decoder.
Trade-off: HTTP TTS is request/response (no chunked-streaming response body),
so time-to-first-frame is bounded by the *first* sentence's TTS round-trip. We
mitigate by sentence-chunking the reply (`splitForTTS`) and pipelining
synthesis: chunk N+1 synthesizes while chunk N plays.

### Sarvam TTS sample rate (`bulbul:v3` quirk)

We send `target_sample_rate_hz: 8000` on every TTS request. Bulbul:v3
**routinely ignores this** and returns 22050 Hz or 24000 Hz WAVs anyway. The
on-the-fly resample in `streamTtsToTwilio` (`resamplePcm16Mono(pcm, srcRate,
8000)`) is therefore expected behaviour, not a fault. We log it once per call
at info level (`call_session_tts_resampling_to_8khz`) for observability — do
NOT raise the level back to warn unless Sarvam fixes the underlying bug.

### Boot-time enable_thinking probe

`probeEnableThinking()` in `index.ts` fires one sarvam-m chat at startup with
`chat_template_kwargs.enable_thinking: false` and inspects whether the raw
content still contains a `<think>` block. Sarvam currently ignores the flag,
so `stripThinking()` is required on every turn. If the probe ever logs
`HONOURED`, we can drop `stripThinking()` and shrink `CHAT_MAX_TOKENS_CONVERSATION`
from 2000 down to ~400 (recovering 200-1500 tokens of latency per turn).

### STT pre-warm

`CallSession` opens the Sarvam STT WS during BOT_SPEAKING (`prewarmStt()`) so
the handshake cost — typically 300-800 ms, observed up to 12 s on cold
turn-1 — is paid before the user finishes their reply rather than after.
Idle warm sockets that the server closes mid-bot-speech are detected via
`isWarm()` and replaced with a cold open. Turn 1 gets one extra retry on
transient STT failure (timeouts / closes / network) since the very first
handshake is the most failure-prone.

### Transcript quality gate

`assessTranscriptQuality()` (in `sarvam.service.ts`) refuses to call the
LLM analyser on calls dominated by filler ("Yes", "Hmm", "OK") — the
analyser will always return SOMETHING, including a confident "interested"
classification, and that mis-classification was sending wasted demo invites.
Threshold: ≥ 2 user utterances of ≥ 3 words each AND ≥ 10 cumulative user
words (BOTH must hold — a single long reply alone is not enough signal). Failed gates are returned as `interest=low / nextAction=follow_up`
with a `lowInformation: true` flag and a summary that asks for manual review.

### Per-commit voice acceptance stub

`pnpm --filter @workspace/scripts run voice-acceptance-stub` runs in <1s
with no network calls and verifies the codec round-trip, RMS calculation,
WAV writer, STT response parser (against `scripts/fixtures/sarvam-stt-response.json`),
transcript quality gate, and `splitForTTS` chunking. Wired as the
`voice-acceptance-stub` validation command — fails the build if any of those
pure-code paths regress.

## Development Notes

- Twilio signature validation is **skipped** in `NODE_ENV=development`
- Audio files served at `/api/voice/audio/:id` expire after 10 minutes
- Conversation sessions (in-memory) expire after 30 minutes
- `sarvam-105b` requires `max_tokens: 2000` due to thinking mode (8-14s/turn — too slow for live voice). `sarvam-m` is the default conversation model and uses 2000 tokens (within the upgraded tier's 7192-token cap).
- **Sarvam tier:** account is on the upgraded tier (verified May 2026) — `sarvam-m` cap is the model context window (7192 tokens), not the 2048 starter cap. `sarvam-30b` benchmarked 1.3-28s (too variable for live voice); used only for post-call analysis.
- **STT WS response timeout:** 12s default (configurable via `SARVAM_STT_RESPONSE_TIMEOUT_MS`). Must exceed `VOICE_MAX_LISTEN_MS` (8s) — a tighter timeout structurally breaks STT on long utterances.
- DB push interactive prompts: use `echo "" | pnpm --filter @workspace/db run push` or create tables directly via SQL
