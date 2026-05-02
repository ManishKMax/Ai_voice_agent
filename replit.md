# AI Lead Calling & Qualification System

## Overview

A production-ready AI-powered outbound call system that accepts leads, calls them automatically via Twilio, conducts live voice conversations using Sarvam AI, analyzes transcripts, and updates lead qualification status.

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
- **Auth**: JWT (jsonwebtoken + bcryptjs)
- **Queue**: In-memory job queue with retry logic (max 3 retries, 2hr delay)
- **Voice**: Twilio Programmable Voice (Gather + Play)
- **AI TTS**: Sarvam AI Bulbul v3 (`bulbul:v3`) — Indian-accent voice synthesis
- **AI STT**: Twilio built-in speech recognition (Gather input="speech")
- **AI Chat**: Sarvam AI `sarvam-105b` — 105B flagship model for conversation + analysis
- **Frontend**: React + Vite + TailwindCSS + shadcn/ui

## Artifacts

- `artifacts/api-server` — Express backend at `/api`
- `artifacts/dashboard` — React frontend at `/`

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)

## Database Schema

- `users` — registered users (JWT auth)
- `leads` — lead records with status lifecycle (pending → calling → completed → interested/not_interested)
- `calls` — call log with Twilio SID, status, duration, transcript, recording URL

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

### Auth
- `POST /api/auth/register` — register user
- `POST /api/auth/login` — login, returns JWT

### Leads
- `POST /api/leads` — create lead (auto-enqueues for calling)
- `POST /api/leads/upload` — CSV upload (bulk import)
- `GET /api/leads` — list leads (filter by status, search, paginate)
- `GET /api/leads/export` — export as CSV
- `GET /api/leads/:id` — single lead

### Calls
- `POST /api/call/initiate/:leadId` — manually trigger a call
- `POST /api/voice` — Twilio TwiML webhook (returns Gather TwiML)
- `POST /api/voice/gather` — handles lead's speech → AI response → next TwiML
- `GET /api/voice/audio/:id` — serve TTS audio blob (Twilio downloads via Play)
- `POST /api/call-status` — Twilio call status webhook
- `GET /api/calls` — list calls
- `GET /api/calls/:id` — single call
- `GET /api/agent-config` — current agent configuration

### Dashboard
- `GET /api/dashboard/stats` — stats (leads by status, calls, queue, recent)

## Environment Variables Required

- `TWILIO_ACCOUNT_SID` — Twilio Console
- `TWILIO_AUTH_TOKEN` — Twilio Console  
- `TWILIO_PHONE_NUMBER` — Your Twilio number (e.g. +12298605475)
- `SARVAM_API_KEY` — Sarvam AI dashboard (api-subscription-key)
- `JWT_SECRET` — Random secret for JWT signing
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

## Development

- Twilio signature validation is **skipped** in `NODE_ENV=development` (set by the dev workflow)
- Audio files served at `/api/voice/audio/:id` expire after 10 minutes
- Conversation sessions (in-memory) expire after 30 minutes
- `sarvam-105b` requires `max_tokens: 2000` due to thinking mode (uses ~1000-1500 tokens per response)
