# AI Lead Calling & Qualification System

## Overview

A production-ready AI-powered outbound call system that accepts leads, calls them automatically via Twilio, streams audio through Sarvam AI for live voice conversations, analyzes transcripts, and updates lead qualification status.

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
- **Voice**: Twilio Programmable Voice + Media Streams (WebSocket)
- **AI Voice**: Sarvam AI (real-time WebSocket streaming)
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
- `calls` — call log with Twilio SID, status, duration, recording URL, transcript
- `call_analysis` — AI analysis results (interest level, next action, summary)

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
- `POST /api/voice` — Twilio TwiML webhook (returns `<Connect><Stream>`)
- `POST /api/call-status` — Twilio call status webhook
- `GET /api/calls` — list calls
- `GET /api/calls/:id` — single call

### Dashboard
- `GET /api/dashboard/stats` — stats (leads by status, calls by status, queue, recent)

### AI
- `POST /api/ai/analyze/:callId` — trigger transcript analysis via Sarvam AI

## WebSocket

`/api/media-stream?leadId=X` — Twilio media stream endpoint. Bridges audio between Twilio and Sarvam AI in real-time.

## Call Flow

1. Lead created → enqueued in in-memory queue
2. Queue processor calls `triggerCallForLead(leadId)`
3. Twilio initiates outbound call → `POST /api/voice` returns TwiML with WebSocket stream
4. WebSocket server bridges audio: Twilio ↔ Sarvam AI (real-time conversation)
5. On stream stop: transcript saved, `analyzeCallAndUpdateLead` runs
6. Sarvam AI analyzes transcript → interest level + next action → lead status updated
7. If no-answer/busy: retry up to 3 times with 2hr delay

## Environment Variables Required

- `TWILIO_ACCOUNT_SID` — Twilio Console
- `TWILIO_AUTH_TOKEN` — Twilio Console
- `TWILIO_PHONE_NUMBER` — Your Twilio number
- `SARVAM_API_KEY` — Sarvam AI dashboard
- `JWT_SECRET` — Random secret for JWT signing
- `DATABASE_URL` — Auto-provisioned by Replit

## Seed Data

Demo account: `admin@demo.com` / `password` (bcrypt hash for "password")
8 sample leads + 4 calls pre-seeded.

## Twilio Setup

Point your Twilio number's webhook URLs to:
- Voice URL: `https://<your-domain>/api/voice`
- Status Callback: `https://<your-domain>/api/call-status`
