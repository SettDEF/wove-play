// For You data layer — all the library/stats-derived shelves + the smart recommendation blends,
// extracted out of the Home component so it stays a thin renderer. Pure (memoized) computation; the
// taste-engine async bits (mixes/stations/fusion) stay in the component.

import { useMemo } from "react";
import type { Track } from "./types";
import type { Stat } from "@/store/ratings";
import { buildAffinity, smartBlend, becausePlayed, hiddenGems, type Explore } from "./recommend";

export interface GenreGroup { name: string; tracks: Track[] }
export interface AlbumGroup { name: string; artist: string; cover: string; tracks: Track[] }
export interface Chip { label: string; tracks: Track[]; shuffle?: boolean }

export interface ForYou {
  // library-derived shelves
  topGenres: GenreGroup[];
  recentlyAdded: Track[];
  recentlyPlayed: Track[];
  mostPlayed: Track[];
  liked: Track[];
  forgotten: Track[];
  deepCuts: Track[];
  topArtists: GenreGroup[];
  decades: GenreGroup[];
  albums: AlbumGroup[];
  freshFamiliar: Track[];
  quickHits: Track[];
  longMixes: Track[];
  newThisWeek: Track[];
  quickPicks: Track[];
  // smart recommendation blends
  blend: Track[];
  because: { seed: string; tracks: Track[] } | null;
  gems: Track[];
  // top mood/genre chips
  chips: Chip[];
}

const EMPTY: Stat = { rating: 0, plays: 0, lastPlayed: 0 };

export function useForYou(library: Track[], ratingStats: Record<string, Stat>, discovery: Explore): ForYou {
  return useMemo(() => {
    const stat = (id: string) => ratingStats[id] ?? EMPTY;
    const nowSec = Math.floor(Date.now() / 1000);

    // ── library-derived shelves ──────────────────────────────────────────────
    const byGenre = new Map<string, Track[]>();
    for (const t of library) { const g = t.genre?.trim(); if (g) (byGenre.get(g) ?? byGenre.set(g, []).get(g)!).push(t); }
    const topGenres = [...byGenre.entries()].filter(([, ts]) => ts.length >= 5)
      .sort((a, b) => b[1].length - a[1].length).slice(0, 12).map(([name, tracks]) => ({ name, tracks }));
    const recentlyAdded = [...library].sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0)).slice(0, 60);
    const recentlyPlayed = library.filter((t) => stat(t.id).lastPlayed > 0).sort((a, b) => stat(b.id).lastPlayed - stat(a.id).lastPlayed).slice(0, 40);
    const mostPlayed = library.filter((t) => stat(t.id).plays > 0).sort((a, b) => stat(b.id).plays - stat(a.id).plays).slice(0, 60);
    const liked = library.filter((t) => stat(t.id).rating >= 4).slice(0, 60);

    // Quick picks: de-duped blend of liked → played → recent, up to 3 pages of 9.
    const seen = new Set<string>();
    const quickPicks: Track[] = [];
    for (const t of [...liked, ...mostPlayed, ...recentlyAdded]) {
      if (seen.has(t.id)) continue; seen.add(t.id); quickPicks.push(t);
      if (quickPicks.length >= 27) break;
    }

    // ── extra recommendation algorithms (stats/tag-driven) ────────────────────
    const STALE = 14 * 86400;
    const forgotten = library
      .filter((t) => { const s = stat(t.id); return (s.rating >= 4 || s.plays >= 3) && s.lastPlayed > 0 && nowSec - s.lastPlayed > STALE; })
      .sort((a, b) => stat(a.id).lastPlayed - stat(b.id).lastPlayed).slice(0, 60);
    const playedArtists = new Set(library.filter((t) => stat(t.id).plays > 0).map((t) => t.albumArtist || t.artist).filter(Boolean));
    const deepCuts = library.filter((t) => stat(t.id).plays === 0 && playedArtists.has(t.albumArtist || t.artist));
    const aMap = new Map<string, { tracks: Track[]; plays: number }>();
    for (const t of library) { const a = t.albumArtist || t.artist; if (!a) continue; const g = aMap.get(a) ?? { tracks: [], plays: 0 }; g.tracks.push(t); g.plays += stat(t.id).plays; aMap.set(a, g); }
    const topArtists = [...aMap.entries()].filter(([, g]) => g.plays > 0).sort((a, b) => b[1].plays - a[1].plays).slice(0, 12).map(([name, g]) => ({ name, tracks: g.tracks }));
    const dMap = new Map<number, Track[]>();
    for (const t of library) { if (t.year) { const d = Math.floor(t.year / 10) * 10; (dMap.get(d) ?? dMap.set(d, []).get(d)!).push(t); } }
    const decades = [...dMap.entries()].filter(([, ts]) => ts.length >= 8).sort((a, b) => b[0] - a[0]).map(([d, tracks]) => ({ name: `${d}s`, tracks }));
    // Albums for you: real albums (≥4 tracks), ranked by how much you play them.
    const albMap = new Map<string, AlbumGroup & { plays: number }>();
    for (const t of library) {
      if (!t.album) continue;
      const artist = t.albumArtist || t.artist;
      const key = `${artist}|||${t.album}`;
      const g = albMap.get(key) ?? { name: t.album, artist, cover: t.path, tracks: [], plays: 0 };
      g.tracks.push(t); g.plays += stat(t.id).plays; albMap.set(key, g);
    }
    const albums = [...albMap.values()].filter((g) => g.tracks.length >= 4)
      .sort((a, b) => b.plays - a.plays || (b.tracks[0].mtime ?? 0) - (a.tracks[0].mtime ?? 0)).slice(0, 20);
    // Fresh + familiar: alternate a new add with an old favorite.
    const fav = [...liked, ...mostPlayed];
    const ff: Track[] = []; const ffSeen = new Set<string>();
    const pushFF = (t?: Track) => { if (t && !ffSeen.has(t.id)) { ffSeen.add(t.id); ff.push(t); } };
    for (let i = 0; i < 24; i++) { pushFF(recentlyAdded[i]); pushFF(fav[i]); }
    const freshFamiliar = ff.slice(0, 40);
    // Duration splits.
    const quickHits = library.filter((t) => t.duration > 0 && t.duration <= 150).sort((a, b) => stat(b.id).plays - stat(a.id).plays).slice(0, 40);
    const longMixes = library.filter((t) => t.duration >= 480).sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0)).slice(0, 40);
    // New this week.
    const newThisWeek = library.filter((t) => t.mtime && nowSec - t.mtime < 7 * 86400).sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0)).slice(0, 40);

    // ── unified smart blends ──────────────────────────────────────────────────
    const aff = buildAffinity(library, stat, nowSec);
    const blend = smartBlend(library, stat, aff, 50, discovery);
    const because = becausePlayed(library, stat, aff, 30);
    const gems = hiddenGems(library, stat, aff, 40);

    // ── mood/genre launch chips ───────────────────────────────────────────────
    const chips: Chip[] = [];
    if (liked.length) chips.push({ label: "Liked", tracks: liked, shuffle: true });
    if (mostPlayed.length) chips.push({ label: "On repeat", tracks: mostPlayed });
    if (recentlyAdded.length) chips.push({ label: "Recent", tracks: recentlyAdded });
    for (const g of topGenres) chips.push({ label: g.name, tracks: g.tracks, shuffle: true });

    return { topGenres, recentlyAdded, recentlyPlayed, mostPlayed, liked, forgotten, deepCuts, topArtists, decades, albums, freshFamiliar, quickHits, longMixes, newThisWeek, quickPicks, blend, because, gems, chips };
  }, [library, ratingStats, discovery]);
}
