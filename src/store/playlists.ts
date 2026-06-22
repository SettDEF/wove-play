import { create } from "zustand";
import type { Track } from "@/lib/types";

export type SmartField = "title" | "artist" | "album" | "genre" | "recent" | "rating" | "plays";
export type SmartOp = "contains" | "is" | "within";
/** One condition of a smart playlist. Numeric fields (recent days / rating / plays) use `within` = "at least". */
export interface SmartRule { field: SmartField; op: SmartOp; value: string; }
/** Optional per-track stats lookup (rating / plays / lastPlayed) used by rating & plays rules. */
export type StatOf = (id: string) => { rating: number; plays: number; lastPlayed: number };

/** A user playlist — manual (an ordered list of track ids) or smart (rule-driven, auto-populated). */
export interface Playlist {
  id: string;
  name: string;
  /** Track ids (= absolute paths) in user order (manual playlists). */
  trackIds: string[];
  /** Creation order counter — stable id without Date.now(). */
  createdSeq: number;
  kind?: "manual" | "smart";        // default manual
  match?: "all" | "any";            // smart: combine rules with AND / OR
  rules?: SmartRule[];              // smart: conditions
}

/** Resolve a smart playlist's rules against the library → matching tracks. */
export function resolveSmart(pl: Playlist, library: Track[], statOf?: StatOf): Track[] {
  const rules = pl.rules ?? [];
  if (!rules.length) return [];
  const test = (t: Track, r: SmartRule): boolean => {
    if (r.field === "recent") {
      const days = parseFloat(r.value) || 0;
      const cutoff = days > 0 ? Date.now() / 1000 - days * 86400 : 0;
      return (t.mtime ?? 0) >= cutoff;
    }
    if (r.field === "rating" || r.field === "plays") {
      const n = statOf ? statOf(t.id)[r.field] : 0;
      const v = parseFloat(r.value) || 0;
      return r.op === "is" ? n === v : n >= v; // "within" = at least
    }
    const hay = String((t as unknown as Record<string, unknown>)[r.field] ?? "").toLowerCase();
    const needle = r.value.toLowerCase().trim();
    if (!needle) return true;
    return r.op === "is" ? hay === needle : hay.includes(needle);
  };
  const out = library.filter((t) => (pl.match === "any" ? rules.some((r) => test(t, r)) : rules.every((r) => test(t, r))));
  if (rules.some((r) => r.field === "recent")) out.sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0));
  else if (rules.some((r) => r.field === "plays") && statOf) out.sort((a, b) => statOf(b.id).plays - statOf(a.id).plays);
  return out;
}

const LS = "wavrplay-playlists";

interface Stored { lists: Playlist[]; seq: number; }
function load(): Stored {
  try { const s = JSON.parse(localStorage.getItem(LS) || ""); if (Array.isArray(s.lists)) return s; } catch { /* default */ }
  return { lists: [], seq: 0 };
}
function persist(lists: Playlist[], seq: number) {
  try { localStorage.setItem(LS, JSON.stringify({ lists, seq })); } catch { /* ignore */ }
}

interface PlaylistState {
  lists: Playlist[];
  seq: number;
  create: (name: string, trackIds?: string[]) => string; // returns new id
  createSmart: (name: string, rules: SmartRule[], match: "all" | "any") => string;
  setRules: (id: string, rules: SmartRule[], match: "all" | "any") => void;
  rename: (id: string, name: string) => void;
  remove: (id: string) => void;
  addTracks: (id: string, trackIds: string[]) => void; // dedup, append
  removeTrack: (id: string, trackId: string) => void;
  purgeTracks: (trackIds: string[]) => void; // remove these tracks from EVERY playlist
  moveTrack: (id: string, from: number, to: number) => void;
  get: (id: string) => Playlist | undefined;
}

const init = load();

export const usePlaylists = create<PlaylistState>((set, get) => {
  const commit = (lists: Playlist[], seq = get().seq) => { persist(lists, seq); set({ lists, seq }); };
  return {
    lists: init.lists,
    seq: init.seq,

    create: (name, trackIds = []) => {
      const seq = get().seq + 1;
      const id = `pl-${seq}`;
      const pl: Playlist = { id, name: name.trim() || `Playlist ${seq}`, trackIds: [...new Set(trackIds)], createdSeq: seq, kind: "manual" };
      commit([...get().lists, pl], seq);
      return id;
    },
    createSmart: (name, rules, match) => {
      const seq = get().seq + 1;
      const id = `pl-${seq}`;
      const pl: Playlist = { id, name: name.trim() || `Smart ${seq}`, trackIds: [], createdSeq: seq, kind: "smart", rules, match };
      commit([...get().lists, pl], seq);
      return id;
    },
    setRules: (id, rules, match) => commit(get().lists.map((p) => (p.id === id ? { ...p, rules, match } : p))),
    rename: (id, name) => commit(get().lists.map((p) => (p.id === id ? { ...p, name: name.trim() || p.name } : p))),
    remove: (id) => commit(get().lists.filter((p) => p.id !== id)),
    addTracks: (id, trackIds) => commit(get().lists.map((p) => {
      if (p.id !== id) return p;
      const have = new Set(p.trackIds);
      return { ...p, trackIds: [...p.trackIds, ...trackIds.filter((t) => !have.has(t))] };
    })),
      removeTrack: (id, trackId) => commit(get().lists.map((p) => (p.id === id ? { ...p, trackIds: p.trackIds.filter((t) => t !== trackId) } : p))),
    purgeTracks: (trackIds) => { const drop = new Set(trackIds); commit(get().lists.map((p) => ({ ...p, trackIds: p.trackIds.filter((t) => !drop.has(t)) }))); },
    moveTrack: (id, from, to) => commit(get().lists.map((p) => {
      if (p.id !== id) return p;
      const n = p.trackIds.length;
      if (from < 0 || from >= n || to < 0 || to >= n || from === to) return p;
      const ids = [...p.trackIds];
      const [m] = ids.splice(from, 1); ids.splice(to, 0, m);
      return { ...p, trackIds: ids };
    })),
    get: (id) => get().lists.find((p) => p.id === id),
  };
});
