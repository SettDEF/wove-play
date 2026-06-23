import { useEffect, useMemo, useRef, useState, useCallback, memo } from "react";
import { usePlayer } from "@/store/player";
import { useRatings } from "@/store/ratings";
import { useSettings } from "@/store/settings";
import * as taste from "@/lib/taste";
import type { Track } from "@/lib/types";
import { Cover, useCover } from "./Cover";
import { useArtistInfo } from "@/lib/artistInfo";
import { Icon } from "./Icons";
import { Sheet } from "./Sheet";
import { usePlaylists } from "@/store/playlists";
import { toast } from "@/store/toasts";

/** Configure which territory kinds appear on the map (persisted). */
function MapFilter({ hidden, onToggle, onClose }: { hidden: Set<string>; onToggle: (k: string) => void; onClose: () => void }) {
  return (
    <Sheet onClose={onClose} className="wp-map-filter">
      <header className="wp-sheet-head"><div className="wp-row-text"><div className="md-title-m">Show on the map</div><div className="md-body-s wp-muted">Pick which kinds of territories appear</div></div></header>
      <div className="wp-list">
        {FILTER_KINDS.map(({ k, label }) => {
          const on = !hidden.has(k);
          return (
            <button key={k} className="wp-row" onClick={() => onToggle(k)}>
              <div className="wp-row-text"><div className="md-body-l">{label}</div></div>
              <span className={`wp-switch ${on ? "wp-switch-on" : ""}`}><span className="wp-switch-knob" /></span>
            </button>
          );
        })}
      </div>
    </Sheet>
  );
}

/** Long-press a territory → quick actions sheet. */
function RegionActions({ region, onClose, onOpen }: { region: Region; onClose: () => void; onOpen: (title: string, tracks: Track[]) => void }) {
  const ids = region.tracks.map((t) => t.id);
  const act = (fn: () => void) => { fn(); onClose(); };
  const shuffled = () => { const q = region.tracks.slice(); for (let i = q.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [q[i], q[j]] = [q[j], q[i]]; } return q; };
  return (
    <Sheet onClose={onClose} className="wp-region-actions">
      <header className="wp-sheet-head"><div className="wp-row-text"><div className="md-title-m ellipsis">{region.title}</div><div className="md-body-s wp-muted">{region.tracks.length} songs</div></div></header>
      <div className="wp-list">
        <button className="wp-row" onClick={() => act(() => usePlayer.getState().playFrom(region.tracks, 0, region.title))}><div className="wp-art"><Icon name="play" size={20} /></div><div className="wp-row-text"><div className="md-body-l">Play</div></div></button>
        <button className="wp-row" onClick={() => act(() => usePlayer.getState().playFrom(shuffled(), 0, region.title))}><div className="wp-art"><Icon name="shuffle" size={20} /></div><div className="wp-row-text"><div className="md-body-l">Shuffle</div></div></button>
        <button className="wp-row" onClick={() => act(() => { usePlayer.getState().addToQueue(region.tracks); toast.info(`Queued ${region.tracks.length}`); })}><div className="wp-art"><Icon name="queue" size={20} /></div><div className="wp-row-text"><div className="md-body-l">Add to queue</div></div></button>
        <button className="wp-row" onClick={() => act(() => { usePlaylists.getState().create(region.title, ids); toast.success(`Saved “${region.title}”`); })}><div className="wp-art"><Icon name="playlist" size={20} /></div><div className="wp-row-text"><div className="md-body-l">Save as playlist</div></div></button>
        <button className="wp-row" onClick={() => act(() => onOpen(region.title, region.tracks))}><div className="wp-art"><Icon name="library" size={20} /></div><div className="wp-row-text"><div className="md-body-l">Open list</div></div></button>
      </div>
    </Sheet>
  );
}

interface Region { id: string; title: string; sub: string; tracks: Track[]; kind: Kind; parent?: string }
type Kind = "near" | "repeat" | "redis" | "fresh" | "loved" | "gems" | "mix" | "station" | "genre" | "decade" | "artist" | "album" | "long";
/** A cell on the map is EITHER a containered territory OR a loose, free-floating spotlight track. */
type MapItem = { t: "region"; region: Region } | { t: "loose"; track: Track; w: number };

const CW = 312, CH = 252; // 2-row cards: a 2×2 footprint (anchor = 1 big + 2 small) fits with no clip
const ZMIN = 0.4, ZMAX = 1.7;
// Three presentations so the map isn't all identical boxes: ANCHOR = big glowing card (personal /
// taste-graph), OPEN = box-less cluster (label + scattered tiles, no card — the bulk), COMPACT = tiny.
type Style = "anchor" | "open" | "compact" | "artist";
const STYLE_OF = (k: Kind): Style =>
  (k === "near" || k === "mix" || k === "station" || k === "repeat") ? "anchor"
    : k === "artist" ? "artist"          // its own rich element: art bg + name + Last.fm bio/tags
      : k === "album" ? "compact" : "open";
const KIND_ICON: Record<Kind, string> = {
  near: "graphicEq", repeat: "refresh", redis: "timer", fresh: "add", loved: "favorite", gems: "star",
  mix: "shuffle", station: "cast", genre: "shape", decade: "timer", artist: "artist", album: "music", long: "timer",
};
const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
// Which territory kinds the user wants on the map (configurable, persisted). "loose" = spotlight tiles.
const FILTER_KINDS: { k: string; label: string }[] = [
  { k: "near", label: "Around / Similar" }, { k: "mix", label: "Mixes" }, { k: "station", label: "Stations" },
  { k: "loose", label: "Spotlight picks" }, { k: "repeat", label: "On repeat" }, { k: "redis", label: "Rediscover" },
  { k: "loved", label: "Loved" }, { k: "gems", label: "Hidden gems" }, { k: "fresh", label: "Fresh" },
  { k: "genre", label: "Genres" }, { k: "decade", label: "Decades" }, { k: "artist", label: "Artists" },
  { k: "album", label: "Albums" }, { k: "long", label: "Long tracks" },
];
const HIDE_KEY = "wavrplay-explore-hidden";
const loadHidden = (): Set<string> => { try { return new Set(JSON.parse(localStorage.getItem(HIDE_KEY) || "[]")); } catch { return new Set(); } };
const saveHidden = (s: Set<string>) => { try { localStorage.setItem(HIDE_KEY, JSON.stringify([...s])); } catch { /* */ } };
function hueOf(kind: Kind, title: string): number {
  const fixed: Partial<Record<Kind, number>> = { near: 270, repeat: 200, redis: 30, fresh: 140, loved: 330, gems: 48, mix: 290, station: 250 };
  if (fixed[kind] != null) return fixed[kind]!;
  let h = 0; for (let i = 0; i < title.length; i++) h = (h * 31 + title.charCodeAt(i)) % 360;
  return h;
}
const trackHue = (id: string) => { let h = 0; for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360; return h; };

// "Shape fits the vibe": the cover stays a full rounded SQUARE (never cut), but its corner softness
// reflects the track's feel — chill/acoustic = soft & round, energetic/electronic = tight & punchy,
// otherwise a stable shape from the track's own fingerprint. Cheap (genre + hash, no analysis).
const VIBE_SOFT = ["ambient", "classical", "acoustic", "jazz", "chill", "lo-fi", "lofi", "soul", "folk", "blues", "piano", "soundtrack", "r&b", "rnb"];
const VIBE_PUNCHY = ["electronic", "techno", "house", "metal", "punk", "drum", "dubstep", "trap", "hardstyle", "edm", "dance", "rave", "hardcore", "industrial"];
function vibeShape(t: Track): "sq1" | "sq2" | "sq3" {
  const g = (t.genre || "").toLowerCase();
  if (VIBE_SOFT.some((k) => g.includes(k))) return "sq3";   // very rounded
  if (VIBE_PUNCHY.some((k) => g.includes(k))) return "sq1"; // tight corners
  return (["sq2", "sq1", "sq3"] as const)[trackHue(t.id) % 3]; // stable per-track fingerprint
}

/** Lay `n` cells in an outward square SPIRAL from the centre → the map radiates in EVERY direction
 *  (not a top-left grid), so it feels unlimited on all sides. Returns each item's grid cell + pixel
 *  position, a (col,row)→index lookup for windowing, the grid extent, and the centre cell's position. */
function buildSpiral(n: number) {
  const cells: [number, number][] = [[0, 0]];
  const D = [[1, 0], [0, 1], [-1, 0], [0, -1]];
  let x = 0, y = 0, d = 0, steps = 1, leg = 0;
  while (cells.length < n) {
    for (let s = 0; s < steps && cells.length < n; s++) { x += D[d][0]; y += D[d][1]; cells.push([x, y]); }
    d = (d + 1) % 4; leg++; if (leg % 2 === 0) steps++;
  }
  let minX = 0, minY = 0, maxX = 0, maxY = 0;
  for (const [cx, cy] of cells) { minX = Math.min(minX, cx); minY = Math.min(minY, cy); maxX = Math.max(maxX, cx); maxY = Math.max(maxY, cy); }
  const at = new Map<string, number>();
  const pos = cells.map(([cx, cy], i) => { const col = cx - minX, row = cy - minY; at.set(`${col},${row}`, i); return { col, row, left: col * CW, top: row * CH }; });
  return { pos, at, cols: maxX - minX + 1, rows: maxY - minY + 1, center: pos[0] ?? { left: 0, top: 0 } };
}

/** A containered territory card (memo'd → pan re-windows skip unchanged cards). When `lod` (zoomed
 *  out) it collapses to just its label + glow: a clean overview that also skips rendering 9 covers. */
const RegionCard = memo(function RegionCard({ r, left, top, playingId, lod, onOpen, onPlay, onLongPress }: {
  r: Region; left: number; top: number; playingId: string | null; lod: boolean; onOpen: (r: Region) => void; onPlay: (r: Region, i: number) => void; onLongPress: (r: Region) => void;
}) {
  const style = STYLE_OF(r.kind);
  const featured = style === "anchor";
  const ai = useArtistInfo(r.kind === "artist" ? r.title : undefined); // Last.fm bio/tags (when a key is set)
  const tiles = r.tracks.slice(0, style === "anchor" ? 3 : style === "artist" ? 2 : 4);
  // Container background = THIS territory's own album art, blurred → a unique colour per card (not a
  // uniform hue). Reuses the first tile's cover (same path → shared cache, no extra fetch); only for
  // boxed anchor cards, and not while zoomed out.
  const bgUrl = useCover((style === "anchor" || style === "artist") && !lod ? r.tracks[0]?.path : undefined);
  // long-press the header → quick actions (without moving = a hold, not a pan).
  const lp = useRef<{ x: number; y: number; t: number; fired: boolean } | null>(null);
  const hdrDown = (e: React.PointerEvent) => {
    const x = e.clientX, y = e.clientY;
    const t = window.setTimeout(() => { if (lp.current) { lp.current.fired = true; onLongPress(r); } }, 500);
    lp.current = { x, y, t, fired: false };
  };
  const hdrMove = (e: React.PointerEvent) => { const s = lp.current; if (s && Math.hypot(e.clientX - s.x, e.clientY - s.y) > 8) { clearTimeout(s.t); lp.current = null; } };
  const hdrUp = () => { if (lp.current) { clearTimeout(lp.current.t); } };
  const hdrClick = () => { if (lp.current?.fired) { lp.current = null; return; } onOpen(r); };
  return (
    <section className={`wp-region wp-region-${style} ${featured ? "wp-region-hero" : ""} ${lod ? "wp-region-lod" : ""}`} style={{ left, top, "--rh": hueOf(r.kind, r.title) } as React.CSSProperties}>
      {bgUrl && <div className="wp-region-bg" style={{ backgroundImage: `url("${bgUrl}")` }} aria-hidden />}
      <button className="wp-region-head" onClick={hdrClick} onPointerDown={hdrDown} onPointerMove={hdrMove} onPointerUp={hdrUp} onPointerLeave={hdrUp}>
        <span className="wp-region-badge"><Icon name={KIND_ICON[r.kind]} size={15} /></span>
        <span className="wp-row-text"><span className="md-title-s ellipsis">{r.title}</span><span className="md-body-s wp-region-sub">{r.sub} · {r.tracks.length}</span></span>
        <Icon name="next" size={18} color="var(--md-on-surface-variant)" />
      </button>
      {!lod && style === "artist" && ai && (
        <div className="wp-region-info">
          {ai.tags.length > 0 && <div className="wp-region-tags">{ai.tags.map((t) => <span key={t} className="wp-region-tag">{t}</span>)}</div>}
          {ai.bio && <div className="wp-region-bio md-body-s">{ai.bio}</div>}
        </div>
      )}
      {!lod && (
        <div className="wp-region-tiles">
          {tiles.map((t, i) => (
            <button key={t.id} className={`wp-map-node ${t.id === playingId ? "wp-map-playing" : ""} ${featured && i === 0 ? "wp-map-hero-tile" : ""}`}
              onClick={() => onPlay(r, i)} title={`${t.title} · ${t.artist}`}>
              <span className={`wp-map-art wp-shape wp-shape-${vibeShape(t)}`}><Cover path={t.path} size={featured && i === 0 ? 132 : 84} radius="lg" /></span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
});

/** A LOOSE spotlight track — no container, just a big shaped cover floating on the map. Size scales
 *  with how strong a pick it is. This is the "without a container in some places" the map needed. */
const LooseTile = memo(function LooseTile({ track, w, left, top, playing, lod, onPlay }: {
  track: Track; w: number; left: number; top: number; playing: boolean; lod: boolean; onPlay: (t: Track) => void;
}) {
  const size = Math.round(96 + 64 * clamp01(w));            // stronger pick = bigger
  const shape = vibeShape(track);                            // corner softness reflects the track's vibe
  return (
    <button className={`wp-loose ${playing ? "wp-map-playing" : ""}`} style={{ left: left + (CW - size) / 2, top: top + (CH - size - 30) / 2, "--rh": trackHue(track.id) } as React.CSSProperties}
      onClick={() => onPlay(track)} title={`${track.title} · ${track.artist}`}>
      <span className={`wp-map-art wp-loose-art wp-shape wp-shape-${shape}`} style={{ width: size, height: size }}><Cover path={track.path} size={size} radius="lg" /></span>
      {!lod && <span className="md-body-s ellipsis wp-loose-label" style={{ maxWidth: size + 16 }}>{track.title}</span>}
    </button>
  );
});

/**
 * Explore = an UNLIMITED, zoomable/pannable MAP — a smart mix of containered "territories" (each a
 * discovery algorithm) AND loose, free-floating spotlight tracks scattered between them, joined by
 * ropes where they relate. Virtualised + memo'd + imperative pan → smooth at any size.
 */
export function ExploreMap({ library, onOpen }: { library: Track[]; onOpen: (title: string, tracks: Track[]) => void }) {
  const current = usePlayer((s) => s.current());
  const ratingStats = useRatings((s) => s.stats);
  const discovery = useSettings((s) => s.discovery); // familiar ↔ balanced ↔ discover (drives the algorithm)
  const exploreBlur = useSettings((s) => s.exploreBlur); // customizable container background blur (0 = off)
  const byId = useMemo(() => new Map(library.map((t) => [t.id, t])), [library]);
  const [extra, setExtra] = useState<Region[]>([]);
  const [loose, setLoose] = useState<{ track: Track; w: number }[]>([]);
  const [vp, setVp] = useState({ w: 800, h: 600 });
  const [view, setView] = useState({ x: 16, y: 16, z: 1 });
  const viewRef = useRef(view);
  const [q, setQ] = useState("");                       // search-to-fly query
  const [actionsFor, setActionsFor] = useState<Region | null>(null); // long-press → quick actions
  const [hidden, setHidden] = useState<Set<string>>(loadHidden);     // configurable: hidden kinds
  const [filterOpen, setFilterOpen] = useState(false);
  const toggleKind = useCallback((k: string) => setHidden((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); saveHidden(n); return n; }), []);

  const groups = useMemo<Region[]>(() => {
    if (!library.length) return [];
    const out: Region[] = [];
    const group = (key: (t: Track) => string | null) => {
      const m = new Map<string, Track[]>();
      for (const t of library) { const k = key(t); if (k) (m.get(k) ?? m.set(k, []).get(k)!).push(t); }
      return m;
    };
    const genres = [...group((t) => t.genre || null).entries()].sort((a, b) => b[1].length - a[1].length);
    const artists = group((t) => t.albumArtist || t.artist || null);
    // CLUSTER BY CLOSENESS: each artist's dominant genre → place the artist right after that genre.
    const dom = new Map<string, string>();
    for (const [a, ts] of artists) {
      const gc = new Map<string, number>();
      for (const t of ts) if (t.genre) gc.set(t.genre, (gc.get(t.genre) ?? 0) + 1);
      const best = [...gc.entries()].sort((x, y) => y[1] - x[1])[0];
      if (best) dom.set(a, best[0]);
    }
    const byGenre = new Map<string, [string, Track[]][]>();
    for (const [a, ts] of artists) { const g = dom.get(a); if (g) (byGenre.get(g) ?? byGenre.set(g, []).get(g)!).push([a, ts]); }
    // albums per artist (for genre→artist→album clustering — a real tree)
    const albumsByArtist = new Map<string, [string, Track[]][]>();
    { const m = new Map<string, Track[]>();
      for (const t of library) { const ar = t.albumArtist || t.artist, al = t.album; if (ar && al) { const k = `${ar} ${al}`; (m.get(k) ?? m.set(k, []).get(k)!).push(t); } }
      for (const [k, ts] of m) { const [ar, al] = k.split(" "); (albumsByArtist.get(ar) ?? albumsByArtist.set(ar, []).get(ar)!).push([al, ts]); }
    }
    const used = new Set<string>();
    const pushArtist = (a: string, ats: Track[]) => {
      used.add(a);
      out.push({ id: `a:${a}`, title: a, sub: "Artist", kind: "artist", tracks: ats });
      const albums = (albumsByArtist.get(a) ?? []).filter(([, ts]) => ts.length >= 4).sort((x, y) => y[1].length - x[1].length);
      if (albums.length >= 2) for (const [al, ts] of albums) out.push({ id: `al:${a} ${al}`, title: al, sub: `Album · ${a}`, kind: "album", tracks: ts, parent: a });
    };
    for (const [g, ts] of genres) {
      if (ts.length >= 3) out.push({ id: `g:${g}`, title: g, sub: "Genre", kind: "genre", tracks: ts });
      for (const [a, ats] of (byGenre.get(g) ?? []).sort((x, y) => y[1].length - x[1].length).slice(0, 6)) if (ats.length >= 2 && !used.has(a)) pushArtist(a, ats);
    }
    [...group((t) => (t.year ? `${Math.floor(t.year / 10) * 10}s` : null)).entries()].sort((a, b) => b[0].localeCompare(a[0])).forEach(([d, ts]) => { if (ts.length >= 4) out.push({ id: `d:${d}`, title: d, sub: "Decade", kind: "decade", tracks: ts }); });
    [...artists.entries()].sort((a, b) => b[1].length - a[1].length).forEach(([a, ts]) => { if (ts.length >= 2 && !used.has(a)) pushArtist(a, ts); });
    const long = library.filter((t) => (t.duration ?? 0) >= 480).sort((a, b) => (b.duration ?? 0) - (a.duration ?? 0));
    if (long.length >= 3) out.push({ id: "long", title: "Marathon", sub: "Long tracks (8 min+)", kind: "long", tracks: long });
    return out;
  }, [library]);

  const statRegions = useMemo<Region[]>(() => {
    if (!library.length) return [];
    const plays = (id: string) => ratingStats[id]?.plays ?? 0;
    const last = (id: string) => ratingStats[id]?.lastPlayed ?? 0;
    const rating = (id: string) => ratingStats[id]?.rating ?? 0;
    const out: Region[] = [];
    const onRepeat = library.filter((t) => plays(t.id) > 0).sort((a, b) => plays(b.id) - plays(a.id));
    if (onRepeat.length >= 3) out.push({ id: "repeat", title: "On repeat", sub: "Played the most", kind: "repeat", tracks: onRepeat });
    const redis = library.filter((t) => (rating(t.id) >= 4 || plays(t.id) > 0) && last(t.id) > 0).sort((a, b) => last(a.id) - last(b.id));
    if (redis.length >= 3) out.push({ id: "redis", title: "Rediscover", sub: "Not heard in a while", kind: "redis", tracks: redis });
    const loved = library.filter((t) => rating(t.id) >= 4);
    if (loved.length >= 3) out.push({ id: "loved", title: "Loved", sub: "Your favourites", kind: "loved", tracks: loved });
    const gems = library.filter((t) => rating(t.id) >= 4 && plays(t.id) <= 1);
    if (gems.length >= 3) out.push({ id: "gems", title: "Hidden gems", sub: "Loved but rarely played", kind: "gems", tracks: gems });
    out.push({ id: "fresh", title: "Fresh", sub: "Recently added", kind: "fresh", tracks: [...library].sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0)) });
    return out;
  }, [library, ratingStats]);

  const base = useMemo(() => [...statRegions, ...groups], [statRegions, groups]);

  // Connected taste-graph territories + the SMART loose spotlight picks. The same similarity calls
  // that build the "Around/Like" territories also accumulate a scored pool of individual tracks; the
  // top-scored become loose tiles (sized by score). Taste isn't refetched per play.
  useEffect(() => {
    if (!library.length) { setExtra([]); setLoose([]); return; }
    let alive = true;
    (async () => {
      const out: Region[] = [];
      const scored = new Map<string, number>();
      const stats = useRatings.getState().stats;
      const absorb = (pairs: [string, number][], seedId: string) => pairs.forEach(([id, s]) => { if (id !== seedId && byId.has(id)) scored.set(id, Math.max(scored.get(id) ?? 0, s)); });
      const seed = async (s: Track, id: string, title: string) => {
        try {
          const pairs = await taste.similar(s.id, 30);
          absorb(pairs, s.id);
          const sim = pairs.map(([sid]) => byId.get(sid)).filter((t): t is Track => !!t && t.id !== s.id);
          const tracks = sim.length >= 4 ? sim : library.filter((t) => t.id !== s.id && (t.artist === s.artist || t.genre === s.genre)).slice(0, 24);
          if (tracks.length >= 3) out.push({ id, title, sub: "Sounds alike", kind: "near", tracks: [s, ...tracks] });
        } catch { /* */ }
      };
      if (current) await seed(current, "near", `Around ${current.title}`);
      const top = [...library].filter((t) => (stats[t.id]?.plays ?? 0) > 0).sort((a, b) => (stats[b.id]?.plays ?? 0) - (stats[a.id]?.plays ?? 0)).slice(0, 4);
      for (const t of top) if (t.id !== current?.id) await seed(t, `near:${t.id}`, `Like ${t.title}`);
      try { const mixes = await taste.generatedMixes(40); for (const m of mixes.slice(0, 4)) { const ts = m.tracks.map((id) => byId.get(id)).filter((t): t is Track => !!t); if (ts.length >= 3) out.push({ id: `mix:${m.id}`, title: m.name, sub: "Mix", kind: "mix", tracks: ts }); } } catch { /* */ }
      try { const st = await taste.stations(); for (const s of st.slice(0, 6)) { const ids = await taste.stationTracks(s.id, 18); const ts = ids.map((id) => byId.get(id)).filter((t): t is Track => !!t); if (ts.length >= 3) out.push({ id: `st:${s.id}`, title: s.name, sub: "Station", kind: "station", tracks: ts }); } } catch { /* */ }
      // DISCOVERY-aware spotlight picks: re-weight raw audio-similarity by how adventurous the user
      // wants Explore to be. familiar → boost songs you already play (closer to your taste); discover
      // → boost songs you've NEVER played (novelty); balanced → pure similarity.
      const plays = (id: string) => stats[id]?.plays ?? 0;
      const weigh = (id: string, sim: number) =>
        discovery === "familiar" ? sim * (1 + Math.min(plays(id), 6) * 0.13)
          : discovery === "discover" ? sim * (plays(id) > 0 ? 0.5 : 1.35)
            : sim;
      const ranked = [...scored.entries()].map(([id, s]) => [id, weigh(id, s)] as const).sort((a, b) => b[1] - a[1]).slice(0, 28);
      const maxS = ranked[0]?.[1] || 1;
      const looseOut = ranked.map(([id, s]) => ({ track: byId.get(id)!, w: clamp01(s / maxS) })).filter((x) => x.track);
      if (alive) { setExtra(out); setLoose(looseOut); }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [library, current?.id, discovery]);

  const regions = useMemo(() => [...extra, ...base], [extra, base]);

  // SMART MIX: interleave containered territories with loose spotlight tiles — a loose pick lands
  // after roughly every 3rd territory, strongest first, so the map alternates "boxed" and "free".
  const items = useMemo<MapItem[]>(() => {
    const shown = regions.filter((r) => !hidden.has(r.kind));   // configurable: drop hidden kinds
    const looseOn = !hidden.has("loose");
    const out: MapItem[] = [];
    let li = 0;
    shown.forEach((region, i) => {
      out.push({ t: "region", region });
      if (looseOn && i % 3 === 2 && li < loose.length) out.push({ t: "loose", track: loose[li].track, w: loose[li].w }), li++;
    });
    if (looseOn) while (li < loose.length) out.push({ t: "loose", track: loose[li].track, w: loose[li].w }), li++;
    return out;
  }, [regions, loose, hidden]);

  // Positions depend only on the COUNT (spiral is deterministic by index), so this only recomputes
  // when items are added/removed — not when their content changes on a play.
  const layout = useMemo(() => buildSpiral(items.length), [items.length]);
  const { cols, rows } = layout;

  const ref = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    const ro = new ResizeObserver(() => setVp({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el); setVp({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const visible = useMemo(() => {
    const lx0 = -view.x / view.z, lx1 = (-view.x + vp.w) / view.z;
    const ly0 = -view.y / view.z, ly1 = (-view.y + vp.h) / view.z;
    const c0 = Math.max(0, Math.floor(lx0 / CW) - 1), c1 = Math.min(cols - 1, Math.floor(lx1 / CW) + 1);
    const r0 = Math.max(0, Math.floor(ly0 / CH) - 1), r1 = Math.min(rows - 1, Math.floor(ly1 / CH) + 1);
    const out: { it: MapItem; i: number; left: number; top: number }[] = [];
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
      const i = layout.at.get(`${c},${r}`); if (i === undefined) continue;
      out.push({ it: items[i], i, left: c * CW, top: r * CH });
    }
    return out;
  }, [items, layout, cols, rows, view, vp]);

  const applyTransform = () => { const v = viewRef.current; if (canvasRef.current) canvasRef.current.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.z})`; };
  useEffect(() => { applyTransform(); });
  const lastKey = useRef(""); const raf = useRef(0);
  const commitIfWindowChanged = () => {
    if (raf.current) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = 0; const v = viewRef.current;
      const key = `${Math.floor(-v.x / v.z / CW)}|${Math.floor(-v.y / v.z / CH)}|${v.z.toFixed(2)}`;
      if (key !== lastKey.current) { lastKey.current = key; setView({ ...v }); }
    });
  };
  useEffect(() => () => { if (raf.current) cancelAnimationFrame(raf.current); }, []);

  const clamp = (v: { x: number; y: number; z: number }) => {
    const M = 16, cw = cols * CW * v.z, ch = rows * CH * v.z;
    const ax = cw <= vp.w ? (vp.w - cw) / 2 : Math.min(M, Math.max(vp.w - cw - M, v.x));
    const ay = ch <= vp.h ? Math.max(M, (vp.h - ch) / 2) : Math.min(M, Math.max(vp.h - ch - M, v.y));
    return { x: ax, y: ay, z: v.z };
  };
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean } | null>(null);
  const pinch = useRef<{ d: number; z: number } | null>(null);
  const dist = (t: React.TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  const noAnim = () => { if (canvasRef.current) canvasRef.current.style.transition = "none"; };
  const onPointerDown = (e: React.PointerEvent) => { noAnim(); if (!pinch.current) drag.current = { x: e.clientX, y: e.clientY, vx: viewRef.current.x, vy: viewRef.current.y, moved: false }; };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current; if (!d || pinch.current) return;
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    // Once it's a real drag, CAPTURE the pointer so the whole pan stays with the map — a fast/long swipe
    // can't slip out to a parent (which would otherwise read it as a tab swipe) or drop mid-gesture.
    if (!d.moved && Math.abs(dx) + Math.abs(dy) > 4) {
      d.moved = true;
      try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* unsupported */ }
    }
    viewRef.current = clamp({ ...viewRef.current, x: d.vx + dx, y: d.vy + dy });
    applyTransform(); commitIfWindowChanged();
  };
  // double-tap empty space → zoom IN toward that point (map-style "dive in")
  const lastTap = useRef({ t: 0, x: 0, y: 0 });
  const onPointerUp = (e: React.PointerEvent) => {
    const wasDrag = drag.current?.moved;
    if (drag.current) { drag.current = null; setView({ ...viewRef.current }); }
    if (wasDrag) return;
    const onEmpty = !(e.target as HTMLElement).closest(".wp-map-node, .wp-loose, .wp-region-head, .wp-map-controls");
    const now = e.timeStamp || Date.now();
    if (onEmpty && now - lastTap.current.t < 300 && Math.hypot(e.clientX - lastTap.current.x, e.clientY - lastTap.current.y) < 30) {
      const el = ref.current; const r = el?.getBoundingClientRect();
      zoomAt(e.clientX - (r?.left ?? 0), e.clientY - (r?.top ?? 0), viewRef.current.z * 1.8, true);
      lastTap.current.t = 0;
    } else { lastTap.current = { t: now, x: e.clientX, y: e.clientY }; }
  };
  // Zoom keeping the point (px,py) fixed on screen — `toward` for double-tap, else viewport centre.
  const zoomAt = (px: number, py: number, z: number, anim = false) => {
    if (anim && canvasRef.current) canvasRef.current.style.transition = "transform .2s ease-out";
    const v = viewRef.current, nz = Math.max(ZMIN, Math.min(ZMAX, z));
    const lx = (px - v.x) / v.z, ly = (py - v.y) / v.z;
    viewRef.current = clamp({ x: px - lx * nz, y: py - ly * nz, z: nz });
    applyTransform(); commitIfWindowChanged(); if (anim) setView({ ...viewRef.current });
  };
  const setZoom = (z: number) => zoomAt(vp.w / 2, vp.h / 2, z);
  // Keep ALL map touches from bubbling to the library's tab-swipe handler — the map owns its gestures
  // (pan via pointer events, pinch here). Without this a one-finger drag on the map reached the parent
  // and flipped to the next sub-tab instead of panning.
  const onTouchStart = (e: React.TouchEvent) => { e.stopPropagation(); if (e.touches.length === 2) { noAnim(); pinch.current = { d: dist(e.touches), z: viewRef.current.z }; } };
  const onTouchMove = (e: React.TouchEvent) => { e.stopPropagation(); if (e.touches.length === 2 && pinch.current) setZoom(pinch.current.z * (dist(e.touches) / pinch.current.d)); };
  const onTouchEnd = (e: React.TouchEvent) => { if (e.touches.length < 2) { pinch.current = null; setView({ ...viewRef.current }); } };
  const onWheel = (e: React.WheelEvent) => { if (!e.ctrlKey && !e.metaKey) return; e.preventDefault(); setZoom(viewRef.current.z - e.deltaY * 0.0015); };
  const zoomBtn = (d: number) => { if (canvasRef.current) canvasRef.current.style.transition = "transform .16s ease-out"; setZoom(+(viewRef.current.z + d).toFixed(2)); setView({ ...viewRef.current }); };
  // Centre the viewport on the spiral's middle (the strongest territory) — so you start in the middle
  // of the map with content radiating out in every direction.
  const centerOn = (z = 1) => clamp({ x: vp.w / 2 - (layout.center.left + 150) * z, y: vp.h / 2 - (layout.center.top + 118) * z, z });
  const reset = () => { viewRef.current = centerOn(1); applyTransform(); setView({ ...viewRef.current }); };
  const didInit = useRef(false);
  useEffect(() => {
    if (!didInit.current && vp.w > 1 && layout.pos.length) { didInit.current = true; viewRef.current = centerOn(1); applyTransform(); setView({ ...viewRef.current }); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vp, layout]);

  const onOpenRegion = useCallback((r: Region) => onOpen(r.title, r.tracks), [onOpen]);
  const onPlayRegion = useCallback((r: Region, i: number) => { if (!drag.current?.moved) void usePlayer.getState().playFrom(r.tracks, i, r.title); }, []);
  const onPlayLoose = useCallback((t: Track) => { if (!drag.current?.moved) void usePlayer.getState().playFrom([t], 0, "For you"); }, []);
  const onLongPress = useCallback((r: Region) => setActionsFor(r), []);

  // ── search-to-fly: animate the view to centre the first matching territory/loose tile ──────────
  const flyTo = useCallback((i: number) => {
    if (i < 0) return;
    const z = Math.max(viewRef.current.z, 1);
    const cx = (i % cols) * CW + 150, cy = Math.floor(i / cols) * CH + 118;
    if (canvasRef.current) canvasRef.current.style.transition = "transform .4s cubic-bezier(.2,.7,.2,1)";
    viewRef.current = clamp({ x: vp.w / 2 - cx * z, y: vp.h / 2 - cy * z, z });
    applyTransform(); setView({ ...viewRef.current });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cols, vp]);
  useEffect(() => {
    const term = q.trim().toLowerCase(); if (!term) return;
    const id = window.setTimeout(() => {
      const i = items.findIndex((it) => (it.t === "region" ? it.region.title : it.track.title).toLowerCase().includes(term));
      if (i >= 0) flyTo(i);
    }, 220);
    return () => clearTimeout(id);
  }, [q, items, flyTo]);

  if (!library.length) {
    return <div className="wp-empty"><Icon name="favorite" size={40} color="var(--md-on-surface-variant)" /><div className="md-body-m wp-muted">Add music to explore your map.</div></div>;
  }
  const playingId = current?.id ?? null;
  const lod = view.z < 0.72; // zoomed out → label-only overview (clean + skips covers)

  return (
    <div ref={ref} className={`wp-map ${exploreBlur > 0 ? "wp-map-blurred" : ""}`} style={{ "--map-blur": `${exploreBlur}px` } as React.CSSProperties}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
      onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd} onWheel={onWheel}>
      <div className="wp-map-search">
        <Icon name="search" size={18} color="var(--md-on-surface-variant)" />
        <input className="wp-map-search-in md-body-m" value={q} placeholder="Fly to…" onChange={(e) => setQ(e.target.value)}
          onPointerDown={(e) => e.stopPropagation()} />
        {q && <button className="md-icon-btn" onClick={() => setQ("")} title="Clear"><Icon name="close" size={16} /></button>}
      </div>
      <div className="wp-map-controls">
        <button className="md-icon-btn" onClick={() => setFilterOpen(true)} title="Configure territories"><Icon name="tune" size={20} /></button>
        <button className="md-icon-btn" onClick={() => zoomBtn(-0.2)} title="Zoom out"><Icon name="remove" size={20} /></button>
        <button className="md-icon-btn" onClick={reset} title="Reset view">{Math.round(view.z * 100)}%</button>
        <button className="md-icon-btn" onClick={() => zoomBtn(0.2)} title="Zoom in"><Icon name="add" size={20} /></button>
      </div>
      {actionsFor && <RegionActions region={actionsFor} onClose={() => setActionsFor(null)} onOpen={onOpen} />}
      {filterOpen && <MapFilter hidden={hidden} onToggle={toggleKind} onClose={() => setFilterOpen(false)} />}

      <div ref={canvasRef} className="wp-map-canvas" style={{ width: cols * CW, height: rows * CH }}>
        {visible.map(({ it, i, left, top }) => it.t === "region"
          ? <RegionCard key={it.region.id} r={it.region} left={left} top={top} playingId={playingId} lod={lod} onOpen={onOpenRegion} onPlay={onPlayRegion} onLongPress={onLongPress} />
          : <LooseTile key={`loose:${it.track.id}:${i}`} track={it.track} w={it.w} left={left} top={top} playing={it.track.id === playingId} lod={lod} onPlay={onPlayLoose} />)}
      </div>
    </div>
  );
}
