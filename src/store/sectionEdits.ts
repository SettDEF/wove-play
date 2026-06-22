import { create } from "zustand";
import type { Section } from "@/lib/trackAnalysis";

/**
 * User edits to a track's sections (rename / recolor / move boundaries / split), keyed by track id and
 * persisted to localStorage. When an entry exists it REPLACES the auto-detected sections everywhere
 * (Now-Playing seekbar + the fullscreen editor). Reset deletes the entry → detection takes over again.
 */
const LS = "wavrplay-sectionedits";

function load(): Record<string, Section[]> {
  try { return JSON.parse(localStorage.getItem(LS) || "{}"); } catch { return {}; }
}

interface SectionEditState {
  edits: Record<string, Section[]>;
  /** Custom sections for a track, or null to fall back to detection. */
  get: (id: string) => Section[] | null;
  set: (id: string, secs: Section[]) => void;
  clear: (id: string) => void;
}

export const useSectionEdits = create<SectionEditState>((set, getState) => ({
  edits: load(),
  get: (id) => getState().edits[id] ?? null,
  set: (id, secs) => {
    const edits = { ...getState().edits, [id]: secs };
    try { localStorage.setItem(LS, JSON.stringify(edits)); } catch { /* quota */ }
    set({ edits });
  },
  clear: (id) => {
    const edits = { ...getState().edits };
    delete edits[id];
    try { localStorage.setItem(LS, JSON.stringify(edits)); } catch { /* quota */ }
    set({ edits });
  },
}));
