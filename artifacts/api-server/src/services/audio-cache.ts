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
