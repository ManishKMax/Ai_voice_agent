/**
 * Tap-logger — wraps the base pino logger and mirrors any log entry that
 * carries a `call_id` field into the per-callSid simulator bus
 * (services/simulator-bus.ts). This is how the in-browser Call Simulator
 * gets to see the *exact* same `call_session_*` structured log lines that
 * the server emits, without touching the dozens of `logger.info(...)`
 * call sites inside `websocket/call-session.ts`.
 *
 * To enable for a module: replace
 *
 *     import { logger } from "../lib/logger.js";
 *
 * with
 *
 *     import { logger } from "../services/sim-logger.js";
 *
 * Both surface the same `info/warn/error/debug(obj, msg?)` interface.
 *
 * Cost: when no simulator subscribers are listening on the call_id,
 * `publishSimulator` short-circuits — overhead is one Map.get per log call.
 */

import { logger as baseLogger } from "../lib/logger.js";
import { publishSimulator, hasSimulatorSubscribers } from "./simulator-bus.js";

type LogLevel = "info" | "warn" | "error" | "debug";

function emit(level: LogLevel, obj: unknown, msg?: string): void {
  // Fast path: forward to pino first so log ordering stays intact even if
  // the bus listener throws or blocks the event loop (it can't — listeners
  // are wrapped in try/catch inside publishSimulator).
  if (msg !== undefined) {
    baseLogger[level](obj as object, msg);
  } else {
    baseLogger[level](obj as object);
  }
  if (obj && typeof obj === "object") {
    const callId = (obj as { call_id?: unknown }).call_id;
    if (typeof callId === "string" && hasSimulatorSubscribers(callId)) {
      publishSimulator(callId, "log", {
        level,
        event: msg ?? null,
        ...(obj as Record<string, unknown>),
      });
    }
  }
}

export const logger = {
  info: (obj: unknown, msg?: string) => emit("info", obj, msg),
  warn: (obj: unknown, msg?: string) => emit("warn", obj, msg),
  error: (obj: unknown, msg?: string) => emit("error", obj, msg),
  debug: (obj: unknown, msg?: string) => emit("debug", obj, msg),
};
