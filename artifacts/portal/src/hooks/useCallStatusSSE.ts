import { useEffect, useRef } from "react";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

export type SseCallEvent = "call.started" | "call.ended" | "call.turn" | "call.status";

export interface CallStartedPayload {
  callSid: string;
  leadId: number;
  leadName: string;
  phone: string;
  agentText: string;
  turn: number;
  startedAt: number;
}

export interface CallEndedPayload {
  callSid: string;
  leadId: number;
  leadName: string;
  turns: number;
  endedAt: number;
}

type SsePayloadMap = {
  "call.started": CallStartedPayload;
  "call.ended": CallEndedPayload;
  "call.turn": Record<string, unknown>;
  "call.status": Record<string, unknown>;
};

export function useCallStatusSSE(
  onEvent: <T extends SseCallEvent>(type: T, data: SsePayloadMap[T]) => void,
  onConnected?: () => void,
  onDisconnected?: () => void,
) {
  const callbackRef = useRef(onEvent);
  callbackRef.current = onEvent;
  const onConnectedRef = useRef(onConnected);
  onConnectedRef.current = onConnected;
  const onDisconnectedRef = useRef(onDisconnected);
  onDisconnectedRef.current = onDisconnected;

  useEffect(() => {
    let es: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let retryDelay = 1500;
    let destroyed = false;

    function connect() {
      if (destroyed) return;
      es = new EventSource(`/api/sse/events`);

      const EVENTS: SseCallEvent[] = ["call.started", "call.ended", "call.turn", "call.status"];
      for (const evt of EVENTS) {
        es.addEventListener(evt, ((e: MessageEvent) => {
          try {
            callbackRef.current(evt as any, JSON.parse(e.data));
          } catch {
            // ignore malformed payloads
          }
        }) as EventListener);
      }

      es.addEventListener("connected", () => {
        retryDelay = 1500;
        onConnectedRef.current?.();
      });

      es.onerror = () => {
        es?.close();
        onDisconnectedRef.current?.();
        if (!destroyed) {
          retryTimer = setTimeout(() => {
            retryDelay = Math.min(retryDelay * 2, 30_000);
            connect();
          }, retryDelay);
        }
      };
    }

    connect();

    return () => {
      destroyed = true;
      if (retryTimer) clearTimeout(retryTimer);
      es?.close();
    };
  }, []);
}
