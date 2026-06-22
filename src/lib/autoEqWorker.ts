/**
 * AutoEq FFT worker — runs the heavy windowed FFT + per-band integration OFF the main thread, so
 * starting a track never stalls the UI while its spectrum is measured. Self-contained (no app imports
 * — workers can't touch the DOM/AudioContext): it receives the already-decoded mono PCM + sample rate
 * + the EQ band centres, and returns the 10 per-band dB levels. [perf P1]
 */
type Req = { id: number; ch: Float32Array; sr: number; freqs: number[] };
type Res = { id: number; levels: number[] | null };

const FFT = 4096;
const MAX_WINDOWS = 48;

/** In-place iterative radix-2 Cooley–Tukey FFT (same as the main-thread fallback). */
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

function bandEdges(freqs: number[]): number[] {
  const e: number[] = [freqs[0] / 1.5];
  for (let i = 0; i < freqs.length - 1; i++) e.push(Math.sqrt(freqs[i] * freqs[i + 1]));
  e.push(freqs[freqs.length - 1] * 1.5);
  return e;
}

function analyze(ch: Float32Array, sr: number, freqs: number[]): number[] | null {
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
  const edges = bandEdges(freqs);
  const levels: number[] = [];
  const binHz = sr / FFT;
  for (let band = 0; band < freqs.length; band++) {
    const lo = Math.max(1, Math.floor(edges[band] / binHz));
    const hi = Math.min((FFT >> 1) - 1, Math.ceil(edges[band + 1] / binHz));
    let sum = 0, cnt = 0;
    for (let b = lo; b <= hi; b++) { sum += power[b]; cnt++; }
    const avg = cnt ? sum / cnt : 1e-12;
    levels.push(10 * Math.log10(avg + 1e-12));
  }
  return levels;
}

self.onmessage = (e: MessageEvent<Req>) => {
  const { id, ch, sr, freqs } = e.data;
  let levels: number[] | null = null;
  try { levels = analyze(ch, sr, freqs); } catch { levels = null; }
  (self as unknown as Worker).postMessage({ id, levels } as Res);
};
