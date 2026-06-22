import { create } from "zustand";
import { recordEvent } from "@/lib/taste";

/** Per-track stats keyed by track id (= path). `skips` = early-abandon count (negative signal). */
export interface Stat { rating: number; plays: number; lastPlayed: number; skips?: number; }
export const EMPTY_STAT: Stat = { rating: 0, plays: 0, lastPlayed: 0, skips: 0 };

const LS = "wavrplay-ratings";
type StatMap = Record<string, Stat>;
function load(): StatMap { try { return JSON.parse(localStorage.getItem(LS) || "{}"); } catch { return {}; } }
function persist(m: StatMap) { try { localStorage.setItem(LS, JSON.stringify(m)); } catch { /* ignore */ } }

interface RatingsState {
  stats: StatMap;
  setRating: (id: string, rating: number) => void;
  bumpPlay: (id: string) => void;
  bumpSkip: (id: string) => void;
  stat: (id: string) => Stat;
}

export const useRatings = create<RatingsState>((set, get) => ({
  stats: load(),
  setRating: (id, rating) => set((s) => {
    const cur = s.stats[id] ?? EMPTY_STAT;
    // feed the taste engine: 4–5★ reads as Like, 1–2★ as Dislike (3★/clear = neutral, no signal)
    if (rating !== cur.rating) {
      if (rating >= 4) void recordEvent(id, "Like");
      else if (rating >= 1 && rating <= 2) void recordEvent(id, "Dislike");
    }
    const stats = { ...s.stats, [id]: { ...cur, rating } };
    persist(stats); return { stats };
  }),
  bumpPlay: (id) => set((s) => {
    const cur = s.stats[id] ?? EMPTY_STAT;
    const stats = { ...s.stats, [id]: { ...cur, plays: cur.plays + 1, lastPlayed: Math.floor(Date.now() / 1000) } };
    persist(stats); return { stats };
  }),
  // Early-abandon: a soft negative signal the recommender subtracts from affinity (capped so a few
  // skips of a track you otherwise love don't bury it).
  bumpSkip: (id) => set((s) => {
    const cur = s.stats[id] ?? EMPTY_STAT;
    const stats = { ...s.stats, [id]: { ...cur, skips: Math.min(10, (cur.skips ?? 0) + 1) } };
    persist(stats); return { stats };
  }),
  stat: (id) => get().stats[id] ?? EMPTY_STAT,
}));
