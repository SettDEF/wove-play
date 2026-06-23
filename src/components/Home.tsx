import { createContext, useCallback, useContext, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { usePlayer } from "@/store/player";
import { useRatings } from "@/store/ratings";
import { usePlayLog } from "@/store/playLog";
import { useLongPress } from "@/lib/touch";
import { TrackActions } from "./TrackActions";
import { hasTauri } from "@/lib/backend";
import * as taste from "@/lib/taste";
import type { Track } from "@/lib/types";
import { createPortal } from "react-dom";
import { Cover, useCover } from "./Cover";
import { SoundDna } from "./SoundDna";
import { Icon } from "./Icons";
import { VibeSearch } from "./VibeSearch";
import { useForYou } from "@/lib/useForYou";
import { toast } from "@/store/toasts";
import { buildFeedCtx, feedBatch, type FeedShelf } from "@/lib/endlessFeed";
import { greeting, dailyBlend, moodLanes, throwbackLane, rediscoverLane, dailyMixes, discoverWeekly, releaseRadar, yearInReview, diversify } from "@/lib/forYouLanes";
import { parseVibe } from "@/lib/vibeSearch";
import { useSettings } from "@/store/settings";
import { TabIntro } from "./TabIntro";
import { useOverlayValue } from "@/lib/backStack";

const KIND_LABEL: Record<taste.MixKind, string> = { genre: "Genre", blend: "For you", discover: "Discover", recipe: "Mix" };
const DISCOVERY = [
  { id: "familiar", label: "Familiar", icon: "favorite", cap: "Closer to what you already love" },
  { id: "balanced", label: "Balanced", icon: "shuffle", cap: "A balanced mix — similar + fresh" },
  { id: "discover", label: "Discover", icon: "bolt", cap: "Surface fresh, unheard music" },
] as const;
// Audio-true mood lanes: each is a vibe query run through the taste engine (BPM + energy), so these
// rank by how a song SOUNDS — not its genre tag. Falls back to genre moods until enough is analyzed.
const MOOD_QUERIES = [
  { id: "chill", title: "Chill", sub: "Low energy, easy", q: "chill mellow" },
  { id: "energy", title: "Energy", sub: "High-octane", q: "energetic workout" },
  { id: "focus", title: "Focus", sub: "Steady, low-distraction", q: "focus instrumental" },
  { id: "sleep", title: "Sleep", sub: "Wind down", q: "peaceful sleepy ambient" },
  { id: "party", title: "Party", sub: "Crowd-pleasers", q: "party dance" },
  { id: "drive", title: "Drive", sub: "On the road", q: "driving cruise" },
  { id: "workout", title: "Workout 170", sub: "Run / cardio tempo", q: "energetic 170 bpm" },
  { id: "commute", title: "Commute", sub: "Easy ride", q: "chill driving" },
];

/** Press-and-hold on a feed card opens the track's action sheet (More like this / Not for me / …).
 *  Provided once at the feed root so cards don't have to thread a handler through every shelf. */
const HoldCtx = createContext<((t: Track) => void) | null>(null);

/** Cover art with the generative Sound-DNA "vibe" glyph as the art-less fallback (respects the
 *  Settings toggle) — so art-less tracks show their fingerprint, not a blank music icon. */
function CardArt({ path, size }: { path: string; size: number }) {
  const url = useCover(path);
  const dna = useSettings((s) => s.soundDna);
  const lazy = useSettings((s) => s.lazyCovers);
  if (url) return <img src={url} alt="" decoding="async" loading={lazy ? "lazy" : undefined} />;
  if (path && dna) return <SoundDna id={path} size={size} />;
  return <Icon name="music" size={Math.round(size * 0.4)} />;
}

/** One cell of a cover mosaic (a rep track id == its path). */
function MosaicCell({ path }: { path?: string }) {
  return <div className="wp-mc">{path ? <CardArt path={path} size={100} /> : <Icon name="music" size={16} />}</div>;
}

/** 2×2 album-art mosaic from a mix's representative tracks. */
function Mosaic({ reps }: { reps: string[] }) {
  const cells = reps.slice(0, 4);
  while (cells.length < 4) cells.push("");
  return <div className="wp-mosaic">{cells.map((p, i) => <MosaicCell key={i} path={p || undefined} />)}</div>;
}

function MixCard({ mix, count, onPlay }: { mix: taste.GeneratedMix; count: number; onPlay: () => void }) {
  return (
    <button className="wp-mixcard" onClick={onPlay} title={`Play ${mix.name}`}>
      <div className="wp-mixcard-art">
        <Mosaic reps={mix.reps} />
        <span className="wp-mixcard-play"><Icon name="play" size={22} color="var(--md-on-primary)" /></span>
      </div>
      <div className="wp-mixcard-meta">
        <div className="md-body-m ellipsis wp-mixcard-title">{mix.name}</div>
        <div className="md-body-s wp-muted ellipsis">{KIND_LABEL[mix.kind]} · {count} songs</div>
      </div>
    </button>
  );
}

/** Generic mosaic card for library-derived shelves (genres, most-played, liked, recently-added). */
function ArtCard({ name, sub, reps, onPlay }: { name: string; sub: string; reps: string[]; onPlay: () => void }) {
  return (
    <button className="wp-mixcard" onClick={onPlay} title={`Play ${name}`}>
      <div className="wp-mixcard-art">
        <Mosaic reps={reps} />
        <span className="wp-mixcard-play"><Icon name="play" size={22} color="var(--md-on-primary)" /></span>
      </div>
      <div className="wp-mixcard-meta">
        <div className="md-body-m ellipsis wp-mixcard-title">{name}</div>
        <div className="md-body-s wp-muted ellipsis">{sub}</div>
      </div>
    </button>
  );
}

/** Single-cover card (a track or an album) for scrollable shelves — so a shelf shows MANY cards,
 *  not one lonely mosaic. Pass `holdTrack` to enable press-and-hold → that track's action sheet. */
function MediaCard({ coverPath, title, sub, onPlay, holdTrack }: { coverPath: string; title: string; sub: string; onPlay: () => void; holdTrack?: Track }) {
  const onHold = useContext(HoldCtx);
  const active = !!(onHold && holdTrack);
  const lp = useLongPress(() => holdTrack && onHold?.(holdTrack));
  const click = () => { if (active && lp.fired.current) { lp.fired.current = false; return; } onPlay(); };
  return (
    <button className="wp-mixcard" onClick={click} title={`Play ${title}`} {...(active ? lp.handlers : {})}>
      <div className="wp-mixcard-art">
        <CardArt path={coverPath} size={164} />
        <span className="wp-mixcard-play"><Icon name="play" size={22} color="var(--md-on-primary)" /></span>
      </div>
      <div className="wp-mixcard-meta">
        <div className="md-body-m ellipsis wp-mixcard-title">{title}</div>
        <div className="md-body-s wp-muted ellipsis">{sub}</div>
      </div>
    </button>
  );
}

/** A shelf of individual track cards (scrollable to the right) — for sets backed by one track list. */
function TrackShelf({ title, sub, tracks, max = 18, onSeeAll }: { title: string; sub: string; tracks: Track[]; max?: number; onSeeAll?: (title: string, tracks: Track[]) => void }) {
  if (tracks.length < 2) return null;
  return (
    <Shelf title={title} sub={sub} onSeeAll={tracks.length > max && onSeeAll ? () => onSeeAll(title, tracks) : undefined}>
      {tracks.slice(0, max).map((t, i) => (
        <MediaCard key={t.id} coverPath={t.path} title={t.title} sub={t.artist} holdTrack={t}
          onPlay={() => usePlayer.getState().playFrom(tracks, i)} />
      ))}
    </Shelf>
  );
}

/** Mood/genre quick-launch chips (YT-Music style top row). Tapping starts that set playing. */
function CategoryChips({ chips }: { chips: { label: string; tracks: Track[]; shuffle?: boolean }[] }) {
  if (!chips.length) return null;
  return (
    <div className="wp-chips-row">
      {chips.map((c) => (
        <button key={c.label} className="wp-chip-pill"
          onClick={() => usePlayer.getState().playFrom(c.shuffle ? shuffled(c.tracks) : c.tracks, 0)}>
          {c.label}
        </button>
      ))}
    </div>
  );
}

/** One square art tile in the Quick Picks grid. */
function QuickTile({ t, onPlay }: { t: Track; onPlay: () => void }) {
  const onHold = useContext(HoldCtx);
  const lp = useLongPress(() => onHold?.(t));
  const click = () => { if (lp.fired.current) { lp.fired.current = false; return; } onPlay(); };
  return (
    <button className="wp-qg-tile" onClick={click} {...(onHold ? lp.handlers : {})}>
      <div className="wp-qg-art"><CardArt path={t.path} size={150} /></div>
      <div className="md-body-s ellipsis wp-qg-label">{t.title}</div>
    </button>
  );
}

/** YT-Music "Kurzwahl": a horizontally-paged 3×3 grid (9 tiles/page) you swipe between, with page
 *  dots below. Each page snaps full-width; the active dot tracks the scroll position. */
function QuickGrid({ tracks }: { tracks: Track[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [page, setPage] = useState(0);
  if (tracks.length < 3) return null;
  const pages: Track[][] = [];
  for (let i = 0; i < tracks.length; i += 9) pages.push(tracks.slice(i, i + 9));
  const onScroll = () => {
    const el = ref.current; if (!el) return;
    const p = Math.round(el.scrollLeft / Math.max(1, el.clientWidth));
    if (p !== page) setPage(p);
  };
  return (
    <section className="wp-shelf">
      <div className="wp-shelf-head"><h3 className="md-title-s">Quick picks</h3><span className="md-body-s wp-muted">From your library</span></div>
      <div className="wp-qg" ref={ref} onScroll={onScroll}>
        {pages.map((pg, pi) => (
          <div className="wp-qg-page" key={pi}>
            {pg.map((t, i) => <QuickTile key={t.id} t={t} onPlay={() => usePlayer.getState().playFrom(tracks, pi * 9 + i)} />)}
          </div>
        ))}
      </div>
      {pages.length > 1 && (
        <div className="wp-qg-dots">{pages.map((_, i) => <span key={i} className={`wp-qg-dot ${i === page ? "on" : ""}`} />)}</div>
      )}
    </section>
  );
}

/** YT-Music-style featured card: mosaic + title on top, a few track rows, then play (+ optional flow). */
function FeaturedMix({ name, sub, tracks, onFlow }: { name: string; sub: string; tracks: Track[]; onFlow?: () => void }) {
  if (tracks.length < 3) return null;
  const play = (i: number) => usePlayer.getState().playFrom(tracks, i);
  return (
    <div className="wp-feature">
        <div className="wp-feature-head">
          <Mosaic reps={tracks.slice(0, 4).map((t) => t.path)} />
          <div className="wp-row-text">
            <div className="md-title-s ellipsis">{name}</div>
            <div className="md-body-s wp-muted ellipsis">{sub} · {tracks.length} songs</div>
          </div>
        </div>
        {tracks.slice(0, 3).map((t, i) => (
          <button key={t.id} className="wp-feature-row" onClick={() => play(i)}>
            <MosaicCell path={t.path} />
            <div className="wp-row-text"><div className="md-body-m ellipsis">{t.title}</div><div className="md-body-s wp-muted ellipsis">{t.artist}</div></div>
          </button>
        ))}
        <div className="wp-feature-actions">
          <button className="wp-feature-play" onClick={() => play(0)} title={`Play ${name}`}><Icon name="play" size={22} color="var(--md-on-primary)" /></button>
          {onFlow && <button className="wp-feature-flow" onClick={onFlow} title="Play as a beatmatched flow"><Icon name="allInclusive" size={20} /></button>}
        </div>
    </div>
  );
}

function Shelf({ title, sub, onSeeAll, children }: { title: string; sub?: string; onSeeAll?: () => void; children: React.ReactNode }) {
  return (
    <section className="wp-shelf">
      <div className="wp-shelf-head">
        <h3 className="md-title-s">{title}</h3>
        {sub && <span className="md-body-s wp-muted">{sub}</span>}
        {onSeeAll && <button className="wp-shelf-more md-label-m" onClick={onSeeAll}>See all <Icon name="next" size={14} /></button>}
      </div>
      <div className="wp-shelf-row">{children}</div>
    </section>
  );
}

/** Fisher–Yates copy (stable, no Date/Math.random in shared modules concern — UI only). */
function shuffled<T>(a: T[]): T[] {
  const r = [...a];
  for (let i = r.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [r[i], r[j]] = [r[j], r[i]]; }
  return r;
}

/** Hold a value steady while `active` is false, only refreshing it when active. The For-You feed does ~40
 *  full-library passes; Home stays MOUNTED (hidden) when you browse elsewhere, so without this every track
 *  play (which bumps ratingStats) would silently rebuild the whole feed off-screen — the big intermittent
 *  lag. Freezing its inputs while Home is hidden means it only recomputes when you're actually looking. */
function useFrozen<T>(value: T, active: boolean): T {
  const ref = useRef(value);
  if (active) ref.current = value;
  return ref.current;
}

export function Home() {
  const rawLibrary = usePlayer((s) => s.library);
  const setTab = usePlayer((s) => s.setTab);
  const current = usePlayer((s) => s.current());
  const rawRatingStats = useRatings((s) => s.stats);
  const discovery = useSettings((s) => s.discovery);
  const forYouIntroSeen = useSettings((s) => s.forYouIntroSeen);
  // Only let the expensive feed inputs change while Home is the visible tab, and let React build the
  // result in a non-urgent transition (useDeferredValue) so the first open never blocks interaction.
  const homeActive = usePlayer((s) => s.tab === "home");
  const library = useDeferredValue(useFrozen(rawLibrary, homeActive));
  const ratingStats = useDeferredValue(useFrozen(rawRatingStats, homeActive));
  const [mixes, setMixes] = useState<taste.GeneratedMix[]>([]);
  const [stations, setStations] = useState<taste.Station[]>([]);
  const [recipes, setRecipes] = useState<taste.Recipe[]>([]);
  const [stats, setStats] = useState<taste.TasteStats>({ tracks: 0, events: 0 });
  const [loading, setLoading] = useState(true);

  const byId = useMemo(() => new Map(library.map((t) => [t.id, t])), [library]);
  const resolve = useCallback((ids: string[]) => ids.map((id) => byId.get(id)).filter((t): t is Track => !!t), [byId]);
  const playIds = useCallback((ids: string[]) => { const q = resolve(ids); if (q.length) void usePlayer.getState().playFrom(q, 0); }, [resolve]);
  const playTracks = useCallback((tracks: Track[]) => { if (tracks.length) void usePlayer.getState().playFrom(tracks, 0); }, []);

  // All the library-derived shelves + smart blends live in one memoized hook (keeps this a renderer).
  const fy = useForYou(library, ratingStats, discovery);
  const reps = (tracks: Track[]) => tracks.slice(0, 4).map((t) => t.path);

  // Time-of-day, mood, and history lanes (all local + synchronous).
  const hi = greeting();
  // Per-hour learning: what you usually play around now biases the time-of-day blend (subscribe to
  // `clock` so it re-tunes as habits change; recompute each hour the component is alive).
  const clock = usePlayLog((s) => s.clock);
  const hourPrefs = usePlayLog((s) => s.hourPrefs);
  const prefs = useMemo(() => hourPrefs(new Date().getHours()), [clock, hourPrefs]);
  const daily = useMemo(() => dailyBlend(fy.blend.length >= 6 ? fy.blend : library, 40, prefs), [fy.blend, library, prefs]);
  const moods = useMemo(() => moodLanes(library), [library]);
  const ratStat = useCallback((id: string) => ratingStats[id] ?? { rating: 0, plays: 0, lastPlayed: 0 }, [ratingStats]);
  const throwback = useMemo(() => throwbackLane(library), [library]);
  const rediscover = useMemo(() => rediscoverLane(library, ratStat), [library, ratStat]);
  const dMixes = useMemo(() => dailyMixes(library), [library]);
  const discover = useMemo(() => discoverWeekly(library, ratStat), [library, ratStat]);
  const release = useMemo(() => releaseRadar(library, ratStat), [library, ratStat]);
  const year = useMemo(() => yearInReview(library, ratStat), [library, ratStat]);
  // "Made for you" = a single horizontal row of mix cards (scroll right for more), not stacked blocks.
  const mixCards = useMemo(() => {
    const out: { id: string; name: string; sub: string; tracks: Track[] }[] = [];
    if (daily.tracks.length >= 6) out.push({ id: "daily", name: daily.title, sub: daily.tuned ? "Tuned to your routine" : "For right now", tracks: daily.tracks });
    if (fy.blend.length >= 6) out.push({ id: "blend", name: "Made for you", sub: "Everything you like", tracks: fy.blend });
    if (discover) out.push({ id: "discover", name: discover.title, sub: "Fresh weekly", tracks: discover.tracks });
    for (const m of dMixes) out.push({ id: m.id, name: m.title, sub: m.sub, tracks: m.tracks });
    if (release) out.push({ id: "release", name: release.title, sub: "Newly added", tracks: release.tracks });
    if (fy.mostPlayed.length >= 3) out.push({ id: "repeat", name: "On repeat", sub: "Most-played", tracks: fy.mostPlayed });
    if (year) out.push({ id: "year", name: "Wrapped", sub: year.sub, tracks: year.tracks });
    return out;
  }, [daily, fy.blend, discover, dMixes, release, fy.mostPlayed, year]);

  const reload = useCallback(async () => {
    setLoading(true);
    const [m, st, rc, sx] = await Promise.all([taste.generatedMixes(60), taste.stations(), taste.recipes(), taste.stats()]);
    setMixes(m); setStations(st); setRecipes(rc); setStats(sx);
    setLoading(false);
  }, []);
  useEffect(() => { void reload(); }, [reload]);

  // "See all" overlay for any shelf (full track list). useOverlayValue auto-wires the back button.
  const [seeAll, setSeeAll] = useOverlayValue<{ title: string; tracks: Track[] }>();
  const openSeeAll = useCallback((title: string, tracks: Track[]) => setSeeAll({ title, tracks }), [setSeeAll]);

  // Press-and-hold a feed card → that track's action sheet. TrackActions self-guards, so no guard here.
  const [menuTrack, setMenuTrack] = useState<Track | null>(null);
  const openMenu = useCallback((t: Track) => setMenuTrack(t), []);

  // ── Endless feed: an inexhaustible stream of fresh shelf ideas appended as you scroll ──────────
  const feedCtx = useMemo(() => buildFeedCtx(library), [library]);
  const [feed, setFeed] = useState<FeedShelf[]>([]);
  const [feedDone, setFeedDone] = useState(false);
  const feedCursor = useRef(0);
  const sentinel = useRef<HTMLDivElement>(null);
  const loadMore = useCallback(() => {
    const { shelves, cursor } = feedBatch(feedCtx, feedCursor.current, 6);
    feedCursor.current = cursor;
    if (!shelves.length) { setFeedDone(true); return; }
    setFeed((f) => [...f, ...shelves]);
  }, [feedCtx]);
  // (re)seed the feed whenever the library changes
  useEffect(() => { feedCursor.current = 0; setFeed([]); setFeedDone(false); loadMore(); }, [loadMore]);
  // append the next batch as the bottom sentinel nears the viewport
  useEffect(() => {
    const el = sentinel.current; if (!el || feedDone) return;
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) loadMore(); }, { rootMargin: "800px" });
    io.observe(el);
    return () => io.disconnect();
  }, [loadMore, feedDone]);

  // Taste-fusion: content-based "Sounds like …" lanes from on-device fingerprints. Behaviour
  // (affinity) picks the top few seeds; the audio-similarity engine fills each lane.
  const [fusion, setFusion] = useState<{ seed: Track; tracks: Track[] }[]>([]);
  useEffect(() => {
    if (!hasTauri || stats.tracks === 0) { setFusion([]); return; }
    const stat = (id: string) => ratingStats[id] ?? { rating: 0, plays: 0, lastPlayed: 0 };
    const seeds = [...library].filter((t) => stat(t.id).plays > 0 || stat(t.id).rating >= 4)
      .sort((a, b) => (stat(b.id).plays + stat(b.id).rating) - (stat(a.id).plays + stat(a.id).rating)).slice(0, 3);
    if (!seeds.length) { setFusion([]); return; }
    let alive = true;
    void Promise.all(seeds.map((seed) => taste.similar(seed.id, 30).then((pairs) => {
      const tracks = pairs.map(([id]) => byId.get(id)).filter((t): t is Track => !!t && t.id !== seed.id);
      return tracks.length >= 4 ? { seed, tracks } : null;
    }))).then((lanes) => { if (alive) setFusion(lanes.filter((l): l is { seed: Track; tracks: Track[] } => !!l)); });
    return () => { alive = false; };
  }, [library, ratingStats, stats.tracks, byId]);

  // Audio-true moods (BPM + energy via the taste engine). Only when enough is analyzed; else the
  // genre-keyword `moods` below are used. Each query reuses the vibe lexicon → taste.vibe.
  const [audioMoods, setAudioMoods] = useState<{ id: string; title: string; sub: string; tracks: Track[] }[]>([]);
  useEffect(() => {
    if (!hasTauri || stats.tracks < 20) { setAudioMoods([]); return; }
    let alive = true;
    void Promise.all(MOOD_QUERIES.map(async (m) => {
      const p = parseVibe(m.q); if (!p) return null;
      try {
        const hits = await taste.vibe(p.weights, p.bpmMin, p.bpmMax, 36);
        const tracks = diversify(hits.map(([id]) => byId.get(id)).filter((t): t is Track => !!t), 3).slice(0, 18);
        return tracks.length >= 6 ? { id: m.id, title: m.title, sub: m.sub, tracks } : null;
      } catch { return null; }
    })).then((r) => { if (alive) setAudioMoods(r.filter((x): x is { id: string; title: string; sub: string; tracks: Track[] } => !!x)); });
    return () => { alive = false; };
  }, [stats.tracks, byId]);

  // SuperMix: one long cross-cluster flow seeded by a rep from each genre cluster (order: flow).
  const playSupermix = useCallback(async () => {
    try {
      const cls = await taste.clusters();
      const seeds = cls.map((c) => c.reps[0]).filter(Boolean).slice(0, 8);
      const seedIds = seeds.length ? seeds : fy.blend.slice(0, 8).map((t) => t.id);
      if (!seedIds.length) return;
      const ids = await taste.createRecipe({ name: "Supermix", seeds: seedIds, size: 80, order: "flow" });
      if (ids.length) { playIds(ids); toast.success(`Supermix · ${ids.length} tracks`); }
      else if (fy.blend.length) playTracks(fy.blend);
    } catch { if (fy.blend.length) playTracks(fy.blend); }
  }, [fy.blend, playIds, playTracks]);

  const playStation = useCallback(async (id: number) => { playIds(await taste.stationTracks(id, 60)); }, [playIds]);
  const playRecipe = useCallback(async (r: taste.Recipe) => { playIds(await taste.generateRecipe(r)); }, [playIds]);
  const mixFromCurrent = useCallback(async () => {
    if (!current) return;
    const ids = await taste.createRecipe({ name: `Like ${current.title}`, seeds: [current.id], size: 50, order: "flow" });
    playIds(ids); void reload();
  }, [current, playIds, reload]);

  // ── empty state: only when there's genuinely no music to work with ──────────
  if (library.length === 0) {
    return (
      <div className="wp-screen wp-home">
        <div className="wp-home-empty">
          <Icon name="favorite" size={40} />
          <div className="md-title-m">For You</div>
          <div className="md-body-m wp-muted">Add your music and For You fills with genre mixes, your most-played, liked songs and — once analyzed — on-device taste mixes &amp; stations.</div>
          <button className="wp-filled-btn" onClick={() => setTab("library")}>Add music</button>
        </div>
      </div>
    );
  }

  const genres = mixes.filter((m) => m.kind === "genre");
  const blend = mixes.filter((m) => m.kind === "blend" || m.kind === "discover");
  // Nudge analysis only when there's real headroom (lots of songs, few fingerprinted).
  const showAnalyzeBanner = hasTauri && !loading && stats.tracks < Math.min(50, library.length);

  return (
    <HoldCtx.Provider value={openMenu}>
    <div className="wp-screen wp-home">
      {!forYouIntroSeen && (
        <TabIntro icon="favorite" title="For You, made for you"
          body="Your home feed — mixes built from what you actually listen to, all computed on your device. Nothing leaves it."
          points={[
            { icon: "graphicEq", text: "Genre blends, most-played and liked songs." },
            { icon: "shuffle", text: "On-device taste mixes & stations once analyzed." },
            { icon: "bolt", text: "Keeps generating fresh shelves as you scroll." },
          ]}
          onClose={() => useSettings.getState().setForYouIntroSeen(true)} />
      )}
      <div className="wp-home-hero">
        <div className="md-title-m ellipsis">{hi.emoji} {hi.text}</div>
        <div className="wp-home-hero-actions">
          {current && <button className="md-icon-btn" onClick={mixFromCurrent} title="Make a mix around the current song"><Icon name="shuffle" size={20} /></button>}
          <button className="md-icon-btn" title="Refresh" onClick={() => void reload()}><Icon name="refresh" size={20} /></button>
        </div>
      </div>

      <div className="wp-discovery">
        <div className="wp-explore-seg" role="tablist" aria-label="Discovery">
          {DISCOVERY.map((d) => (
            <button key={d.id} role="tab" aria-selected={discovery === d.id} className={`wp-seg-item ${discovery === d.id ? "wp-seg-on" : ""}`}
              onClick={() => useSettings.getState().setDiscovery(d.id)}><Icon name={d.icon} size={15} /> {d.label}</button>
          ))}
        </div>
        <div className="md-body-s wp-muted wp-discovery-cap">{DISCOVERY.find((d) => d.id === discovery)?.cap}</div>
      </div>

      <CategoryChips chips={fy.chips} />

      {stats.tracks > 0 && <VibeSearch />}

      {showAnalyzeBanner && (
        <button className="wp-foryou-banner" onClick={() => setTab("settings")}>
          <Icon name="favorite" size={20} color="var(--md-primary)" />
          <span className="wp-row-text">
            <span className="md-body-l">Smarter mixes</span>
            <span className="md-body-s wp-muted">Analyze your library (or just keep listening) for on-device taste mixes &amp; stations</span>
          </span>
          <Icon name="next" size={18} color="var(--md-on-surface-variant)" />
        </button>
      )}

      {loading && <div className="md-body-s wp-muted" style={{ padding: "8px 4px" }}>Loading your mixes…</div>}

      <QuickGrid tracks={fy.quickPicks} />
      {mixCards.length > 0 && (
        <Shelf title="Made for you" sub="Your mixes — scroll for more">
          {hasTauri && fy.blend.length >= 6 && <ArtCard key="supermix" name="Supermix" sub="One long flow" reps={reps(fy.blend)} onPlay={playSupermix} />}
          {mixCards.map((m) => <ArtCard key={m.id} name={m.name} sub={m.sub} reps={reps(m.tracks)} onPlay={() => playTracks(m.tracks)} />)}
        </Shelf>
      )}
      {(audioMoods.length ? audioMoods : moods).length > 0 && (
        <div className="wp-mood-row">
          {(audioMoods.length ? audioMoods : moods).map((m) => <TrackShelf key={m.id} title={m.title} sub={m.sub} tracks={m.tracks} onSeeAll={openSeeAll} />)}
        </div>
      )}
      {fy.because && (
        <Shelf title={`Because you played ${fy.because.seed}`} sub="More in this lane">
          <ArtCard name={fy.because.seed} sub={`${fy.because.tracks.length} songs`} reps={reps(fy.because.tracks)} onPlay={() => playTracks(fy.because!.tracks)} />
        </Shelf>
      )}
      {fusion.length > 0 && (
        <section className="wp-shelf">
          <div className="wp-feature-lane">
            {fusion.map((f) => <FeaturedMix key={f.seed.id} name={`Sounds like ${f.seed.title}`} sub="Matched by on-device audio analysis · tap ∞ for radio" tracks={[f.seed, ...f.tracks]}
              onFlow={hasTauri ? () => usePlayer.getState().startEndlessSet(f.seed, [f.seed, ...f.tracks]) : undefined} />)}
          </div>
        </section>
      )}
      <TrackShelf title="Jump back in" sub="Recently played" tracks={fy.recentlyPlayed} onSeeAll={openSeeAll} />
      <TrackShelf title="Fresh & familiar" sub="New picks + old favorites" tracks={fy.freshFamiliar} onSeeAll={openSeeAll} />
      {fy.topGenres.slice(0, 3).map((g) => (
        <TrackShelf key={`g-${g.name}`} title={`Your ${g.name}`} sub="From your library" tracks={g.tracks} onSeeAll={openSeeAll} />
      ))}
      {fy.topArtists.slice(0, 2).map((a) => (
        <TrackShelf key={`a-${a.name}`} title={`More from ${a.name}`} sub="Artist you love" tracks={a.tracks} onSeeAll={openSeeAll} />
      ))}
      {fy.newThisWeek.length >= 4 && <TrackShelf title="New this week" sub="Just added" tracks={fy.newThisWeek} onSeeAll={openSeeAll} />}
      {fy.quickHits.length >= 4 && <TrackShelf title="Quick hits" sub="Short and sweet" tracks={fy.quickHits} onSeeAll={openSeeAll} />}
      {fy.longMixes.length >= 2 && <TrackShelf title="Long mixes" sub="Sit back" tracks={fy.longMixes} onSeeAll={openSeeAll} />}

      {blend.length > 0 && (
        <Shelf title="Made for you" sub="Refreshes as you listen">
          {blend.map((m) => <MixCard key={m.id} mix={m} count={m.tracks.length} onPlay={() => playIds(m.tracks)} />)}
        </Shelf>
      )}

      {stations.length > 0 && (
        <Shelf title="Your stations" sub="Endless radio from your taste">
          {stations.map((s) => (
            <button key={s.id} className="wp-mixcard wp-station" onClick={() => void playStation(s.id)} title={`Play ${s.name}`}>
              <div className="wp-mixcard-art wp-station-art"><Icon name="graphicEq" size={30} color="var(--md-on-primary)" /><span className="wp-mixcard-play"><Icon name="play" size={22} color="var(--md-on-primary)" /></span></div>
              <div className="wp-mixcard-meta"><div className="md-body-m ellipsis wp-mixcard-title">{s.name}</div><div className="md-body-s wp-muted">{s.bpm ? `~${Math.round(s.bpm)} BPM` : "Radio"}</div></div>
            </button>
          ))}
        </Shelf>
      )}

      {genres.length > 0 && (
        <Shelf title="Your genres" sub="Auto-detected from your library">
          {genres.map((m) => <MixCard key={m.id} mix={m} count={m.tracks.length} onPlay={() => playIds(m.tracks)} />)}
        </Shelf>
      )}

      {recipes.length > 0 && (
        <Shelf title="Your mixes" sub="Custom recipes">
          {recipes.map((r) => (
            <button key={r.name} className="wp-mixcard wp-recipe" onClick={() => void playRecipe(r)} title={`Play ${r.name}`}>
              <div className="wp-mixcard-art wp-recipe-art"><Icon name="playlist" size={28} color="var(--md-on-primary)" /><span className="wp-mixcard-play"><Icon name="play" size={22} color="var(--md-on-primary)" /></span></div>
              <div className="wp-mixcard-meta"><div className="md-body-m ellipsis wp-mixcard-title">{r.name}</div><div className="md-body-s wp-muted">{r.size} songs · {r.order}</div></div>
            </button>
          ))}
        </Shelf>
      )}

      {/* ── Always-on, library-derived shelves (each a scrollable row of cards) ──── */}
      <TrackShelf title="Liked songs" sub="Songs you love" tracks={fy.liked} onSeeAll={openSeeAll} />

      {fy.gems.length >= 4 && <TrackShelf title="Hidden gems" sub="Loved but barely played" tracks={fy.gems} onSeeAll={openSeeAll} />}

      {fy.albums.length >= 2 && (
        <Shelf title="Albums for you" sub="From your library">
          {fy.albums.map((a) => (
            <MediaCard key={`${a.artist}|${a.name}`} coverPath={a.cover} title={a.name} sub={a.artist}
              onPlay={() => usePlayer.getState().playFrom(a.tracks, 0)} />
          ))}
        </Shelf>
      )}

      {fy.forgotten.length >= 3 && (
        <section className="wp-shelf"><div className="wp-feature-lane"><FeaturedMix name="Forgotten favorites" sub="You haven't heard these in a while" tracks={fy.forgotten} /></div></section>
      )}

      {fy.topArtists.length > 0 && (
        <Shelf title="Your top artists" sub="Most-played in your library">
          {fy.topArtists.map((a) => (
            <ArtCard key={a.name} name={a.name} sub={`${a.tracks.length} songs`} reps={reps(a.tracks)} onPlay={() => playTracks(shuffled(a.tracks))} />
          ))}
        </Shelf>
      )}

      {fy.deepCuts.length >= 4 && <TrackShelf title="Deep cuts" sub="Unplayed tracks by artists you love" tracks={fy.deepCuts} onSeeAll={openSeeAll} />}

      {genres.length === 0 && fy.topGenres.length > 0 && (
        <Shelf title="Browse by genre" sub="From your tags">
          {fy.topGenres.map((g) => (
            <ArtCard key={g.name} name={g.name} sub={`${g.tracks.length} songs`} reps={reps(g.tracks)} onPlay={() => playTracks(shuffled(g.tracks))} />
          ))}
        </Shelf>
      )}

      {fy.decades.length > 0 && (
        <Shelf title="Rewind by decade" sub="From your library's years">
          {fy.decades.map((d) => (
            <ArtCard key={d.name} name={d.name} sub={`${d.tracks.length} songs`} reps={reps(d.tracks)} onPlay={() => playTracks(shuffled(d.tracks))} />
          ))}
        </Shelf>
      )}

      <TrackShelf title="Recently added" sub="Fresh in your library" tracks={fy.recentlyAdded} onSeeAll={openSeeAll} />

      {/* ── On this day / throwback + year-in-review ────────────────────────────── */}
      {throwback && <TrackShelf title={throwback.title} sub={throwback.sub} tracks={throwback.tracks} onSeeAll={openSeeAll} />}
      {rediscover && <TrackShelf title={rediscover.title} sub={rediscover.sub} tracks={rediscover.tracks} onSeeAll={openSeeAll} />}

      {/* ── Endless feed — keeps generating fresh shelves as you scroll, so For You never ends ──── */}
      {feed.map((s) => <TrackShelf key={s.id} title={s.title} sub={s.sub} tracks={s.tracks} onSeeAll={openSeeAll} />)}
      {!feedDone && <div ref={sentinel} className="wp-feed-sentinel" aria-hidden />}

      {seeAll && createPortal(
        <div className="wp-seeall">
          <header className="wp-seeall-head">
            <button className="md-icon-btn" onClick={() => setSeeAll(null)} title="Back"><Icon name="prev" size={22} /></button>
            <div className="wp-row-text"><div className="md-title-m ellipsis">{seeAll.title}</div><div className="md-body-s wp-muted">{seeAll.tracks.length} songs</div></div>
            <button className="wp-filled-btn wp-btn-sm" onClick={() => playTracks(seeAll.tracks)}><Icon name="play" size={16} /> Play</button>
          </header>
          <div className="wp-seeall-list">
            {seeAll.tracks.map((t, i) => (
              <button key={t.id} className="wp-row" onClick={() => usePlayer.getState().playFrom(seeAll.tracks, i)}>
                <Cover path={t.path} size={44} />
                <div className="wp-row-text"><div className="md-body-l ellipsis">{t.title}</div><div className="md-body-s wp-muted ellipsis">{t.artist}</div></div>
              </button>
            ))}
          </div>
        </div>, document.body)}

      {menuTrack && <TrackActions tracks={[menuTrack]} onClose={() => setMenuTrack(null)} />}
    </div>
    </HoldCtx.Provider>
  );
}
