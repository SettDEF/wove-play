import { create } from "zustand";

const LS = "wavrplay-lyrics";
type LyricMap = Record<string, string>; // track id → raw lrc/text
function load(): LyricMap { try { return JSON.parse(localStorage.getItem(LS) || "{}"); } catch { return {}; } }
function persist(m: LyricMap) { try { localStorage.setItem(LS, JSON.stringify(m)); } catch { /* ignore */ } }

interface LyricsState {
  map: LyricMap;
  set: (id: string, text: string) => void;
  clear: (id: string) => void;
}

export const useLyrics = create<LyricsState>((set, get) => ({
  map: load(),
  set: (id, text) => { const map = { ...get().map, [id]: text }; persist(map); set({ map }); },
  clear: (id) => { const map = { ...get().map }; delete map[id]; persist(map); set({ map }); },
}));
