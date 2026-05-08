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
- **AI Chat**: Sarvam AI `sarvam-m` (24B, ~1-2s, default for live conversation) + `sarvam-105b` (post-call analysis). Override via `SARVAM_CHAT_MODEL` / `SARVAM_ANALYSIS_MODEL`.
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
  Twilio for platform calls and unknown values). **Safety gate**: Exotel
  selection requires `EXOTEL_WS_ENABLED=1` because `media-stream.ts` still
  parses Twilio envelopes and the Exotel adapter is unverified — without
  the env flag, Exotel-flagged tenants fall back to Twilio with a logged
  warning.

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

## Development Notes

- Twilio signature validation is **skipped** in `NODE_ENV=development`
- Audio files served at `/api/voice/audio/:id` expire after 10 minutes
- Conversation sessions (in-memory) expire after 30 minutes
- `sarvam-105b` requires `max_tokens: 2000` due to thinking mode (8-14s/turn — too slow for live voice). `sarvam-m` is the default conversation model and uses 300 tokens.
- DB push interactive prompts: use `echo "" | pnpm --filter @workspace/db run push` or create tables directly via SQL
