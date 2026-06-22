import { create } from "zustand";
import type { EqSnapshot } from "@/lib/types";

/** User-saved EQ presets (full curves: gains + per-band freq/Q + preamp). Shown in the preset browser
 *  alongside the built-ins. Persisted to localStorage. Saving the same name overwrites it. */
const KEY = "wavrplay-eq-presets";

function load(): EqSnapshot[] {
  try { const v = JSON.parse(localStorage.getItem(KEY) || "[]"); return Array.isArray(v) ? v : []; }
  catch { return []; }
}
function persist(presets: EqSnapshot[]): void {
  try { localStorage.setItem(KEY, JSON.stringify(presets)); } catch { /* quota / private mode */ }
}

interface EqPresetsState {
  presets: EqSnapshot[];
  save: (p: EqSnapshot) => void;
  remove: (name: string) => void;
}

export const useEqPresets = create<EqPresetsState>((set) => ({
  presets: load(),
  save: (p) => set((s) => {
    const presets = [...s.presets.filter((x) => x.name !== p.name), p].sort((a, b) => a.name.localeCompare(b.name));
    persist(presets); return { presets };
  }),
  remove: (name) => set((s) => { const presets = s.presets.filter((x) => x.name !== name); persist(presets); return { presets }; }),
}));
