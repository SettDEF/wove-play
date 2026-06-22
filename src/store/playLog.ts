import { create } from "zustand";
import type { Track } from "@/lib/types";

// Per-hour-of-day genre play history → adaptive time-of-day mixes. We keep only tiny (hour → genre →
// count) tallies — no timestamps, no per-track rows — so the "Morning/Evening mix" can lean toward
// what you ACTUALLY play at this hour instead of a fixed pool. A per-hour cap halves old counts once
// they grow large, so recent habits gradually outweigh stale ones (it stays adaptive over time).

const LS = "wavrplay-playlog";
const CAP = 240; // when an hour's busiest genre passes this, halve that hour → slow decay of old habits
type HourMap = Record<string, number>; // genre (lowercased) → weighted count
type Clock = HourMap[]; // length 24, indexed by hour

const emptyClock = (): Clock => Array.from({ length: 24 }, () => ({}));
function load(): Clock {
  try { const a = JSON.parse(localStorage.getItem(LS) || ""); return Array.isArray(a) && a.length === 24 ? a : emptyClock(); }
  catch { return emptyClock(); }
}
function persist(c: Clock) { try { localStorage.setItem(LS, JSON.stringify(c)); } catch { /* ignore */ } }

interface PlayLogState {
  clock: Clock;
  /** Record one play against the current hour (no-op for tracks without a genre tag). */
  logPlay: (t: Track) => void;
  /** Normalised genre → weight (0..1) for an hour, blended with its neighbours so habits bleed across
   *  the slot boundary and a single off-hour play doesn't dominate. `{}` until there's any history. */
  hourPrefs: (hour: number) => Record<string, number>;
}

export const usePlayLog = create<PlayLogState>((set, get) => ({
  clock: load(),
  logPlay: (t) => {
    const g = t.genre?.trim().toLowerCase();
    if (!g) return;
    const h = new Date().getHours();
    set((s) => {
      const clock = s.clock.map((m) => ({ ...m }));
      const hour = clock[h];
      hour[g] = (hour[g] || 0) + 1;
      if ((hour[g] || 0) >= CAP) for (const k in hour) hour[k] /= 2; // decay this hour's old weight
      persist(clock);
      return { clock };
    });
  },
  hourPrefs: (hour) => {
    const c = get().clock;
    const acc: Record<string, number> = {};
    for (const [dh, w] of [[0, 1], [-1, 0.5], [1, 0.5]] as const) {
      const m = c[(hour + dh + 24) % 24];
      for (const k in m) acc[k] = (acc[k] || 0) + m[k] * w;
    }
    const max = Math.max(0, ...Object.values(acc));
    if (!max) return {};
    const out: Record<string, number> = {};
    for (const k in acc) out[k] = acc[k] / max;
    return out;
  },
}));
