/**
 * Per-callSid pub/sub used by the in-browser Call Simulator (Task #31).
 *
 * Producers (CallSession, metrics service, tap-logger) call `publish(...)`
 * with the simulator-issued callSid. Consumers (the `/api/simulator/:callId
 * /stream` SSE route) call `subscribe(...)` to receive every event for that
 * call.
 *
 * Listeners are stored in a Map<callSid, Set<listener>>; if no listeners
 * exist for a given callSid `publish` is a cheap no-op so production
 * (non-simulator) calls pay nothing for this code path.
 *
 * NOT a replacement for `sse.service.ts` — that one is a global broadcast
 * used by the Live Monitor; simulator-bus is strictly per-call so each
 * simulator session sees only its own events.
 */

export interface SimulatorEvent {
  event: string;
  data: unknown;
  ts: number;
}

export type SimulatorListener = (e: SimulatorEvent) => void;

const subscribers = new Map<string, Set<SimulatorListener>>();

export function subscribeSimulator(
  callSid: string,
  listener: SimulatorListener,
): () => void {
  let set = subscribers.get(callSid);
  if (!set) {
    set = new Set();
    subscribers.set(callSid, set);
  }
  set.add(listener);
  return () => {
    const s = subscribers.get(callSid);
    if (!s) return;
    s.delete(listener);
    if (s.size === 0) subscribers.delete(callSid);
  };
}

export function publishSimulator(
  callSid: string,
  event: string,
  data: unknown,
): void {
  const set = subscribers.get(callSid);
  if (!set || set.size === 0) return;
  const payload: SimulatorEvent = { event, data, ts: Date.now() };
  for (const l of set) {
    try {
      l(payload);
    } catch {
      // Never let a bad listener crash the producer hot path. A failing
      // SSE writer will be cleaned up by its req.on("close") handler.
    }
  }
}

export function hasSimulatorSubscribers(callSid: string): boolean {
  const s = subscribers.get(callSid);
  return !!s && s.size > 0;
}
