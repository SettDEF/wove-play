/**
 * Phase 3 of SECTIONS_LIVE_PLAN — identify which of the user's OWN library tracks play inside a long
 * track / DJ mix, via a compact on-device acoustic fingerprint (the "chiffre") + a sliding match.
 *
 * This file is the pure algorithm: build a fingerprint from decoded audio, and slide one fingerprint
 * over another to find where (and how well) it matches. No I/O, no DOM — so it runs the same in a
 * Worker (heavy decode/compute) or a test. v1 targets EXACT library matches (same recording remixed in).
 */

export const FP_RATE = 4000;   // Hz — hard-downsample target; structure lives well below 2kHz
export const FP_FRAME = FP_RATE; // 1 second of audio per frame
export const FP_BANDS = 12;     // log-spaced energy bands per frame (a coarse "chroma")
const MIN_MATCH_FRAMES = 25;    // need ≥ ~25s of contiguous agreement to call it the same track
const MATCH_THRESH = 0.84;      // mean cosine over the matched span

/** A track's fingerprint: `frames` int8 band-energy vectors (FP_BANDS each), one per second. */
export interface Fingerprint { frames: Int8Array; n: number } // frames = n × FP_BANDS, row-major

export interface MixMatch { trackId: string; startSec: number; endSec: number; score: number }

// ── compact iterative radix-2 FFT (magnitudes only) ─────────────────────────────────────────────
function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { const tr = re[i]; re[i] = re[j]; re[j] = tr; const ti = im[i]; im[i] = im[j]; im[j] = ti; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cwr = 1, cwi = 0;
      for (let k = 0; k < len >> 1; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + (len >> 1)] * cwr - im[i + k + (len >> 1)] * cwi;
        const vi = re[i + k + (len >> 1)] * cwi + im[i + k + (len >> 1)] * cwr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + (len >> 1)] = ur - vr; im[i + k + (len >> 1)] = ui - vi;
        const nwr = cwr * wr - cwi * wi; cwi = cwr * wi + cwi * wr; cwr = nwr;
      }
    }
  }
}

/** Average all channels to mono and decimate to ~FP_RATE (cheap box-average, no anti-alias filter —
 *  fine for a coarse fingerprint). */
export function toMono(channels: Float32Array[], sampleRate: number): Float32Array {
  const src = channels[0];
  const step = Math.max(1, Math.round(sampleRate / FP_RATE));
  const out = new Float32Array(Math.floor(src.length / step));
  for (let o = 0; o < out.length; o++) {
    let s = 0;
    for (let c = 0; c < channels.length; c++) s += channels[c][o * step] || 0;
    out[o] = s / channels.length;
  }
  return out;
}

/** Build a fingerprint from already-mono, already-~FP_RATE audio. */
export function fingerprint(mono: Float32Array): Fingerprint {
  const N = 4096; // FFT size (≥ FP_FRAME)
  const re = new Float32Array(N), im = new Float32Array(N);
  const nFrames = Math.floor(mono.length / FP_FRAME);
  const frames = new Int8Array(nFrames * FP_BANDS);
  // log band edges from 40Hz..1800Hz mapped to FFT bins
  const edges = new Array(FP_BANDS + 1);
  for (let b = 0; b <= FP_BANDS; b++) {
    const hz = 40 * Math.pow(1800 / 40, b / FP_BANDS);
    edges[b] = Math.min(N >> 1, Math.max(1, Math.round((hz / FP_RATE) * N)));
  }
  for (let f = 0; f < nFrames; f++) {
    re.fill(0); im.fill(0);
    const base = f * FP_FRAME;
    for (let i = 0; i < FP_FRAME; i++) {
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FP_FRAME); // Hann
      re[i] = (mono[base + i] || 0) * w;
    }
    fft(re, im);
    const band = new Float32Array(FP_BANDS);
    let norm = 0;
    for (let b = 0; b < FP_BANDS; b++) {
      let e = 0;
      for (let k = edges[b]; k < edges[b + 1]; k++) e += Math.sqrt(re[k] * re[k] + im[k] * im[k]);
      const v = Math.log1p(e);
      band[b] = v; norm += v * v;
    }
    norm = Math.sqrt(norm) || 1;
    for (let b = 0; b < FP_BANDS; b++) frames[f * FP_BANDS + b] = Math.max(-127, Math.min(127, Math.round((band[b] / norm) * 127)));
  }
  return { frames, n: nFrames };
}

/** Cosine of two int8 frame rows. */
function frameCos(a: Int8Array, ai: number, b: Int8Array, bi: number): number {
  let dot = 0, na = 0, nb = 0;
  for (let k = 0; k < FP_BANDS; k++) { const x = a[ai + k], y = b[bi + k]; dot += x * y; na += x * x; nb += y * y; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

/**
 * Find where `lib` (a library track's fingerprint) best appears inside `mix`. Slides lib over mix; at
 * the best offset, if a long-enough span agrees strongly, returns the mix start/length + mean score.
 * Returns null if no confident match. Coarse (1s frames) so cost is O(mixFrames × libFrames × BANDS).
 */
export function matchInMix(mix: Fingerprint, lib: Fingerprint): { startFrame: number; lenFrames: number; score: number } | null {
  if (lib.n < MIN_MATCH_FRAMES || mix.n < MIN_MATCH_FRAMES) return null;
  const span = Math.min(lib.n, mix.n);
  let best = { off: -1, score: 0 };
  for (let off = 0; off + MIN_MATCH_FRAMES <= mix.n; off++) {
    const len = Math.min(span, mix.n - off);
    let sum = 0;
    for (let f = 0; f < len; f++) sum += frameCos(mix.frames, (off + f) * FP_BANDS, lib.frames, f * FP_BANDS);
    const mean = sum / len;
    if (mean > best.score) best = { off, score: mean };
  }
  if (best.off < 0 || best.score < MATCH_THRESH) return null;
  return { startFrame: best.off, lenFrames: Math.min(span, mix.n - best.off), score: best.score };
}

/** Match a mix against many library fingerprints; returns confident, non-overlapping hits (best first). */
export function identifyMix(mix: Fingerprint, lib: { id: string; fp: Fingerprint }[]): MixMatch[] {
  const hits: MixMatch[] = [];
  for (const { id, fp } of lib) {
    const m = matchInMix(mix, fp);
    if (m) hits.push({ trackId: id, startSec: m.startFrame, endSec: m.startFrame + m.lenFrames, score: m.score });
  }
  hits.sort((a, b) => b.score - a.score);
  // drop overlaps (keep the higher-scoring hit for a given mix region)
  const kept: MixMatch[] = [];
  for (const h of hits) {
    if (kept.some((k) => h.startSec < k.endSec && h.endSec > k.startSec)) continue;
    kept.push(h);
  }
  return kept.sort((a, b) => a.startSec - b.startSec);
}
