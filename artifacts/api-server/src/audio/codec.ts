/**
 * Audio codec utilities — pure-TS, no native deps.
 *
 * Twilio Media Streams sends audio as G.711 μ-law, 8 kHz, mono, 20 ms frames
 * (160 bytes per frame). Sarvam STT expects PCM s16le. We therefore need:
 *   - μ-law  ↔  linear PCM s16le
 *   - 8 kHz  →  16 kHz upsample (linear interpolation)
 *   - 16 kHz →  8 kHz downsample (averaging)
 *   - RMS over a PCM s16le buffer
 *   - minimal RIFF/WAV writer for debug capture
 */

/** Decode a single μ-law byte (0..255) to a 16-bit linear PCM sample. */
export function muLawByteToPcm16(u: number): number {
  u = ~u & 0xff;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  let sample = ((mantissa << 3) + 0x84) << exponent;
  sample -= 0x84;
  return sign ? -sample : sample;
}

/** Encode a single 16-bit linear PCM sample to a μ-law byte (0..255). */
export function pcm16ToMuLawByte(sample: number): number {
  const BIAS = 0x84;
  const CLIP = 32635;
  let sign = 0;
  if (sample < 0) {
    sample = -sample;
    sign = 0x80;
  }
  if (sample > CLIP) sample = CLIP;
  sample += BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (sample & mask) === 0 && exponent > 0; mask >>= 1) {
    exponent--;
  }
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

/** Decode a μ-law buffer into PCM s16le (little-endian) bytes. */
export function muLawToPcm16(input: Buffer): Buffer {
  const out = Buffer.alloc(input.length * 2);
  for (let i = 0; i < input.length; i++) {
    out.writeInt16LE(muLawByteToPcm16(input[i]!), i * 2);
  }
  return out;
}

/** Encode PCM s16le bytes into μ-law. */
export function pcm16ToMuLaw(input: Buffer): Buffer {
  const samples = input.length >> 1;
  const out = Buffer.alloc(samples);
  for (let i = 0; i < samples; i++) {
    out[i] = pcm16ToMuLawByte(input.readInt16LE(i * 2));
  }
  return out;
}

/** Linear-interpolation upsample: 8 kHz PCM s16le → 16 kHz PCM s16le. */
export function upsample8kTo16k(input: Buffer): Buffer {
  const inSamples = input.length >> 1;
  const outSamples = inSamples * 2;
  const out = Buffer.alloc(outSamples * 2);
  for (let i = 0; i < inSamples; i++) {
    const a = input.readInt16LE(i * 2);
    const b = i + 1 < inSamples ? input.readInt16LE((i + 1) * 2) : a;
    out.writeInt16LE(a, i * 4);
    out.writeInt16LE(((a + b) / 2) | 0, i * 4 + 2);
  }
  return out;
}

/** Downsample by averaging pairs: 16 kHz PCM s16le → 8 kHz PCM s16le. */
export function downsample16kTo8k(input: Buffer): Buffer {
  const inSamples = input.length >> 1;
  const outSamples = inSamples >> 1;
  const out = Buffer.alloc(outSamples * 2);
  for (let i = 0; i < outSamples; i++) {
    const a = input.readInt16LE(i * 4);
    const b = input.readInt16LE(i * 4 + 2);
    out.writeInt16LE(((a + b) / 2) | 0, i * 2);
  }
  return out;
}

/** RMS amplitude (0..32767) over a PCM s16le buffer. */
export function rmsPcm16(buf: Buffer): number {
  const samples = buf.length >> 1;
  if (samples === 0) return 0;
  let sumSq = 0;
  for (let i = 0; i < samples; i++) {
    const s = buf.readInt16LE(i * 2);
    sumSq += s * s;
  }
  return Math.sqrt(sumSq / samples);
}

/** Peak absolute amplitude (0..32768) over a PCM s16le buffer. */
export function peakPcm16(buf: Buffer): number {
  const samples = buf.length >> 1;
  let peak = 0;
  for (let i = 0; i < samples; i++) {
    const v = Math.abs(buf.readInt16LE(i * 2));
    if (v > peak) peak = v;
  }
  return peak;
}

/**
 * Build a minimal RIFF/WAVE PCM file for the given mono PCM s16le buffer.
 * sampleRate is in Hz (e.g. 8000 or 16000). Always mono / 16-bit.
 */
export function writeWavPcm16(pcm: Buffer, sampleRate: number): Buffer {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = pcm.length;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);                  // PCM chunk size
  header.writeUInt16LE(1, 20);                   // PCM format
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcm]);
}
