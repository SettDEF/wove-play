import type { Track } from "./types";

type Stat = { rating: number; plays: number; lastPlayed: number };

/** First letter A–Z (or `#` for non-alpha) — the index-rail key for name-sorted lists (albums/artists). */
export function letterKey(s?: string): string {
  const c = (s || "").trim().charAt(0).toUpperCase();
  return c && /[A-Z]/.test(c) ? c : "#";
}

/** The label the fast-scroll bubble shows for a track — DYNAMIC with the active sort, so scrolling a
 *  title list shows A–Z, a year list shows years, a rating list shows ★, etc. */
export function scrollKey(t: Track | undefined, sort: string, stat?: (id: string) => Stat): string {
  if (!t) return "";
  const initial = (s?: string): string => {
    const c = (s || "").trim().charAt(0).toUpperCase();
    return c && /[A-Z]/.test(c) ? c : "#";
  };
  switch (sort) {
    case "artist": return initial(t.artist);
    case "album": return initial(t.album);
    case "year": return t.year ? String(t.year) : "—";
    case "duration": return `${Math.floor((t.duration || 0) / 60)}m`;
    case "rating": { const r = stat?.(t.id).rating ?? 0; return r ? "★".repeat(r) : "—"; }
    case "plays": { const p = stat?.(t.id).plays ?? 0; return p >= 100 ? "100+" : p >= 10 ? "10+" : String(p); }
    case "recent": {
      const ms = t.mtime ? (t.mtime > 1e12 ? t.mtime : t.mtime * 1000) : 0; // tolerate s or ms timestamps
      if (!ms) return "—";
      try { return new Date(ms).toLocaleString(undefined, { month: "short", year: "2-digit" }); } catch { return "—"; }
    }
    default: return initial(t.title);
  }
}
