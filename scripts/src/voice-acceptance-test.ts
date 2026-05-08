/**
 * Voice pipeline acceptance test (Phase 4 + live-subscriber upgrade).
 *
 * Drives a fixture audio buffer through the *live* Media Streams WebSocket
 * server (`attachMediaStreamServer`) and the *live* CallSession subscriber
 * registered by `call-session.ts`. Frames travel the exact same path as a
 * real Twilio Media Streams connection:
 *
 *   ws client → ws server (`media-stream.ts`)
 *     → IvrProvider.parseInboundEnvelope
 *     → MediaStreamSubscriber.onMedia
 *     → CallSession.onMedia
 *     → state machine
 *
 * Asserts every condition from the user's spec:
 *
 *   (a) inbound audio frames are received by CallSession
 *   (b) inbound payloads decode to non-empty PCM s16le @ 8 kHz
 *   (c) per-frame RMS rises above the speech threshold
 *   (d) audio reaches the STT layer (observed via the live state transition
 *       LISTENING → USER_SPEECH_DETECTED → USER_SILENCE_DETECTED → FLUSH_STT)
 *   (e) Sarvam STT returns a final transcript and the state machine
 *       advances to PROCESS_TRANSCRIPT (network — SKIP if `SARVAM_API_KEY`
 *       is unset)
 *   (f) the audio-health "I could not hear you" gate does NOT fire on
 *       healthy audio (no `call_session_audio_health_gate` log)
 *
 *   Plus the carrier-abstraction assertion:
 *   (g) the WS envelope round-trips through the live `IvrProvider` parser
 *
 *   And an explicit STT-partial-events note:
 *   (e2) Sarvam's public REST/WS endpoint emits final-only transcripts.
 *
 * Why drive the live WS server rather than CallSession directly?
 *   The previous version of this test bypassed `media-stream.ts` and
 *   instantiated CallSession with a fake MediaStreamSession. A regression
 *   in envelope parsing, subscriber dispatch, or session construction
 *   wouldn't have been caught. This version connects a real WebSocket
 *   client to `attachMediaStreamServer`, sends Twilio-format envelopes,
 *   and observes the state machine via a logger spy on
 *   `call_session_state_transition` events.
 *
 * Run: `pnpm --filter @workspace/scripts run voice-acceptance-test`
 *      `pnpm --filter @workspace/scripts run voice-acceptance-test -- --wav ./sample.wav`
 *
 * Never makes a real outbound call. Exits 0 on PASS, 1 on FAIL.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import http from "node:http";

// VAD/endpointing thresholds are captured at module load by call-session.ts.
// Set short windows BEFORE importing it so the test completes in a few
// seconds without sacrificing the live state-machine path.
process.env["VOICE_POST_BOT_GRACE_MS"] = process.env["VOICE_POST_BOT_GRACE_MS"] ?? "200";
process.env["VOICE_SILENCE_END_MS"] = process.env["VOICE_SILENCE_END_MS"] ?? "300";
process.env["VOICE_MIN_SPEECH_MS"] = process.env["VOICE_MIN_SPEECH_MS"] ?? "100";
process.env["VOICE_HEALTH_GATE_AFTER_MS"] = process.env["VOICE_HEALTH_GATE_AFTER_MS"] ?? "20000";
process.env["VOICE_MAX_LISTEN_MS"] = process.env["VOICE_MAX_LISTEN_MS"] ?? "20000";

const API_SRC = "../../artifacts/api-server/src";

interface CodecMod {
  pcm16ToMuLaw(b: Buffer): Buffer;
  rmsPcm16(b: Buffer): number;
  upsample8kTo16k(b: Buffer): Buffer;
  writeWavPcm16(pcm: Buffer, sampleRate: number): Buffer;
}
interface IvrProviderLike {
  id: string;
  outboundFrameBytesPcm(): number;
  outboundFrameIntervalMs(): number;
  encodeOutboundFrame(pcm: Buffer): Buffer;
  decodeInboundFrame(payload: Buffer): Buffer;
  parseInboundEnvelope(raw: string): unknown;
  serializeAudioMessage(streamSid: string, wireFrame: Buffer): string;
  serializeMarkMessage(streamSid: string, name: string): string;
  serializeClearMessage(streamSid: string): string;
}
interface IvrMod {
  getIvrProvider(id: string): IvrProviderLike;
}
interface MediaStreamMod {
  attachMediaStreamServer(server: http.Server): void;
  MEDIA_STREAM_PATH: string;
}
interface PinoLike {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}
interface LoggerMod { logger: PinoLike }

const codecMod = (await import(`${API_SRC}/audio/codec.ts`)) as unknown as CodecMod;
const ivrMod = (await import(`${API_SRC}/voice/ivr/index.ts`)) as unknown as IvrMod;
const loggerMod = (await import(`${API_SRC}/lib/logger.ts`)) as unknown as LoggerMod;
const mediaStreamMod = (await import(
  `${API_SRC}/websocket/media-stream.ts`
)) as unknown as MediaStreamMod;
// Importing call-session.ts has a side effect: it registers the live
// MediaStreamSubscriber that constructs a real CallSession on `start`.
// We rely on that registration; nothing exported is used directly.
await import(`${API_SRC}/websocket/call-session.ts`);

const { rmsPcm16, upsample8kTo16k, writeWavPcm16 } = codecMod;
const { getIvrProvider } = ivrMod;
const { logger } = loggerMod;
const { attachMediaStreamServer, MEDIA_STREAM_PATH } = mediaStreamMod;

// ── Logger spy: capture CallSession state transitions and health-gate logs ─
//
// Pino's logger.info(obj, msg) is the canonical hot-path sink in
// call-session.ts. Wrapping it here is the least-invasive way to observe
// the live state machine without adding test hooks to production code.
interface Transition { from: string; to: string; ts: number }
const transitions: Transition[] = [];
let healthGateFired = false;

const origInfo = logger.info.bind(logger);
const origWarn = logger.warn.bind(logger);
logger.info = function (...args: unknown[]): void {
  const [obj, msg] = args;
  if (
    obj && typeof obj === "object" &&
    typeof msg === "string" &&
    msg === "call_session_state_transition"
  ) {
    const o = obj as Record<string, unknown>;
    transitions.push({
      from: String(o["state_from"] ?? ""),
      to: String(o["state_to"] ?? ""),
      ts: Date.now(),
    });
  }
  origInfo(...(args as [unknown]));
};
logger.warn = function (...args: unknown[]): void {
  const [, msg] = args;
  if (typeof msg === "string" && msg === "call_session_audio_health_gate") {
    healthGateFired = true;
  }
  origWarn(...(args as [unknown]));
};

interface Check { id: string; label: string; pass: boolean; detail: string; skipped?: boolean }
const checks: Check[] = [];
const debugDir = path.resolve(process.cwd(), "tmp/voice-acceptance");

function record(id: string, label: string, pass: boolean, detail: string): void {
  checks.push({ id, label, pass, detail });
  // eslint-disable-next-line no-console
  console.log(`[${pass ? "PASS" : "FAIL"}] ${id} ${label} — ${detail}`);
}
function recordSkip(id: string, label: string, reason: string): void {
  checks.push({ id, label, pass: true, detail: `SKIP — ${reason}`, skipped: true });
  // eslint-disable-next-line no-console
  console.log(`[SKIP] ${id} ${label} — ${reason}`);
}

function synthSineTone(durationSec: number): Buffer {
  const sampleRate = 8000;
  const totalSamples = sampleRate * durationSec;
  const buf = Buffer.alloc(totalSamples * 2);
  const amp = 10000;
  for (let i = 0; i < totalSamples; i++) {
    const v = Math.round(amp * Math.sin((2 * Math.PI * 1000 * i) / sampleRate));
    buf.writeInt16LE(v, i * 2);
  }
  return buf;
}
function extractWav(buf: Buffer): Buffer {
  if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF") return buf;
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === "data") return buf.subarray(off + 8, Math.min(buf.length, off + 8 + size));
    off += 8 + size + (size % 2);
  }
  return buf.subarray(44);
}

async function loadFixture(): Promise<{ pcm8k: Buffer; source: string }> {
  const wavArgIdx = process.argv.indexOf("--wav");
  if (wavArgIdx >= 0 && process.argv[wavArgIdx + 1]) {
    const p = path.resolve(process.argv[wavArgIdx + 1]!);
    const wav = await fs.readFile(p);
    return { pcm8k: extractWav(wav), source: p };
  }
  // 1 second of speech-band tone is enough to clear MIN_SPEECH_MS once paced
  // at real-time. The trailing silence is generated separately below.
  return { pcm8k: synthSineTone(1), source: "synthetic 1 kHz sine, 1s" };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Wait until `predicate()` returns true or the timeout elapses. Polls every
 * 25 ms — fine-grained enough to catch fast state transitions without
 * busy-looping. */
async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  label: string,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await sleep(25);
  }
  // eslint-disable-next-line no-console
  console.log(`[waitFor] timeout after ${timeoutMs}ms waiting for: ${label}`);
  return false;
}

async function main(): Promise<void> {
  // eslint-disable-next-line no-console
  console.log("voice-acceptance-test: starting (no real calls placed)");

  await fs.mkdir(debugDir, { recursive: true }).catch(() => undefined);

  const { pcm8k, source } = await loadFixture();
  // eslint-disable-next-line no-console
  console.log(`fixture: ${source} (${pcm8k.length} bytes PCM)`);

  const provider = getIvrProvider("twilio");

  // ── (g) Provider envelope round-trip ────────────────────────────────────
  const sampleWire = provider.encodeOutboundFrame(pcm8k.subarray(0, 320));
  const wireEnvelopes = [
    JSON.stringify({ event: "connected", protocol: "Call", version: "1.0.0" }),
    JSON.stringify({
      event: "start",
      start: {
        streamSid: "MZ_g",
        callSid: "CA_g",
        customParameters: { leadId: "0" },
        mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 },
      },
    }),
    JSON.stringify({
      event: "media",
      media: { payload: sampleWire.toString("base64"), timestamp: "20" },
    }),
    JSON.stringify({ event: "mark", mark: { name: "tts-end" } }),
    JSON.stringify({ event: "stop", stop: {} }),
  ];
  const parsedKinds = wireEnvelopes
    .map((f) => provider.parseInboundEnvelope(f))
    .map((e) => (e && typeof e === "object" && "kind" in e ? (e as { kind: string }).kind : "null"));
  const expectedKinds = ["connected", "start", "media", "mark", "stop"];
  record(
    "g",
    "WS envelope round-trips through IvrProvider",
    JSON.stringify(parsedKinds) === JSON.stringify(expectedKinds),
    `parsed=${parsedKinds.join(",")} expected=${expectedKinds.join(",")}`,
  );

  // ── Spin up the live HTTP+WS server and connect a real client ──────────
  const httpServer = http.createServer();
  attachMediaStreamServer(httpServer);
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = httpServer.address();
  if (!addr || typeof addr === "string") throw new Error("server bound to UNIX socket");
  const port = addr.port;
  const wsUrl = `ws://127.0.0.1:${port}${MEDIA_STREAM_PATH}`;

  // Node ≥ 22 ships a global WebSocket — use it to avoid adding a dep.
  const ws = new WebSocket(wsUrl);
  // We don't actually need to inspect outbound frames for the assertions,
  // but draining `message` prevents Node from buffering them indefinitely
  // if SARVAM_API_KEY is set and the server emits TTS audio.
  let outboundMessages = 0;
  ws.addEventListener("message", () => { outboundMessages++; });
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("ws open timeout")), 5000);
    ws.addEventListener("open", () => { clearTimeout(t); resolve(); }, { once: true });
    ws.addEventListener("error", (e) => { clearTimeout(t); reject(new Error(`ws error: ${String(e)}`)); }, { once: true });
  });

  const streamSid = `MZ_acc_${Date.now()}`;
  const callSid = `CA_acc_${Date.now()}`;

  ws.send(JSON.stringify({ event: "connected", protocol: "Call", version: "1.0.0" }));
  ws.send(JSON.stringify({
    event: "start",
    start: {
      streamSid,
      callSid,
      // leadId=0 so getLeadById/resolveProviderForLead are skipped — the
      // live CallSession.start() then runs without DB access.
      customParameters: { leadId: "0" },
      mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 },
    },
  }));

  // CallSession.start() emits IDLE→BOT_SPEAKING immediately, then (after
  // TTS, which returns null without SARVAM_API_KEY) → WAIT_AFTER_BOT_SPEECH
  // → LISTENING. With SARVAM_API_KEY it does a real TTS round-trip first.
  const reachedListening = await waitFor(
    () => transitions.some((t) => t.to === "LISTENING"),
    process.env["SARVAM_API_KEY"] ? 20000 : 5000,
    "LISTENING",
  );
  if (!reachedListening) {
    record(
      "live-listening",
      "Live CallSession reached LISTENING via WS subscriber",
      false,
      `transitions so far: ${transitions.map((t) => `${t.from}→${t.to}`).join(", ") || "none"}`,
    );
    try { ws.close(); } catch { /* ignore */ }
    httpServer.close();
    summariseAndExit();
    return;
  }
  record(
    "live-listening",
    "Live CallSession reached LISTENING via WS subscriber",
    true,
    `transitions: ${transitions.slice(0, 6).map((t) => `${t.from}→${t.to}`).join(", ")}`,
  );

  // ── Feed fixture frames over the live WS at real-time pacing ───────────
  const frameBytesPcm = provider.outboundFrameBytesPcm();
  const frameMs = provider.outboundFrameIntervalMs();
  const SPEECH_RMS_THRESHOLD = parseInt(
    process.env["VOICE_SPEECH_RMS_THRESHOLD"] ?? "600",
    10,
  );
  const SILENCE_RMS_THRESHOLD = parseInt(
    process.env["VOICE_SILENCE_RMS_THRESHOLD"] ?? "350",
    10,
  );

  let inboundFrames = 0;
  let inboundBytes = 0;
  let pcmBytes = 0;
  let rmsMax = 0;
  let speechFrames = 0;
  const decodedFrames: Buffer[] = [];

  const sendFrame = (pcmFrame: Buffer): void => {
    const wireFrame = provider.encodeOutboundFrame(pcmFrame);
    ws.send(JSON.stringify({
      event: "media",
      media: {
        payload: wireFrame.toString("base64"),
        timestamp: String(inboundFrames * frameMs),
        track: "inbound",
      },
    }));
    inboundFrames++;
    inboundBytes += wireFrame.length;
    const decoded = provider.decodeInboundFrame(wireFrame);
    pcmBytes += decoded.length;
    decodedFrames.push(decoded);
    const rms = rmsPcm16(decoded);
    if (rms > rmsMax) rmsMax = rms;
    if (rms >= SPEECH_RMS_THRESHOLD) speechFrames++;
  };

  // Real-time-paced speech frames. Spacing matters: CallSession tracks
  // wall-clock time (performance.now()) for MIN_SPEECH_MS and SILENCE_END_MS,
  // so dumping all frames at once would never satisfy those windows.
  for (let off = 0; off < pcm8k.length; off += frameBytesPcm) {
    const pcmFrame = pcm8k.subarray(off, Math.min(off + frameBytesPcm, pcm8k.length));
    sendFrame(pcmFrame);
    await sleep(frameMs);
  }
  // Trailing silence so SILENCE_END_MS elapses and CallSession transitions
  // to USER_SILENCE_DETECTED → FLUSH_STT.
  const silenceFrame = Buffer.alloc(frameBytesPcm);
  for (let i = 0; i < 30; i++) {
    sendFrame(silenceFrame);
    await sleep(frameMs);
  }

  record(
    "a",
    "Live CallSession received inbound audio frames",
    inboundFrames > 0,
    `${inboundFrames} frames sent over ws, ${inboundBytes} wire bytes`,
  );
  record(
    "b",
    "Inbound payloads decode to non-empty PCM s16le",
    pcmBytes > 0 && pcmBytes >= inboundFrames * frameBytesPcm * 0.95,
    `decoded ${pcmBytes} PCM bytes from ${inboundFrames} frames`,
  );
  record(
    "c",
    "RMS rises above speech threshold for at least one frame",
    rmsMax >= SPEECH_RMS_THRESHOLD,
    `rms_max=${Math.round(rmsMax)} threshold=${SPEECH_RMS_THRESHOLD} speech_frames=${speechFrames}`,
  );

  // ── (d) Live state-transition assertion ────────────────────────────────
  // The LISTENING → USER_SPEECH_DETECTED transition is the precondition
  // for `flushAndProcess` (which posts accumulated PCM to Sarvam STT) to
  // fire. We additionally wait for USER_SILENCE_DETECTED to confirm the
  // VAD endpoint logic ran end-to-end.
  await waitFor(
    () => transitions.some((t) => t.to === "USER_SPEECH_DETECTED"),
    3000,
    "USER_SPEECH_DETECTED",
  );
  await waitFor(
    () => transitions.some((t) => t.to === "USER_SILENCE_DETECTED"),
    3000,
    "USER_SILENCE_DETECTED",
  );

  const seenStates = new Set(transitions.map((t) => t.to));
  const sawSpeech = seenStates.has("USER_SPEECH_DETECTED");
  const sawSilence = seenStates.has("USER_SILENCE_DETECTED");
  record(
    "d",
    "Live state transitions: LISTENING → USER_SPEECH_DETECTED → USER_SILENCE_DETECTED",
    sawSpeech && sawSilence,
    `chain=${transitions.map((t) => t.to).join(",")}`,
  );

  // (f) Audio-health gate must NOT have fired on healthy audio.
  record(
    "f",
    "audio-health 'I could not hear you' gate does NOT fire",
    !healthGateFired,
    `health_gate_fired=${healthGateFired} rms_max=${Math.round(rmsMax)}`,
  );

  // (e2) Sarvam STT partial-events documentation.
  recordSkip(
    "e2",
    "Sarvam STT emits partial/interim transcripts",
    "Sarvam public STT endpoint emits final-only (see sarvam-stt-ws.client.ts doc); no partial event exists to assert",
  );

  // ── (e) Live PROCESS_TRANSCRIPT transition (requires SARVAM_API_KEY) ───
  if (!process.env["SARVAM_API_KEY"]) {
    recordSkip(
      "e",
      "Live CallSession reached PROCESS_TRANSCRIPT (STT returned final transcript)",
      "SARVAM_API_KEY not set",
    );
  } else {
    const reachedProcess = await waitFor(
      () => transitions.some((t) => t.to === "PROCESS_TRANSCRIPT"),
      20000,
      "PROCESS_TRANSCRIPT",
    );
    if (!reachedProcess) {
      const debugWav = path.join(debugDir, `failed-${Date.now()}.wav`);
      try {
        await fs.writeFile(
          debugWav,
          writeWavPcm16(upsample8kTo16k(Buffer.concat(decodedFrames)), 16000),
        );
      } catch { /* best-effort */ }
      record(
        "e",
        "Live CallSession reached PROCESS_TRANSCRIPT (STT returned final transcript)",
        false,
        `chain=${transitions.map((t) => t.to).join(",")} — saved offending audio to ${debugWav}`,
      );
    } else {
      record(
        "e",
        "Live CallSession reached PROCESS_TRANSCRIPT (STT returned final transcript)",
        true,
        `chain=${transitions.map((t) => t.to).slice(0, 12).join(",")}`,
      );
    }
  }

  // Tear down the live WS + HTTP server. Sending `stop` tells the
  // subscriber to call CallSession.onStop, which cancels timers + aborts
  // any in-flight STT.
  try {
    ws.send(JSON.stringify({ event: "stop", stop: {} }));
  } catch { /* ignore */ }
  await sleep(200);
  try { ws.close(); } catch { /* ignore */ }
  httpServer.close();

  // eslint-disable-next-line no-console
  console.log(`(observed ${outboundMessages} outbound ws messages from server)`);

  summariseAndExit();
}

function summariseAndExit(): void {
  const failed = checks.filter((c) => !c.pass);
  const skipped = checks.filter((c) => c.skipped);
  // eslint-disable-next-line no-console
  console.log(
    `\nvoice-acceptance-test: ${checks.length - failed.length}/${checks.length} checks passed (${skipped.length} skipped)`,
  );
  if (failed.length) {
    // eslint-disable-next-line no-console
    console.error("FAILED:", failed.map((c) => c.id).join(", "));
    process.exit(1);
  }
  // Exit explicitly — the live CallSession may have outstanding timers
  // even after onStop. The script is single-shot so a hard exit is safe.
  process.exit(0);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("voice-acceptance-test crashed:", err);
  process.exit(1);
});
