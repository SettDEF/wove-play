import { engine } from "@/audio/engine";
import type { Section } from "./trackAnalysis";

/**
 * LIVE sections (Phase 2 of SECTIONS_LIVE_PLAN): build a provisional song-structure map *as the track
 * plays* by folding the analyser's energy into time buckets, so long tracks / DJ mixes show segments
 * filling in with playback instead of waiting on a full-file decode. The precise offline pass replaces
 * these the moment it resolves. Cheap: one freq read per sample, O(buckets) to segment.
 */

const BUCKET = 2; // seconds of audio per energy bucket — coarse but fast, refined by the offline pass

interface LiveState { id: string; energy: number[]; counts: number[]; maxPos: number }
let state: LiveState | null = null;

/** Sample the analyser NOW and fold the current energy into the playing track's timeline. Call a few
 *  times a second while playing. No-op when the graph is idle (paused) or there's no analyser. */
export function sampleLive(id: string, posSec: number): void {
  const an = engine.analyser;
  if (!an || posSec < 0) return;
  if (!state || state.id !== id) state = { id, energy: [], counts: [], maxPos: 0 };
  const n = an.frequencyBinCount;
  const buf = new Uint8Array(n);
  an.getByteFrequencyData(buf);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += buf[i];
  const e = sum / n / 255; // mean loudness, 0..1
  if (e <= 0.001) return;   // silence / not actually playing → don't poison the map
  const b = Math.floor(posSec / BUCKET);
  state.energy[b] = (state.energy[b] ?? 0) + e;
  state.counts[b] = (state.counts[b] ?? 0) + 1;
  if (posSec > state.maxPos) state.maxPos = posSec;
}

const labelFor = (tier: 0 | 1 | 2, first: boolean): string =>
  first ? "Intro" : tier === 2 ? "Drop" : tier === 1 ? "Verse" : "Break";

/** Provisional sections (track-fraction ranges) from the energy gathered so far — only up to the played
 *  position. Returns [] until enough has played to be meaningful. */
export function liveSections(id: string, durSec: number): Section[] {
  if (!state || state.id !== id || durSec <= 0) return [];
  const nb = Math.ceil(state.maxPos / BUCKET);
  if (nb < 3) return [];
  // mean energy per bucket, carrying the last value across any un-sampled gaps (e.g. played off-screen)
  const en: number[] = [];
  for (let b = 0; b < nb; b++) en[b] = state.counts[b] ? state.energy[b] / state.counts[b] : (en[b - 1] ?? 0);
  const sm = en.map((_, i) => (en[Math.max(0, i - 1)] + en[i] + en[Math.min(nb - 1, i + 1)]) / 3);
  const max = Math.max(...sm, 0.0001);
  const tierOf = (v: number): 0 | 1 | 2 => (v >= max * 0.72 ? 2 : v >= max * 0.4 ? 1 : 0);

  const out: Section[] = [];
  let startB = 0;
  let curT = tierOf(sm[0]);
  for (let b = 1; b <= nb; b++) {
    const t = b < nb ? tierOf(sm[b]) : -1;
    if (t !== curT || b === nb) {
      const startSec = startB * BUCKET;
      const endSec = Math.min(b * BUCKET, state.maxPos);
      if (endSec - startSec >= BUCKET) {
        // merge into the previous section if it's the same tier (smooths single-bucket flickers)
        const prev = out[out.length - 1];
        if (prev && prev.tier === curT) prev.end = endSec / durSec;
        else out.push({ start: startSec / durSec, end: endSec / durSec, tier: curT, label: labelFor(curT, out.length === 0) });
      }
      startB = b;
      curT = t as 0 | 1 | 2;
    }
  }
  return out.length >= 2 ? out : [];
}

/** Energy tier (0 Break / 1 Verse / 2 Drop) for a track-fraction range, from the live map — so a
 *  section's SUBsections can be labelled by what's actually happening there. null if no data yet. */
export function tierForRange(id: string, startFrac: number, endFrac: number, durSec: number): 0 | 1 | 2 | null {
  if (!state || state.id !== id || durSec <= 0) return null;
  const nb = Math.ceil(state.maxPos / BUCKET);
  if (nb < 2) return null;
  const en: number[] = [];
  for (let b = 0; b < nb; b++) en[b] = state.counts[b] ? state.energy[b] / state.counts[b] : (en[b - 1] ?? 0);
  const max = Math.max(...en, 0.0001);
  const b0 = Math.max(0, Math.floor((startFrac * durSec) / BUCKET));
  const b1 = Math.min(nb, Math.ceil((endFrac * durSec) / BUCKET));
  let s = 0, c = 0;
  for (let b = b0; b < b1; b++) { s += en[b]; c++; }
  if (!c) return null;
  const v = s / c;
  return v >= max * 0.72 ? 2 : v >= max * 0.4 ? 1 : 0;
}

/** Forget the accumulated map (e.g. on a full stop). */
export function resetLiveSections(): void { state = null; }
