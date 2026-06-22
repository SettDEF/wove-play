/**
 * Per-track AutoEq: measure a song's average spectral balance and derive a corrective 10-band curve
 * that nudges it toward a pleasant house target (tame harsh/boomy tracks, lift dull ones). 100% local
 * — decode in the WebView, average the magnitude spectrum over the track, integrate into the same 10
 * octave bands the EQ uses, then move each band a fraction of the way to the target. Result is a full
 * EqSnapshot the player applies via the parametric path. Cached per track id (analysis is the slow part).
 */
import { EQ_FREQS } from "@/audio/engine";
import type { EqSnapshot } from "@/lib/types";
import { timed } from "@/lib/lagMonitor";

const FFT = 4096;
const MAX_WINDOWS = 48;       // windows averaged across the track — plenty for a stable average
const STRENGTH = 0.5;         // how far toward the target we move (0 = none, 1 = full)
const GMAX = 6;               // clamp the suggested gains to ±6 dB (musical, not surgical)

/** House target as RELATIVE band levels (mean-removed internally): a gentle warm-but-clear balance —
 *  slight low-end lift, a small 2–4 kHz dip to de-harsh, a touch of air. */
const TARGET = [4, 3, 1.5, 0, -0.5, -0.5, -1.5, -1, 1, 0.5];

const cache = new Map<string, number[] | null>(); // id → per-band dB levels (null = un-analysable)
const pending = new Map<string, Promise<number[] | null>>();
let actx: AudioContext | null = null;
function ctx(): AudioContext {
  const C = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  if (!actx) actx = new C();
  return actx;
}

// ── Persistent cache ────────────────────────────────────────────────────────
// Measuring a track is the slow part; the result only depends on the file's content, so persist the
// per-band levels across launches → first play after a restart is instant instead of re-analysing.
// Only SUCCESSFUL measurements are stored (a transient null retries next launch). [perf P1]
const LS = "wavrplay-autoeq";
const PERSIST_MAX = 3000;
function loadPersisted() {
  try {
    const o = JSON.parse(localStorage.getItem(LS) || "{}") as Record<string, number[]>;
    for (const k in o) if (Array.isArray(o[k])) cache.set(k, o[k]);
  } catch { /* ignore */ }
}
let saveTimer: ReturnType<typeof setTimeout> | null = null;
function persist() {
  if (saveTimer != null) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      while (cache.size > PERSIST_MAX) { const k = cache.keys().next().value; if (k === undefined) break; cache.delete(k); }
      const o: Record<string, number[]> = {};
      for (const [k, v] of cache) if (v) o[k] = v; // skip nulls — keep them in-memory only
      localStorage.setItem(LS, JSON.stringify(o));
    } catch { /* quota / ignore */ }
  }, 1500);
}
loadPersisted();

// ── Off-main-thread FFT (worker) with a main-thread fallback ──────────────────
let worker: Worker | null = null;
let workerOk = true;
let reqId = 0;
const reqs = new Map<number, (v: number[] | null) => void>();
function getWorker(): Worker | null {
  if (!workerOk) return null;
  if (worker) return worker;
  try {
    worker = new Worker(new URL("./autoEqWorker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<{ id: number; levels: number[] | null }>) => {
      const r = reqs.get(e.data.id);
      if (r) { reqs.delete(e.data.id); r(e.data.levels); }
    };
    worker.onerror = () => { workerOk = false; };
  } catch { workerOk = false; worker = null; }
  return worker;
}
/** Run the windowed FFT in the worker. Rejects on timeout/failure so the caller can fall back. */
function runWorker(w: Worker, ch: Float32Array, sr: number): Promise<number[] | null> {
  const copy = ch.slice(); // copy so transferring the buffer doesn't detach the AudioBuffer's data
  const id = ++reqId;
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => { reqs.delete(id); reject(new Error("autoeq worker timeout")); }, 20000);
    reqs.set(id, (v) => { clearTimeout(to); resolve(v); });
    w.postMessage({ id, ch: copy, sr, freqs: [...EQ_FREQS] }, [copy.buffer]);
  });
}
/** Measure per-band levels — worker if available, else on the main thread (best-effort). */
async function computeLevels(ch: Float32Array, sr: number): Promise<number[] | null> {
  const w = getWorker();
  if (w) {
    try { return await runWorker(w, ch, sr); }
    catch { workerOk = false; } // worker hung/unavailable → fall through to main thread this once
  }
  return analyzeMain(ch, sr);
}

/** In-place iterative radix-2 Cooley–Tukey FFT. */
function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { const tr = re[i]; re[i] = re[j]; re[j] = tr; const ti = im[i]; im[i] = im[j]; im[j] = ti; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len >> 1; k++) {
        const a = i + k, b = a + (len >> 1);
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

/** Geometric band edges around the 10 EQ centres (edge = sqrt of adjacent centres). */
function bandEdges(): number[] {
  const e: number[] = [EQ_FREQS[0] / 1.5];
  for (let i = 0; i < EQ_FREQS.length - 1; i++) e.push(Math.sqrt(EQ_FREQS[i] * EQ_FREQS[i + 1]));
  e.push(EQ_FREQS[EQ_FREQS.length - 1] * 1.5);
  return e;
}

/** Main-thread windowed FFT + band integration (fallback when the worker is unavailable). */
function analyzeMain(ch: Float32Array, sr: number): number[] | null {
  if (ch.length < FFT * 2 || sr <= 0) return null;
  const han = new Float32Array(FFT);
  for (let i = 0; i < FFT; i++) han[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT - 1));
  const usable = ch.length - FFT;
  const start = Math.floor(usable * 0.05), end = Math.floor(usable * 0.95);
  const nWin = Math.max(1, Math.min(MAX_WINDOWS, Math.floor((end - start) / FFT)));
  const step = nWin > 1 ? (end - start) / (nWin - 1) : 0;
  const power = new Float64Array(FFT >> 1);
  const re = new Float32Array(FFT), im = new Float32Array(FFT);
  for (let wi = 0; wi < nWin; wi++) {
    const off = Math.floor(start + wi * step);
    for (let i = 0; i < FFT; i++) { re[i] = ch[off + i] * han[i]; im[i] = 0; }
    fft(re, im);
    for (let b = 0; b < (FFT >> 1); b++) power[b] += re[b] * re[b] + im[b] * im[b];
  }
  const edges = bandEdges();
  const levels: number[] = [];
  const binHz = sr / FFT;
  for (let band = 0; band < EQ_FREQS.length; band++) {
    const lo = Math.max(1, Math.floor(edges[band] / binHz));
    const hi = Math.min((FFT >> 1) - 1, Math.ceil(edges[band + 1] / binHz));
    let sum = 0, cnt = 0;
    for (let b = lo; b <= hi; b++) { sum += power[b]; cnt++; }
    const avg = cnt ? sum / cnt : 1e-12;
    levels.push(10 * Math.log10(avg + 1e-12));
  }
  return levels;
}

/** Decode + measure the track's average per-band level (dB). Cached (persisted) + deduped. null on failure. */
export async function analyzeBands(id: string, url: string): Promise<number[] | null> {
  if (cache.has(id)) return cache.get(id) ?? null;
  const inflight = pending.get(id);
  if (inflight) return inflight;
  const p = (async () => {
    try {
      const bytes = await (await fetch(url)).arrayBuffer();
      const audio = await timed("autoeq-decode", () => ctx().decodeAudioData(bytes));
      const ch = audio.getChannelData(0);
      const sr = audio.sampleRate;
      if (ch.length < FFT * 2 || sr <= 0) return null;
      return await computeLevels(ch, sr); // worker (off main thread) → main-thread fallback
    } catch { return null; }
  })().then((v) => { cache.set(id, v); pending.delete(id); persist(); return v; });
  pending.set(id, p);
  return p;
}

/** Turn measured per-band levels into a corrective EqSnapshot moving the track toward TARGET. */
export function suggestCurve(name: string, levels: number[]): EqSnapshot {
  const n = EQ_FREQS.length;
  const meanL = levels.reduce((a, b) => a + b, 0) / n;
  const meanT = TARGET.reduce((a, b) => a + b, 0) / n;
  const gains = levels.map((l, i) => {
    const d = l - meanL;                  // measured, relative
    const t = TARGET[i] - meanT;          // target, relative
    const g = (t - d) * STRENGTH;
    return Math.max(-GMAX, Math.min(GMAX, Math.round(g * 2) / 2));
  });
  const maxBoost = Math.max(0, ...gains);
  const preamp = Math.max(-12, -(Math.round(maxBoost * 2) / 2)); // pull down so boosts don't clip
  return { name, gains, freqs: [...EQ_FREQS], qs: new Array(n).fill(1.1), preamp, enabled: true };
}

/** Convenience: analyze a track by id+url and return the suggested curve (null if un-analysable). */
export async function autoEqForTrack(id: string, url: string, name = "Auto"): Promise<EqSnapshot | null> {
  const levels = await analyzeBands(id, url);
  return levels ? suggestCurve(name, levels) : null;
}
