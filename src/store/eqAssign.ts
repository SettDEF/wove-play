import { create } from "zustand";
import type { EqSnapshot } from "@/lib/types";

/** Per-song EQ assignments (Poweramp "Apply to songs"): pin a full EQ curve to a track id so it
 *  auto-applies whenever that song plays and is restored to your base EQ when it ends. Persisted. */
const KEY = "wavrplay-eq-songs";

function load(): Record<string, EqSnapshot> {
  try { const v = JSON.parse(localStorage.getItem(KEY) || "{}"); return v && typeof v === "object" ? v : {}; }
  catch { return {}; }
}
function save(songs: Record<string, EqSnapshot>): void {
  try { localStorage.setItem(KEY, JSON.stringify(songs)); } catch { /* quota / private mode */ }
}

interface EqAssignState {
  songs: Record<string, EqSnapshot>;
  pin: (id: string, snap: EqSnapshot) => void;
  unpin: (id: string) => void;
  get: (id: string) => EqSnapshot | undefined;
}

export const useEqAssign = create<EqAssignState>((set, getState) => ({
  songs: load(),
  pin: (id, snap) => set((s) => { const songs = { ...s.songs, [id]: snap }; save(songs); return { songs }; }),
  unpin: (id) => set((s) => { const songs = { ...s.songs }; delete songs[id]; save(songs); return { songs }; }),
  get: (id) => getState().songs[id],
}));
