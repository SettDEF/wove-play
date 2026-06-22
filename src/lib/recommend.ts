// Wove — on-device recommendation blender. The earlier For You shelves each used ONE signal
// (plays, or rating, or genre…). This module lets the signals "talk to each other": it builds a
// unified affinity model (artist + genre, recency-decayed) from your listening, then scores every
// track by a weighted blend of those signals + discovery/freshness bonuses − a repeat penalty.
// All stats/tag-driven, so it works with zero fingerprints; the taste engine can enrich it later.

import type { Track } from "./types";

export interface Stat { rating: number; plays: number; lastPlayed: number; skips?: number }
export type StatOf = (id: string) => Stat;
/** How adventurous the blend is. familiar = lean on what you know; discover = push new/unheard. */
export type Explore = "familiar" | "balanced" | "discover";

const DAY = 86_400;
/** Recency weight for affinity: recent listening shapes taste more (half-life ~30 days). */
function recencyWeight(lastPlayed: number, nowSec: number): number {
  if (lastPlayed <= 0) return 0;
  const ageDays = Math.max(0, (nowSec - lastPlayed) / DAY);
  return Math.pow(0.5, ageDays / 30);
}
/** Stable per-id jitter in [0,1) so rankings don't reshuffle on every render (vs Math.random). */
function jitter(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 1000) / 1000;
}
const artistOf = (t: Track) => t.albumArtist || t.artist || "";

export interface Affinity {
  artist: Map<string, number>; // 0..1 normalized
  genre: Map<string, number>;  // 0..1 normalized
  nowSec: number;
  nowHour: number;             // local hour [0,23] for time-of-day context
  /** Raw per-track engagement score (plays + rating), recency-weighted for affinity contribution. */
  base: (t: Track) => number;
}
/** Circular distance between two clock hours, in [0,12]. */
function hourDist(a: number, b: number): number { const d = Math.abs(a - b) % 24; return Math.min(d, 24 - d); }

/** Build the unified affinity model from the library + listening stats. */
export function buildAffinity(library: Track[], statOf: StatOf, nowSec: number): Affinity {
  const base = (t: Track) => {
    const s = statOf(t.id);
    const rating = s.rating >= 4 ? 3 : s.rating >= 1 && s.rating <= 2 ? -2 : 0;
    return s.plays + rating - (s.skips ?? 0) * 0.5; // skips are a soft negative signal
  };
  const artist = new Map<string, number>();
  const genre = new Map<string, number>();
  for (const t of library) {
    const s = statOf(t.id);
    const contrib = base(t) * (0.3 + 0.7 * recencyWeight(s.lastPlayed, nowSec)); // recent listening weighs more
    if (contrib <= 0) continue;
    const a = artistOf(t);
    if (a) artist.set(a, (artist.get(a) ?? 0) + contrib);
    if (t.genre) genre.set(t.genre, (genre.get(t.genre) ?? 0) + contrib);
  }
  normalize(artist);
  normalize(genre);
  return { artist, genre, nowSec, nowHour: new Date(nowSec * 1000).getHours(), base };
}
function normalize(m: Map<string, number>) {
  let max = 0;
  for (const v of m.values()) if (v > max) max = v;
  if (max > 0) for (const [k, v] of m) m.set(k, v / max);
}

/** Blend weights — all the tuning lives here so the scorer reads as a formula, not magic numbers. */
const W = {
  artist: 0.45,        // artist affinity
  genre: 0.30,         // genre affinity
  engagement: 0.15,    // your own plays/rating on the track
  discovery: 0.20,     // bonus for an unheard track by a loved artist (× the explore knob)
  skipPenalty: 0.30,   // you keep skipping it
  repeatPenalty: 0.50, // heard it in the last 2 days (× explore when discovering)
  context: 0.08,       // time-of-day match
  jitter: 0.06,        // stable per-track variety
};
const DISC_WEIGHT: Record<Explore, number> = { familiar: 0.35, balanced: 1, discover: 2 };

/** Combined score for a candidate track — this is where the signals talk to each other. */
function blendScore(t: Track, aff: Affinity, statOf: StatOf, maxBase: number, disc = 1): number {
  const s = statOf(t.id);
  const a = aff.artist.get(artistOf(t)) ?? 0;
  const g = t.genre ? aff.genre.get(t.genre) ?? 0 : 0;
  const own = maxBase > 0 ? Math.max(0, aff.base(t)) / maxBase : 0;
  let score = W.artist * a + W.genre * g + W.engagement * own;
  if (s.plays === 0 && a > 0.15) score += W.discovery * disc;                    // discovery, scaled by the explore knob
  if ((s.skips ?? 0) >= 2 && (s.rating ?? 0) < 4) score -= W.skipPenalty;        // negative feedback
  if (s.lastPlayed > 0 && aff.nowSec - s.lastPlayed < 2 * DAY) score -= W.repeatPenalty * Math.max(1, disc); // anti-repeat
  if (s.lastPlayed > 0) {                                                        // time-of-day context
    const d = hourDist(new Date(s.lastPlayed * 1000).getHours(), aff.nowHour);
    if (d <= 3) score += W.context * (1 - d / 3);
  }
  score += W.jitter * jitter(t.id);                                              // gentle, STABLE variety
  return score;
}

/** Pick the top `n` by blend score with artist diversity (≤ `perArtist` from any one artist). */
function rankDiverse(cands: { t: Track; score: number }[], n: number, perArtist = 3): Track[] {
  cands.sort((x, y) => y.score - x.score);
  const out: Track[] = [];
  const count = new Map<string, number>();
  for (const { t } of cands) {
    if (out.length >= n) break;
    const a = artistOf(t);
    const c = count.get(a) ?? 0;
    if (c >= perArtist) continue;
    count.set(a, c + 1);
    out.push(t);
  }
  return out;
}

/** The headline "Made for you" blend: a single mix mixing favorites, discovery, freshness and
 *  genre/artist affinity — the multi-signal playlist. Returns [] if there's nothing to go on yet. */
export function smartBlend(library: Track[], statOf: StatOf, aff: Affinity, n = 50, explore: Explore = "balanced"): Track[] {
  if (aff.artist.size === 0 && aff.genre.size === 0) return [];
  let maxBase = 0;
  for (const t of library) maxBase = Math.max(maxBase, aff.base(t));
  const disc = DISC_WEIGHT[explore];
  const cands = library.map((t) => ({ t, score: blendScore(t, aff, statOf, maxBase, disc) }))
    .filter((c) => c.score > 0.08);
  return rankDiverse(cands, n);
}

/** Hidden gems: tracks you rated highly (or by a loved artist) but have barely played — buried treasure. */
export function hiddenGems(library: Track[], statOf: StatOf, aff: Affinity, n = 40): Track[] {
  const cands = library.filter((t) => {
    const s = statOf(t.id);
    const lovedArtist = (aff.artist.get(artistOf(t)) ?? 0) > 0.4;
    return s.plays <= 1 && (s.skips ?? 0) === 0 && (s.rating >= 4 || lovedArtist);
  });
  return cands.slice(0, n);
}

/** "Because you played {artist}": seed from your strongest recent artist, then recommend within
 *  that lane — the artist's own deep cuts + other artists in the seed's top genre, blend-ranked. */
export function becausePlayed(library: Track[], statOf: StatOf, aff: Affinity, n = 30): { seed: string; tracks: Track[] } | null {
  let seed = ""; let best = 0;
  for (const [a, v] of aff.artist) if (v > best) { best = v; seed = a; }
  if (!seed) return null;
  // the seed's dominant genre (so the lane has a coherent sound)
  const gCount = new Map<string, number>();
  for (const t of library) if (artistOf(t) === seed && t.genre) gCount.set(t.genre, (gCount.get(t.genre) ?? 0) + 1);
  let seedGenre = ""; let gb = 0;
  for (const [g, c] of gCount) if (c > gb) { gb = c; seedGenre = g; }
  let maxBase = 0; for (const t of library) maxBase = Math.max(maxBase, aff.base(t));
  const cands = library
    .filter((t) => artistOf(t) === seed || (seedGenre && t.genre === seedGenre))
    .map((t) => ({ t, score: blendScore(t, aff, statOf, maxBase) + (artistOf(t) === seed ? 0.15 : 0) }));
  const tracks = rankDiverse(cands, n, 6);
  return tracks.length >= 4 ? { seed, tracks } : null;
}
