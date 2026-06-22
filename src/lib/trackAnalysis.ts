/**
 * In-webview track analysis for the "the seekbar is the song" feature: decode the current track and
 * compute (a) a real peak waveform and (b) energy-based sections (intro/verse/drop/breakdown read as
 * low/mid/high energy tiers). 100% local, no DAW port, no native — works wherever the file bytes are
 * fetchable (desktop asset URLs + Android blob URLs). Cached per track id; one track analysed at a time.
 */
import { timed } from "./lagMonitor";

export interface Section { start: number; end: number; tier: 0 | 1 | 2; label: string } // fractions of the track
/** A real min/max waveform envelope (both arrays length WR, normalized −1..1). Supports a true
 *  Audacity-style mirrored render and zooming in (slice the window) without re-decoding. */
export interface WaveEnvelope { min: Float32Array; max: Float32Array }
export interface TrackAnalysis { peaks: number[]; wave: WaveEnvelope; sections: Section[]; bpm: number }

const N = 400;  // coarse waveform/energy resolution (sections + fallback bars)
const WR = 6000; // high-res min/max envelope resolution — enough detail to read a REAL waveform when you
                 // zoom the timeline right in (the render samples per-pixel, so a big WR is cheap to draw;
                 // the analysis pass is chunked so building it doesn't hitch). [waveform zoom]
const cache = new Map<string, TrackAnalysis | null>();
const pending = new Set<string>();
let decoder: AudioContext | null = null;

function ctx(): AudioContext {
  const C = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  if (!decoder) decoder = new C();
  return decoder;
}

/** Group the smoothed energy curve into a few low/mid/high-energy sections (hysteresis + min length). */
function segment(energy: number[]): Section[] {
  const n = energy.length;
  const W = Math.max(2, Math.floor(n * 0.02));
  const sm = new Array(n).fill(0);
  for (let i = 0; i < n; i++) { let s = 0, c = 0; for (let j = -W; j <= W; j++) { const k = i + j; if (k >= 0 && k < n) { s += energy[k]; c++; } } sm[i] = s / c; }
  const sorted = [...sm].sort((a, b) => a - b);
  const lo = sorted[Math.floor(n * 0.1)], hi = sorted[Math.floor(n * 0.9)] || 1;
  const norm = sm.map((v) => Math.max(0, Math.min(1, (v - lo) / Math.max(1e-4, hi - lo))));
  const tierOf = (v: number, cur: number): 0 | 1 | 2 => {
    const t1 = cur >= 1 ? 0.34 : 0.44, t2 = cur >= 2 ? 0.62 : 0.72; // hysteresis avoids flicker
    return v >= t2 ? 2 : v >= t1 ? 1 : 0;
  };
  const tiers: (0 | 1 | 2)[] = new Array(n).fill(1);
  let cur: 0 | 1 | 2 = 1;
  for (let i = 0; i < n; i++) { cur = tierOf(norm[i], cur); tiers[i] = cur; }
  const segs: Section[] = [];
  let s0 = 0;
  for (let i = 1; i <= n; i++) { if (i === n || tiers[i] !== tiers[i - 1]) { segs.push({ start: s0 / n, end: i / n, tier: tiers[i - 1], label: "" }); s0 = i; } }
  const minLen = Math.max(2, Math.floor(n * 0.035));
  const merged: Section[] = [];
  for (const seg of segs) {
    const len = (seg.end - seg.start) * n;
    if (merged.length && len < minLen) merged[merged.length - 1].end = seg.end; // absorb tiny bits
    else merged.push({ ...seg });
  }
  // semantic labels: first = Intro, last = Outro, else by energy tier
  for (let i = 0; i < merged.length; i++) {
    const s = merged[i];
    s.label = i === 0 ? "Intro" : i === merged.length - 1 ? "Outro"
      : s.tier === 2 ? "Drop" : s.tier === 0 ? "Break" : "Verse";
  }
  return merged;
}

/**
 * Rough in-webview tempo (BPM) via autocorrelation of an energy-onset envelope, folded to ~60–200.
 * NOT run on every song switch (too slow + the native beatgrid is more accurate) — kept exported as a
 * selectable "fast/rough" algorithm for the planned Audio-settings algorithm picker (task #180).
 */
export function computeBpm(ch: Float32Array, sr: number): number {
  const hop = Math.max(1, Math.floor(sr * 0.011));
  const frames = Math.floor(ch.length / hop);
  if (frames < 64 || sr <= 0) return 0;
  const en = new Float32Array(frames);
  for (let f = 0; f < frames; f++) { const a = f * hop, b = Math.min(ch.length, a + hop); let s = 0; for (let i = a; i < b; i++) s += ch[i] * ch[i]; en[f] = Math.sqrt(s / Math.max(1, b - a)); }
  const on = new Float32Array(frames);
  let mean = 0;
  for (let f = 1; f < frames; f++) { const d = en[f] - en[f - 1]; on[f] = d > 0 ? d : 0; mean += on[f]; }
  mean /= frames;
  for (let f = 0; f < frames; f++) on[f] -= mean;
  const fps = sr / hop;
  const minLag = Math.max(1, Math.floor((fps * 60) / 200)), maxLag = Math.ceil((fps * 60) / 60);
  let bestLag = minLag, best = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    for (let f = lag; f < frames; f++) sum += on[f] * on[f - lag];
    const cand = (fps * 60) / lag;
    sum *= Math.exp(-0.5 * Math.pow(Math.log2(cand / 130) / 0.9, 2)); // ~130 BPM octave-bias
    if (sum > best) { best = sum; bestLag = lag; }
  }
  return Math.round((fps * 60) / bestLag);
}

/** Synchronous cache peek: the cached analysis, `null` if a prior decode failed, or `undefined` if this
 *  track hasn't been analysed yet. Lets the player show a known waveform/sections INSTANTLY on re-open
 *  (no re-decode, no empty flash) instead of re-running the async pass. */
export function peekAnalysis(id: string): TrackAnalysis | null | undefined {
  return cache.has(id) ? (cache.get(id) ?? null) : undefined;
}

/** Decode a track to its raw channel data (shared decoder context). For the mix-ID fingerprinter, which
 *  needs the samples but not the waveform/section analysis. Returns null on failure. */
export async function decodeChannels(url: string): Promise<{ channels: Float32Array[]; sampleRate: number } | null> {
  try {
    const bytes = await (await fetch(url)).arrayBuffer();
    const audio = await ctx().decodeAudioData(bytes);
    const channels: Float32Array[] = [];
    for (let c = 0; c < audio.numberOfChannels; c++) channels.push(audio.getChannelData(c));
    return { channels, sampleRate: audio.sampleRate };
  } catch { return null; }
}

/** Decode + analyse a track (cached). Returns null while pending or on failure. `withBpm` runs the
 *  extra full-sample autocorrelation pass — skip it unless the fast BPM algorithm is actually in use
 *  (the player shows the native BPM by default), since it doubles the post-decode main-thread cost. */
export async function analyzeTrack(id: string, url: string, withBpm = false, alive?: () => boolean): Promise<TrackAnalysis | null> {
  if (cache.has(id)) return cache.get(id) ?? null;
  if (pending.has(id)) return null;
  pending.add(id);
  const dead = () => alive ? !alive() : false; // you've skipped past this track → abandon the heavy work
  try {
    const bytes = await (await fetch(url)).arrayBuffer();
    if (dead()) return null;                                   // skipped away while the (whole-file) fetch ran
    const audio = await timed("waveform-decode", () => ctx().decodeAudioData(bytes));
    if (dead()) return null;                                   // …or while decoding → don't run the sample passes
    const ch = audio.getChannelData(0);
    // ONE pass over the samples builds the high-res min/max/peak/rms envelope (WR buckets); the coarse
    // N-bucket peaks + energy are then DOWN-sampled from it. CHUNKED + yielding: a 3-min track is millions
    // of samples, and doing the whole pass synchronously was the "big lag when skipping" — now it runs a
    // few hundred buckets, yields to the event loop, and bails if you've skipped away. [perf — skip]
    const wmin = new Float32Array(WR), wmax = new Float32Array(WR), wpk = new Float32Array(WR), wrms = new Float32Array(WR);
    const wblock = Math.max(1, Math.floor(ch.length / WR));
    let amp = 1e-4;
    const CHUNK = 200;
    for (let b0 = 0; b0 < WR; b0 += CHUNK) {
      const bEnd = Math.min(WR, b0 + CHUNK);
      for (let b = b0; b < bEnd; b++) {
        const s = b * wblock, e = Math.min(ch.length, s + wblock);
        let mn = 0, mx = 0, sum = 0;
        for (let i = s; i < e; i++) { const v = ch[i]; if (v > mx) mx = v; else if (v < mn) mn = v; sum += v * v; }
        wmin[b] = mn; wmax[b] = mx;
        const pk = mx > -mn ? mx : -mn; wpk[b] = pk; wrms[b] = Math.sqrt(sum / Math.max(1, e - s));
        if (pk > amp) amp = pk;
      }
      if (bEnd < WR) { await new Promise<void>((r) => setTimeout(r)); if (dead()) return null; }
    }
    for (let b = 0; b < WR; b++) { wmin[b] /= amp; wmax[b] /= amp; }
    const peaks = new Array(N).fill(0);
    const energy = new Array(N).fill(0);
    const ratio = WR / N;
    let pmax = 1e-4;
    for (let i = 0; i < N; i++) {
      const s = Math.floor(i * ratio), e = Math.floor((i + 1) * ratio);
      let pk = 0, rs = 0;
      for (let b = s; b < e; b++) { if (wpk[b] > pk) pk = wpk[b]; rs += wrms[b]; }
      peaks[i] = pk; energy[i] = rs / Math.max(1, e - s);
      if (pk > pmax) pmax = pk;
    }
    for (let i = 0; i < N; i++) peaks[i] = Math.min(1, peaks[i] / pmax);
    if (dead()) return null; // last bail before the (optional, heavy) BPM autocorrelation pass
    // `bpm` is the FAST/rough webview algorithm (selectable in Settings → Audio); the player shows the
    // native genre-robust BPM by default. It's cheap next to the sample passes, so we keep it.
    const res: TrackAnalysis = { peaks, wave: { min: wmin, max: wmax }, sections: segment(energy), bpm: withBpm ? computeBpm(ch, audio.sampleRate) : 0 };
    cache.set(id, res);
    return res;
  } catch {
    cache.set(id, null); // don't retry a file we can't decode
    return null;
  } finally {
    pending.delete(id);
  }
}
