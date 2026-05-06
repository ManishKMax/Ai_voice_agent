import { randomUUID } from "crypto";

interface CachedAudio {
  buffer: Buffer;
  contentType: string;
  created: number;
}

const cache = new Map<string, CachedAudio>();

/** Store audio buffer and return a UUID key. Auto-expires after 10 minutes. */
export function storeAudio(buffer: Buffer, contentType = "audio/wav"): string {
  const id = randomUUID();
  cache.set(id, { buffer, contentType, created: Date.now() });
  setTimeout(() => cache.delete(id), 10 * 60 * 1000);
  return id;
}

/** Retrieve cached audio. Returns undefined if not found or expired. */
export function getAudio(id: string): { buffer: Buffer; contentType: string } | undefined {
  const entry = cache.get(id);
  if (!entry) return undefined;
  return { buffer: entry.buffer, contentType: entry.contentType };
}

// ── Per-lead greeting pre-cache ──────────────────────────────────────────────
//
// We pre-generate greeting TTS the moment a call is initiated (during the
// 5-7s of phone ringing) so the /api/voice webhook can return TwiML instantly
// without blocking on a 2-6s Sarvam call.

interface PendingGreeting {
  text: string;
  promise: Promise<string | null>; // resolves to audioId or null on TTS failure
  created: number;
}

// 2-hour TTL so greetings prewarmed at lead-creation time still hit
// even if the call is delayed by queue/retry. Buffers are small (~20-50KB).
const PENDING_GREETING_TTL_MS = 2 * 60 * 60 * 1000;
const pendingGreetings = new Map<number, PendingGreeting>();

export function setPendingGreeting(
  leadId: number,
  text: string,
  promise: Promise<string | null>,
): void {
  pendingGreetings.set(leadId, { text, promise, created: Date.now() });
  setTimeout(() => {
    const entry = pendingGreetings.get(leadId);
    if (entry && entry.created < Date.now() - PENDING_GREETING_TTL_MS) {
      pendingGreetings.delete(leadId);
    }
  }, PENDING_GREETING_TTL_MS);
}

export function hasPendingGreeting(leadId: number | null | undefined): boolean {
  if (leadId == null) return false;
  return pendingGreetings.has(leadId);
}

export function consumePendingGreeting(leadId: number): PendingGreeting | undefined {
  const entry = pendingGreetings.get(leadId);
  if (entry) pendingGreetings.delete(leadId);
  return entry;
}
