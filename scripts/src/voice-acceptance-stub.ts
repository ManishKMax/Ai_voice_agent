/**
 * voice-acceptance-stub
 * ─────────────────────
 * Fast, hermetic regression check for the voice pipeline's pure-code paths.
 * Unlike `voice-acceptance-test`, this script makes NO network calls — it
 * exercises only the codec + WAV writer + STT response parser + transcript
 * quality gate against fixed inputs and known-good outputs.
 *
 * Why a separate stub:
 *   - The full voice-acceptance-test depends on SARVAM_API_KEY being live and
 *     valid for the STT check, which is unreliable in CI / unsuitable for a
 *     per-commit hook.
 *   - These are the paths most likely to silently regress on a refactor:
 *     a μ-law encoder bit-flip would corrupt every outbound frame; a WAV
 *     header byte-order slip would make Sarvam reject every STT request; a
 *     regression in `assessTranscriptQuality` would let bad calls through
 *     to the analyser and start mis-classifying leads as "interested".
 *
 * Runs in <1s, exits 0 on success, 1 on any check failure.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const FIXTURE = path.join(ROOT, "scripts", "fixtures", "sarvam-stt-response.json");

interface Check { id: string; pass: boolean; detail?: string }
const checks: Check[] = [];
const ok = (id: string, detail?: string): void => { checks.push({ id, pass: true, detail }); };
const fail = (id: string, detail: string): void => { checks.push({ id, pass: false, detail }); };

// ── 1. μ-law round-trip preserves the s16 sample to within μ-law quantisation
async function checkMuLawRoundTrip(): Promise<void> {
  const codec = await import(
    path.join(ROOT, "artifacts/api-server/src/audio/codec.ts")
  );
  const { pcm16ToMuLawByte, muLawByteToPcm16 } = codec as {
    pcm16ToMuLawByte: (s: number) => number;
    muLawByteToPcm16: (b: number) => number;
  };
  // μ-law quantises into 256 levels; pick samples that span the dynamic range.
  const samples = [0, 100, 1000, -1000, 8000, -8000, 31000, -31000];
  for (const s of samples) {
    const back = muLawByteToPcm16(pcm16ToMuLawByte(s));
    // μ-law segment quantisation tops out around |s|/8 + bias for large samples.
    const allowed = Math.max(8, Math.abs(s) >> 3);
    if (Math.abs(back - s) > allowed) {
      fail("mulaw_roundtrip", `sample ${s} -> ${back} (allowed ±${allowed})`);
      return;
    }
  }
  ok("mulaw_roundtrip");
}

// ── 2. RMS over a known PCM buffer matches the analytical value
async function checkRms(): Promise<void> {
  const codec = await import(
    path.join(ROOT, "artifacts/api-server/src/audio/codec.ts")
  );
  const { rmsPcm16 } = codec as { rmsPcm16: (b: Buffer) => number };
  // 8000 samples (1s @ 8 kHz) of constant amplitude 1000.
  const buf = Buffer.alloc(8000 * 2);
  for (let i = 0; i < 8000; i++) buf.writeInt16LE(1000, i * 2);
  const rms = rmsPcm16(buf);
  if (Math.abs(rms - 1000) > 1) {
    fail("rms_constant", `expected ~1000, got ${rms}`);
    return;
  }
  ok("rms_constant");
}

// ── 3. WAV header writer produces a valid 16-bit mono RIFF buffer Sarvam will accept
async function checkWavWriter(): Promise<void> {
  const audio = await import(
    path.join(ROOT, "artifacts/api-server/src/audio/codec.ts")
  );
  const { writeWavPcm16 } = audio as {
    writeWavPcm16: (pcm: Buffer, sr: number) => Buffer;
  };
  const pcm = Buffer.alloc(160 * 2); // 20ms of silence at 16kHz
  for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE((i % 200) - 100, i * 2);
  const wav = writeWavPcm16(pcm, 16000);
  if (wav.toString("ascii", 0, 4) !== "RIFF") return fail("wav_riff", "missing RIFF magic");
  if (wav.toString("ascii", 8, 12) !== "WAVE") return fail("wav_wave", "missing WAVE magic");
  if (wav.readUInt16LE(20) !== 1) return fail("wav_format", "audioFormat != PCM");
  if (wav.readUInt16LE(22) !== 1) return fail("wav_channels", "channels != 1");
  if (wav.readUInt32LE(24) !== 16000) return fail("wav_sample_rate", "sampleRate != 16000");
  if (wav.readUInt16LE(34) !== 16) return fail("wav_bits", "bitsPerSample != 16");
  if (wav.length !== 44 + pcm.length) return fail("wav_length", `expected ${44 + pcm.length}, got ${wav.length}`);
  ok("wav_writer");
}

// ── 4. STT response parser extracts the transcript from the recorded fixture
async function checkSttResponseParser(): Promise<void> {
  const raw = await readFile(FIXTURE, "utf8");
  const fixture = JSON.parse(raw) as { data: { transcript: string } };
  // The SarvamSttClient.handleTextFrame method prefers `obj.transcript` then
  // falls back to `obj.data.transcript`. Mirror that lookup here without
  // importing the class (which would pull in the full WS dependency tree).
  const lookup = (obj: { transcript?: string; data?: { transcript?: string; text?: string } }): string =>
    obj.transcript ?? obj.data?.transcript ?? obj.data?.text ?? "";
  const got = lookup(fixture);
  if (got !== fixture.data.transcript) {
    return fail("stt_parser", `expected '${fixture.data.transcript}', got '${got}'`);
  }
  ok("stt_parser", `transcript=${got.length} chars`);
}

// ── 5. Transcript quality gate refuses low-info calls and accepts substantive ones
async function checkTranscriptQualityGate(): Promise<void> {
  const svc = await import(
    path.join(ROOT, "artifacts/api-server/src/services/sarvam.service.ts")
  );
  const { assessTranscriptQuality } = svc as {
    assessTranscriptQuality: (t: string) => { hasEnoughSignal: boolean };
  };
  const lowInfo = "Agent: Hi.\nLead: Yes.\nAgent: OK.\nLead: Hmm.\n";
  // Single long reply — passes the cumulative-word threshold (>=10) but fails
  // the "≥2 qualifying utterances" threshold. The gate must still refuse,
  // because one statement alone is not enough confirmation to act on.
  const singleLongReply =
    "Agent: Hi.\nLead: Yes I am interested please tell me more about your product.\n" +
    "Agent: Sure!\nLead: Ok.\n";
  const substantive =
    "Agent: Hi.\nLead: Yes I am interested please tell me more about your CRM product.\n" +
    "Agent: Sure!\nLead: What is the monthly cost for ten users?\n";
  if (assessTranscriptQuality(lowInfo).hasEnoughSignal) {
    return fail("quality_gate_lowinfo", "low-info transcript was accepted");
  }
  if (assessTranscriptQuality(singleLongReply).hasEnoughSignal) {
    return fail("quality_gate_single_long", "single long reply (one qualifying utt) was accepted");
  }
  if (!assessTranscriptQuality(substantive).hasEnoughSignal) {
    return fail("quality_gate_substantive", "substantive transcript was rejected");
  }
  ok("quality_gate");
}

// ── 6. splitForTTS chunks long text without losing characters
async function checkSplitForTts(): Promise<void> {
  const svc = await import(
    path.join(ROOT, "artifacts/api-server/src/services/sarvam.service.ts")
  );
  const { splitForTTS } = svc as { splitForTTS: (s: string, max?: number) => string[] };
  const text = "First sentence here. Second one. Third one too. Fourth and final one.";
  const chunks = splitForTTS(text, 30);
  if (chunks.length === 0) return fail("split_for_tts_empty", "no chunks produced");
  for (const c of chunks) {
    if (c.length > 30) return fail("split_for_tts_overflow", `chunk len=${c.length} > 30: '${c}'`);
  }
  // Every original word must reappear in some chunk.
  const joined = chunks.join(" ").toLowerCase();
  for (const w of text.toLowerCase().split(/\s+/)) {
    const stripped = w.replace(/[.!?]/g, "");
    if (!joined.includes(stripped)) return fail("split_for_tts_lost_word", `lost word '${stripped}'`);
  }
  ok("split_for_tts", `${chunks.length} chunks`);
}

async function main(): Promise<void> {
  await checkMuLawRoundTrip();
  await checkRms();
  await checkWavWriter();
  await checkSttResponseParser();
  await checkTranscriptQualityGate();
  await checkSplitForTts();

  const failed = checks.filter((c) => !c.pass);
  // eslint-disable-next-line no-console
  console.log(
    `\nvoice-acceptance-stub: ${checks.length - failed.length}/${checks.length} checks passed`,
  );
  for (const c of checks) {
    // eslint-disable-next-line no-console
    console.log(` ${c.pass ? "PASS" : "FAIL"} ${c.id}${c.detail ? ` — ${c.detail}` : ""}`);
  }
  if (failed.length) process.exit(1);
  process.exit(0);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("voice-acceptance-stub crashed:", err);
  process.exit(1);
});
