# Database Schema — AI Voice Agent

This document describes the complete PostgreSQL database schema for the AI Lead Calling & Qualification System.

---

## Table of Contents

- [Entity Relationship Diagram](#entity-relationship-diagram)
- [Tables](#tables)
  - [leads](#1-leads)
  - [calls](#2-calls)
  - [call_analysis](#3-call_analysis)
  - [users](#4-users)
  - [api_keys](#5-api_keys)
  - [platform_settings](#6-platform_settings)
  - [agent_settings](#7-agent_settings)
- [Enumerations](#enumerations)
- [Relationships](#relationships)

---

## Entity Relationship Diagram

```
┌─────────────────────────────────┐
│              users              │
│─────────────────────────────────│
│ PK  id           serial         │
│     name         text           │
│     email        text (unique)  │
│     password     text (hashed)  │
│     created_at   timestamp      │
└─────────────────────────────────┘

┌─────────────────────────────────┐        ┌──────────────────────────────────────┐
│              leads              │        │                 calls                │
│─────────────────────────────────│        │──────────────────────────────────────│
│ PK  id           serial         │◄───────│ PK  id              serial           │
│     name         text           │  1:N   │ FK  lead_id          integer         │
│     phone        text           │        │     twilio_call_sid  text            │
│     source       text           │        │     call_status      text            │
│     source_id    text           │        │     duration         integer (secs)  │
│     status       text (enum)    │        │     recording_url    text            │
│     retry_count  text           │        │     transcript       text            │
│     notes        text           │        │     interest_score   integer (0-100) │
│     tags         text (csv)     │        │     answered_by      text            │
│     priority     integer (1-4)  │        │     created_at       timestamp       │
│     dnc          boolean        │        │     updated_at       timestamp       │
│     created_at   timestamp      │        └──────────────────────────────────────┘
│     updated_at   timestamp      │                         │
└─────────────────────────────────┘                         │ 1:1
                                                            ▼
                                           ┌──────────────────────────────────────┐
                                           │           call_analysis              │
                                           │──────────────────────────────────────│
                                           │ PK  id           serial              │
                                           │ FK  call_id      integer (unique)    │
                                           │ FK  lead_id      integer             │
                                           │     interest     text (enum)         │
                                           │     next_action  text (enum)         │
                                           │     summary      text                │
                                           │     created_at   timestamp           │
                                           └──────────────────────────────────────┘

┌─────────────────────────────────┐        ┌─────────────────────────────────┐
│            api_keys             │        │         platform_settings       │
│─────────────────────────────────│        │─────────────────────────────────│
│ PK  id            serial        │        │ PK  id          serial          │
│     name          text          │        │     settings    jsonb           │
│     key_hash      text (unique) │        │     updated_at  timestamp       │
│     key_prefix    text          │        └─────────────────────────────────┘
│     created_at    timestamp     │
│     last_used_at  timestamp     │        ┌─────────────────────────────────┐
└─────────────────────────────────┘        │         agent_settings          │
                                           │─────────────────────────────────│
                                           │ PK  id          serial          │
                                           │     config      jsonb           │
                                           │     updated_at  timestamp       │
                                           └─────────────────────────────────┘
```

---

## Tables

### 1. `leads`

Stores every lead that enters the system. A lead represents a prospective customer to be contacted by the AI voice agent.

| Column | Type | Nullable | Default | Description |
|---|---|---|---|---|
| `id` | `serial` | No | auto | Primary key |
| `name` | `text` | No | — | Full name of the lead |
| `phone` | `text` | No | — | Phone number in E.164 format (e.g. `+919876543210`) |
| `source` | `text` | Yes | `'manual'` | Origin of the lead (`manual`, `csv`, `salesforce`, `crm`, etc.) |
| `source_id` | `text` | Yes | `null` | External ID from the source system (e.g. Salesforce record ID) |
| `status` | `text` | No | `'pending'` | Current status — see [Lead Status Enum](#lead-status) |
| `retry_count` | `text` | No | `'0'` | Number of call attempts made so far |
| `notes` | `text` | Yes | `null` | Free-text notes; updated by AI after each call with a summary |
| `tags` | `text` | No | `''` | Comma-separated tags (e.g. `hot,enterprise,vip`) |
| `priority` | `integer` | No | `2` | Priority level 1–4; see [Lead Priority Enum](#lead-priority) |
| `dnc` | `boolean` | No | `false` | Do Not Call flag; skipped by the calling queue when `true` |
| `created_at` | `timestamp` | No | `now()` | Row creation time |
| `updated_at` | `timestamp` | No | `now()` | Last modification time |

---

### 2. `calls`

Records every outbound call attempt made by the AI agent for a lead.

| Column | Type | Nullable | Default | Description |
|---|---|---|---|---|
| `id` | `serial` | No | auto | Primary key |
| `lead_id` | `integer` | No | — | FK → `leads.id` |
| `twilio_call_sid` | `text` | Yes | `null` | Twilio's unique Call SID (e.g. `CAxxxxxxxx`) |
| `call_status` | `text` | No | `'initiated'` | Current call status — see [Call Status Enum](#call-status) |
| `duration` | `integer` | Yes | `null` | Call duration in seconds (populated after completion) |
| `recording_url` | `text` | Yes | `null` | URL to the call recording (if enabled in Twilio) |
| `transcript` | `text` | Yes | `null` | Full conversation transcript (`Agent: … \n Lead: …`) |
| `interest_score` | `integer` | Yes | `null` | AI-computed score 0–100 indicating how interested the lead was |
| `answered_by` | `text` | Yes | `null` | Twilio AMD result: `human`, `machine`, or `unknown` |
| `created_at` | `timestamp` | No | `now()` | Row creation time |
| `updated_at` | `timestamp` | No | `now()` | Last modification time |

**Interest Score mapping:**

| Score | Meaning |
|---|---|
| 85 | High interest or demo requested |
| 55 | Medium interest / follow-up |
| 30 | Low interest (not a hard drop) |
| 10 | Not interested / drop |

---

### 3. `call_analysis`

Stores the AI's structured analysis of a completed call transcript. One analysis per call (enforced by unique constraint on `call_id`).

| Column | Type | Nullable | Default | Description |
|---|---|---|---|---|
| `id` | `serial` | No | auto | Primary key |
| `call_id` | `integer` | No | — | FK → `calls.id` (unique — one analysis per call) |
| `lead_id` | `integer` | No | — | FK → `leads.id` (denormalised for faster queries) |
| `interest` | `text` | Yes | `null` | AI-assessed interest level: `high`, `medium`, or `low` |
| `next_action` | `text` | Yes | `null` | Recommended next action: `demo`, `follow_up`, or `drop` |
| `summary` | `text` | Yes | `null` | One-paragraph natural language summary of the call |
| `created_at` | `timestamp` | No | `now()` | Row creation time |

**Unique constraint:** `call_analysis_call_id_unique` on `call_id`

---

### 4. `users`

Dashboard admin accounts. Authenticated via JWT.

| Column | Type | Nullable | Default | Description |
|---|---|---|---|---|
| `id` | `serial` | No | auto | Primary key |
| `name` | `text` | No | — | Display name |
| `email` | `text` | No | — | Login email (unique) |
| `password` | `text` | No | — | bcrypt-hashed password |
| `created_at` | `timestamp` | No | `now()` | Row creation time |

**Unique constraint:** on `email`

---

### 5. `api_keys`

API keys used by external systems (CRMs, webhooks, etc.) to authenticate against the `/api/leads` endpoint via the `X-API-Key` header.

| Column | Type | Nullable | Default | Description |
|---|---|---|---|---|
| `id` | `serial` | No | auto | Primary key |
| `name` | `text` | No | — | Human-readable label (e.g. `"Salesforce Integration"`) |
| `key_hash` | `text` | No | — | SHA-256 hash of the full API key (never stored in plain text) |
| `key_prefix` | `text` | No | — | First 12 chars of the key for display (e.g. `lc_af192bb7d`) |
| `created_at` | `timestamp` | No | `now()` | Row creation time |
| `last_used_at` | `timestamp` | Yes | `null` | Timestamp of last successful authentication |

**Unique constraint:** on `key_hash`

> Keys follow the format `lc_<32 random hex chars>` and are shown only once at creation time.

---

### 6. `platform_settings`

Single-row table (singleton pattern) that stores all platform-level configuration as a JSON blob.

| Column | Type | Nullable | Default | Description |
|---|---|---|---|---|
| `id` | `serial` | No | auto | Primary key (always `1`) |
| `settings` | `jsonb` | No | — | JSON object — see fields below |
| `updated_at` | `timestamp` | No | `now()` | Last modification time |

**`settings` JSON fields:**

| Field | Type | Description |
|---|---|---|
| `twilioAccountSid` | `string` | Twilio Account SID |
| `twilioAuthToken` | `string` | Twilio Auth Token |
| `twilioPhoneNumber` | `string` | Twilio outbound phone number |
| `sarvamApiKey` | `string` | Sarvam AI API key for TTS/STT |
| `callRetries` | `number` | Max retry attempts per lead (default: `3`) |
| `callHoursStart` | `number` | Hour (0–23) when calling window opens (default: `9`) |
| `callHoursEnd` | `number` | Hour (0–23) when calling window closes (default: `20`) |
| `retryDelay1` | `number` | Minutes to wait before 1st retry (default: `30`) |
| `retryDelay2` | `number` | Minutes to wait before 2nd retry (default: `120`) |
| `retryDelay3` | `number` | Minutes to wait before 3rd retry (default: `1440`) |
| `webhookUrl` | `string` | URL for outbound CRM webhook notifications |
| `webhookSecret` | `string` | HMAC-SHA256 signing secret for webhook payloads |

---

### 7. `agent_settings`

Single-row table (singleton pattern) that stores the AI agent's persona and behaviour configuration as a JSON blob.

| Column | Type | Nullable | Default | Description |
|---|---|---|---|---|
| `id` | `serial` | No | auto | Primary key (always `1`) |
| `config` | `jsonb` | No | — | JSON object — see fields below |
| `updated_at` | `timestamp` | No | `now()` | Last modification time |

**`config` JSON fields:**

| Field | Type | Description |
|---|---|---|
| `name` | `string` | Agent's name (spoken to leads, e.g. `"Alex"`) |
| `language` | `string` | BCP-47 language code (e.g. `"en-IN"`) |
| `voice` | `string` | Sarvam TTS voice ID |
| `tone` | `string` | Conversation tone: `professional`, `friendly`, or `casual` |
| `companyName` | `string` | Company name used in the greeting |
| `productName` | `string` | Product/service being pitched |
| `maxTurns` | `number` | Max conversation turns before the agent wraps up |
| `customSystemPrompt` | `string\|null` | Custom instructions appended to the AI system prompt |

---

## Enumerations

### Lead Status

| Value | Description |
|---|---|
| `pending` | Waiting in the call queue |
| `calling` | Currently being called |
| `completed` | Call finished; AI analysis done |
| `interested` | Lead expressed interest (high score / demo) |
| `not_interested` | Lead declined |
| `no_response` | No answer after all retries |
| `callback` | Lead asked to be called back later |
| `dnc` | Do Not Call — permanently excluded |

### Lead Priority

| Value | Label | Behaviour |
|---|---|---|
| `1` | Low | Called last |
| `2` | Normal | Default priority |
| `3` | High | Called before Normal |
| `4` | Urgent | Called first, before all others |

### Call Status

| Value | Description |
|---|---|
| `initiated` | Call created in Twilio |
| `ringing` | Phone is ringing |
| `answered` | Lead picked up |
| `completed` | Call ended normally |
| `no-answer` | Lead didn't pick up |
| `busy` | Lead's line was busy |
| `failed` | Twilio reported a failure |

### Call Analysis — Interest

| Value | Meaning |
|---|---|
| `high` | Lead is highly interested |
| `medium` | Lead is somewhat interested |
| `low` | Lead is unlikely to convert |

### Call Analysis — Next Action

| Value | Meaning |
|---|---|
| `demo` | Schedule a product demo |
| `follow_up` | Call again later |
| `drop` | Remove from pipeline |

---

## Relationships

| Relationship | Type | Description |
|---|---|---|
| `leads` → `calls` | One-to-Many | A lead can have multiple call attempts |
| `calls` → `call_analysis` | One-to-One | Each call has at most one AI analysis |
| `call_analysis` → `leads` | Many-to-One | Denormalised reference back to the lead |

> **Note:** Foreign key constraints are not enforced at the database level (Drizzle ORM handles referential integrity in application code). The `call_id` uniqueness in `call_analysis` is enforced via a named unique index.
