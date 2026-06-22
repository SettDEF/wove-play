/**
 * For-You lane builders (all local + synchronous): time-of-day greeting + daily blend, mood/energy
 * lanes from genre keywords, and history-based "On this day" / "Rediscover" shelves. Shared by Home
 * and the endless feed so the same definitions drive both.
 */
import type { Track } from "@/lib/types";

export interface Lane { id: string; title: string; sub: string; tracks: Track[] }
export interface RStat { rating: number; plays: number; lastPlayed: number }

const DAY = 86400;
const nowSec = () => Math.floor(Date.now() / 1000);

function rng(seed: number): () => number {
  let s = (seed >>> 0) || 1;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}
export function seededShuffle<T>(arr: T[], seed: number): T[] {
  const a = [...arr]; const r = rng(seed);
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
/** Spread tracks so the same artist never clumps: cap occurrences per artist, then round-robin
 *  interleave by artist → a mix that feels varied instead of "6 songs by one artist". */
export function diversify(tracks: Track[], maxPer: number): Track[] {
  const buckets = new Map<string, Track[]>();
  for (const t of tracks) {
    const k = (t.albumArtist || t.artist || "?").toLowerCase();
    const b = buckets.get(k) ?? buckets.set(k, []).get(k)!;
    if (b.length < maxPer) b.push(t);
  }
  const lists = [...buckets.values()];
  const out: Track[] = [];
  for (let any = true; any;) { any = false; for (const l of lists) { const v = l.shift(); if (v) { out.push(v); any = true; } } }
  return out;
}
// Track sampler: seeded shuffle → artist-diversify (≈ ≥6 distinct artists per shelf) → take n.
const sample = (arr: Track[], n: number, seed: number): Track[] =>
  diversify(seededShuffle(arr, seed), Math.max(2, Math.ceil(n / 6))).slice(0, n);

/** Like `sample`, but tilts toward tracks whose genre scores high in `prefs` (0..1, from per-hour
 *  learning). Still seed-stable (refreshes daily) and artist-diversified — the seeded random keeps
 *  variety while the preference term pulls this hour's habits up the order. */
function weightedSample(arr: Track[], n: number, seed: number, prefs: Record<string, number>): Track[] {
  const r = rng(seed);
  const scored = arr.map((t) => {
    const g = (t.genre || "").trim().toLowerCase();
    return { t, score: r() + (g ? (prefs[g] || 0) : 0) * 1.2 };
  });
  scored.sort((a, b) => b.score - a.score);
  return diversify(scored.map((s) => s.t), Math.max(2, Math.ceil(n / 6))).slice(0, n);
}

// ── time of day ────────────────────────────────────────────────────────────
export type Slot = "morning" | "afternoon" | "evening" | "night";
export function greeting(d = new Date()): { text: string; emoji: string; slot: Slot } {
  const h = d.getHours();
  if (h < 5) return { text: "Late night", emoji: "🌙", slot: "night" };
  if (h < 12) return { text: "Good morning", emoji: "☀️", slot: "morning" };
  if (h < 17) return { text: "Good afternoon", emoji: "🌤️", slot: "afternoon" };
  if (h < 22) return { text: "Good evening", emoji: "🌆", slot: "evening" };
  return { text: "Late night", emoji: "🌙", slot: "night" };
}
const SLOT_MIX: Record<Slot, string> = { morning: "Morning mix", afternoon: "Afternoon mix", evening: "Evening mix", night: "Late-night mix" };
/** A blend that refreshes once per day (and per time-of-day slot), drawn from a pool (smart blend or
 *  the whole library). Seeded by the date so it's stable through the day, fresh tomorrow. When `prefs`
 *  (per-hour learned genre weights) is supplied it leans toward what you usually play at this hour. */
export function dailyBlend(pool: Track[], n = 40, prefs?: Record<string, number>): { title: string; tracks: Track[]; tuned: boolean } {
  const d = new Date();
  const g = greeting(d);
  const key = d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
  const seed = ((key * 11) ^ (g.slot.length * 2654435761)) >>> 0;
  const tuned = !!prefs && Object.keys(prefs).length > 0;
  const tracks = tuned ? weightedSample(pool, n, seed, prefs!) : sample(pool, n, seed);
  return { title: SLOT_MIX[g.slot], tracks, tuned };
}

// ── mood / energy (genre-keyword heuristic; works without per-track analysis) ─
export interface Mood { id: string; title: string; sub: string; kw: string[] }
export const MOODS: Mood[] = [
  { id: "chill", title: "Chill", sub: "Low-key, easy listening", kw: ["ambient", "chill", "lo-fi", "lofi", "downtempo", "acoustic", "jazz", "soul", "r&b", "rnb", "blues", "folk", "soundtrack", "piano", "classical", "instrumental"] },
  { id: "energy", title: "Energy boost", sub: "High-octane picks", kw: ["edm", "dance", "house", "techno", "trance", "dubstep", "drum", "electro", "metal", "punk", "rock", "hardcore", "rave", "big room", "hard"] },
  { id: "focus", title: "Focus", sub: "Steady, low-distraction", kw: ["instrumental", "ambient", "classical", "piano", "study", "post-rock", "soundtrack", "score", "lo-fi", "lofi"] },
  { id: "party", title: "Party", sub: "Crowd-pleasers", kw: ["pop", "dance", "hip hop", "hip-hop", "rap", "house", "funk", "disco", "reggaeton", "afrobeat", "latin"] },
];
const matchesMood = (t: Track, m: Mood): boolean => {
  const g = (t.genre || "").toLowerCase();
  return !!g && m.kw.some((k) => g.includes(k));
};
export function moodTracks(library: Track[], m: Mood, seed = 0): Track[] {
  return sample(library.filter((t) => matchesMood(t, m)), 18, seed || m.id.length * 97 + 13);
}
export function moodLanes(library: Track[]): Lane[] {
  return MOODS.map((m) => ({ id: `mood-${m.id}`, title: m.title, sub: m.sub, tracks: moodTracks(library, m) }))
    .filter((l) => l.tracks.length >= 4);
}

const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const artistKey = (t: Track) => (t.albumArtist || t.artist || "").trim().toLowerCase();
function genreGroups(library: Track[], min: number): { name: string; tracks: Track[] }[] {
  const m = new Map<string, Track[]>();
  for (const t of library) { const g = t.genre; if (!g) continue; (m.get(g) ?? m.set(g, []).get(g)!).push(t); }
  return [...m.entries()].filter(([, ts]) => ts.length >= min).map(([name, tracks]) => ({ name, tracks }))
    .sort((a, b) => b.tracks.length - a.tracks.length);
}
const isoWeekKey = (d = new Date()): number => {
  const dt = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = dt.getUTCDay() || 7; dt.setUTCDate(dt.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((+dt - +yearStart) / 86400000 + 1) / 7);
  return dt.getUTCFullYear() * 100 + week;
};
const dayKey = (d = new Date()) => d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();

// ── Daily Mixes (Spotify): N genre/cluster mixes, date-seeded so they refresh daily ──────────
export function dailyMixes(library: Track[], n = 4): Lane[] {
  const k = dayKey();
  return genreGroups(library, 8).slice(0, n).map((g, i) => ({
    id: `daily-${i}`, title: `Daily Mix ${i + 1}`, sub: cap(g.name), tracks: sample(g.tracks, 24, k + i * 101),
  })).filter((l) => l.tracks.length >= 6);
}

// ── Discover Weekly (Spotify): owned-but-unplayed, reseeds once per ISO week ──────────────────
export function discoverWeekly(library: Track[], stat: (id: string) => RStat): Lane | null {
  const fresh = library.filter((t) => { const s = stat(t.id); return s.plays === 0 && s.rating !== 1 && s.rating !== 2; });
  if (fresh.length < 6) return null;
  return { id: "discover-weekly", title: "Discover Weekly", sub: "Songs you own but haven't played — new set each week", tracks: sample(fresh, 30, isoWeekKey()) };
}

// ── Release Radar (Spotify): recently added, prioritising artists you actually play ───────────
export function releaseRadar(library: Track[], stat: (id: string) => RStat): Lane | null {
  const now = nowSec();
  const loved = new Set(library.filter((t) => stat(t.id).plays > 0).map(artistKey).filter(Boolean));
  const recent = library.filter((t) => t.mtime && now - t.mtime <= 45 * DAY);
  const fromYours = recent.filter((t) => loved.has(artistKey(t)));
  const pool = fromYours.length >= 4 ? fromYours : recent;
  if (pool.length < 4) return null;
  return { id: "release-radar", title: "Release radar", sub: fromYours.length >= 4 ? "New additions from artists you play" : "Newly added to your library", tracks: sample(pool, 18, 555) };
}

// ── Year in Review (Wrapped): most-played songs + total minutes + top artists ─────────────────
export function yearInReview(library: Track[], stat: (id: string) => RStat): Lane | null {
  const played = library.filter((t) => stat(t.id).plays > 0);
  if (played.length < 8) return null;
  const minutes = Math.round(played.reduce((m, t) => m + (t.duration || 0) * stat(t.id).plays, 0) / 60);
  const topSongs = [...played].sort((a, b) => stat(b.id).plays - stat(a.id).plays).slice(0, 18);
  const ap = new Map<string, number>();
  for (const t of played) { const a = t.albumArtist || t.artist; if (a) ap.set(a, (ap.get(a) || 0) + stat(t.id).plays); }
  const artists = [...ap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([a]) => a);
  return { id: "year", title: "Your listening, wrapped", sub: `${minutes.toLocaleString()} min played${artists.length ? ` · ${artists.join(", ")}` : ""}`, tracks: topSongs };
}

// ── history-based ────────────────────────────────────────────────────────────
/** Tracks added to the library around this time last year (±5 weeks). */
export function throwbackLane(library: Track[]): Lane | null {
  const now = nowSec();
  const ts = library.filter((t) => t.mtime && now - t.mtime >= 330 * DAY && now - t.mtime <= 400 * DAY);
  if (ts.length < 4) return null;
  return { id: "throwback", title: "A year ago in your library", sub: "Added around this time last year", tracks: sample(ts, 18, 9001) };
}
/** Loved (★4+) songs you haven't played in a long time (or ever since rating). */
export function rediscoverLane(library: Track[], stat: (id: string) => RStat): Lane | null {
  const now = nowSec();
  const ts = library.filter((t) => { const s = stat(t.id); return s.rating >= 4 && (s.lastPlayed === 0 || now - s.lastPlayed > 120 * DAY); });
  if (ts.length < 4) return null;
  return { id: "rediscover", title: "Rediscover", sub: "Loved, but not heard in a while", tracks: sample(ts, 18, 4242) };
}
