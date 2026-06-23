import { useRef, useState, lazy, Suspense, type ReactNode } from "react";
import { usePlayer, type Tab } from "@/store/player";
import { useSleep } from "@/store/sleep";
import { useUi } from "@/store/ui";
import { useSettings } from "@/store/settings";
import { toast } from "@/store/toasts";
import { Icon } from "./Icons";
import { useCover } from "./Cover";
// The Material shape indicator carries ~40 KB of path data and is only used by the non-default "shape"
// nav indicator → code-split it out of the launch bundle, load on demand. [launch perf]
const MaterialShape = lazy(() => import("./MaterialShape").then((m) => ({ default: m.MaterialShape })));
import type { MaterialShapeName } from "./materialShapes";
import { NavBloom, type BloomItem } from "./NavBloom";
import { useT, type TKey } from "@/lib/i18n";
import { SHOW_VISUALIZER } from "@/lib/features";

// Three big icon-only tabs: Music (library) · Player (centre) · Settings. For You / EQ / Visualizer
// are reached from inside the screens AND from each tab's press-and-hold bloom (NavBloom).
const DESTS: { tab: Tab; key: TKey }[] = [
  { tab: "library", key: "nav.music" },
  { tab: "playing", key: "nav.player" },
  { tab: "settings", key: "nav.settings" },
];

// Rounded line-art glyphs (soft outlines, round caps — Trapnation style) rather than filled icons.
const GLYPH: Record<string, ReactNode> = {
  library: (<><path d="M4 14a8 8 0 0 1 16 0" /><rect x="2.6" y="13" width="4.6" height="7.4" rx="2.3" /><rect x="16.8" y="13" width="4.6" height="7.4" rx="2.3" /></>),
  playing: (<><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="2.4" /></>),
  settings: (<><path d="M4 7h16" /><path d="M4 12h16" /><path d="M4 17h16" /><circle cx="9" cy="7" r="2.4" fill="currentColor" stroke="none" /><circle cx="15" cy="12" r="2.4" fill="currentColor" stroke="none" /><circle cx="8" cy="17" r="2.4" fill="currentColor" stroke="none" /></>),
};
// Alternate centre glyph: a ring with a GAP cut out of the outline (circumference ≈ 56.5 → "44 12.5"
// leaves one ~80° gap) so the spin-while-playing is actually visible (a full circle looks static
// spinning). Same centre dot as the disc.
const PLAYING_RING: ReactNode = (<><circle cx="12" cy="12" r="9" strokeDasharray="44 12.5" /><circle cx="12" cy="12" r="2.4" /></>);

const HOLD_MS = 240;

function shuffleAll() {
  const { library, playFrom } = usePlayer.getState();
  if (!library.length) {
    toast.info("Library is empty");
    return;
  }
  const q = library.slice();
  for (let i = q.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [q[i], q[j]] = [q[j], q[i]];
  }
  void playFrom(q, 0);
}

// Endless Set: beatmatched/key-aware auto-DJ. Seeds from the current track when one is playing,
// else builds across the library. The store analyzes the pool then drives planned crossfades.
function startEndless() {
  const { startEndlessSet, stopEndlessSet, endless, current } = usePlayer.getState();
  if (endless) { stopEndlessSet(); toast.info("Endless Set off — queue continues normally."); return; }
  void startEndlessSet(current() ?? undefined);
}

function cycleSleep() {
  const order = [0, 15, 30, 60];
  const cur = useSleep.getState().minutes;
  const next = order[(order.indexOf(cur) + 1) % order.length] ?? 15;
  useSleep.getState().start(next);
  toast.success(next ? `Sleep timer: ${next} min` : "Sleep timer off");
}

// Per-tab bloom actions. NavBar stays dumb — actions reach into existing stores.
function bloomsFor(tab: Tab, setTab: (t: Tab) => void): BloomItem[] {
  const ic = (n: string) => <Icon name={n} size={22} />;
  if (tab === "library")
    return [
      { id: "foryou", label: "For You", icon: ic("favorite"), action: () => setTab("home") },
      { id: "endless", label: "Endless Set", icon: ic("allInclusive"), action: startEndless },
      { id: "shuffle", label: "Shuffle All", icon: ic("shuffle"), action: shuffleAll },
      { id: "search", label: "Search", icon: ic("search"), action: () => setTab("search") },
    ];
  if (tab === "playing")
    return [
      { id: "endless", label: "Endless Set", icon: ic("allInclusive"), action: startEndless },
      ...(SHOW_VISUALIZER ? [{ id: "viz", label: "Visualizer", icon: ic("graphicEq"), action: () => setTab("visualizer") }] : []),
      { id: "eq", label: "EQ", icon: ic("tune"), action: () => setTab("eq") },
      { id: "sleep", label: "Sleep Timer", icon: ic("timer"), action: cycleSleep },
    ];
  const toSettings = (s: string) => { setTab("settings"); useUi.getState().openSettings(s); };
  return [
    { id: "output", label: "Audio", icon: ic("volume"), action: () => toSettings("audio") },
    { id: "theme", label: "Look", icon: ic("palette"), action: () => toSettings("appearance") },
    { id: "rescan", label: "Rescan Library", icon: ic("refresh"), action: () => { void usePlayer.getState().rescan(); toast.info("Rescanning library…"); } },
    { id: "backup", label: "Backup", icon: ic("copy"), action: () => toSettings("backup") },
  ];
}

/** Floating 3-tab bar with rounded line icons. Tap switches tabs; press-and-hold blooms a
 *  cluster of glass quick-action pills. CSS switches it to a left nav rail on wide screens. */
export function NavBar() {
  const t = useT();
  const tab = usePlayer((s) => s.tab);
  const setTab = usePlayer((s) => s.setTab);
  const playing = usePlayer((s) => s.playing);
  const curPath = usePlayer((s) => s.current()?.path);
  const art = useCover(curPath); // the nav carries its own blurred album-art tint (like the mini-player)
  const navVinyl = useSettings((s) => s.navVinyl);
  const navCenterIcon = useSettings((s) => s.navCenterIcon);
  const navIndicator = useSettings((s) => s.navIndicator);
  const navShape = useSettings((s) => s.navShape) as MaterialShapeName;
  // The centre (Player) tab spins like a record: always, only while playing, or never.
  const vinylSpin = navVinyl === "always" || (navVinyl === "playing" && playing);
  const [bloom, setBloom] = useState<{ tab: Tab; anchor: DOMRect; start: { x: number; y: number } } | null>(null);
  // the tab visibly "charges" during the hold, then releases into the bloom.
  const [charging, setCharging] = useState<Tab | null>(null);

  const timer = useRef<number | null>(null);
  const startPt = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const suppressClick = useRef(false);

  const clearTimer = () => {
    if (timer.current != null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  };

  const onDown = (e: React.PointerEvent<HTMLButtonElement>, t: Tab) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const node = e.currentTarget;
    startPt.current = { x: e.clientX, y: e.clientY };
    suppressClick.current = false;
    setCharging(t); // begin the charge animation
    clearTimer();
    timer.current = window.setTimeout(() => {
      timer.current = null;
      suppressClick.current = true;
      navigator.vibrate?.(8);
      setBloom({ tab: t, anchor: node.getBoundingClientRect(), start: { ...startPt.current } });
    }, HOLD_MS);
  };
  const onMove = (e: React.PointerEvent) => {
    if (timer.current != null) {
      const d = Math.hypot(e.clientX - startPt.current.x, e.clientY - startPt.current.y);
      if (d > 10) { clearTimer(); setCharging(null); } // a scroll / drag — not a hold
    }
  };
  const endHold = () => {
    const pending = timer.current != null; // released before the bloom opened
    clearTimer();
    if (pending) setCharging(null); // else the bloom is open → stays charged as its root
  };
  const closeBloom = () => { setBloom(null); setCharging(null); };

  // a sub-screen (For You / EQ / Visualizer / Search) keeps its parent tab lit
  const parent = (t: Tab): Tab =>
    t === "home" || t === "search" ? "library" : t === "eq" || t === "visualizer" ? "playing" : t;

  return (
    <>
      <nav className={`wp-nav wp-nav-3 ${bloom ? "wp-nav-bloom-open" : ""} ${charging ? "wp-nav-charging-any" : ""}`}>
        {art && <div className="wp-nav-art" style={{ backgroundImage: `url(${art})` }} aria-hidden />}
        <div className="wp-nav-scrim" aria-hidden />
        {DESTS.map((d) => {
          const active = parent(tab) === d.tab;
          return (
          <button
            key={d.tab}
            className={`wp-nav-item ${active ? "wp-nav-active" : ""} ${charging === d.tab ? "wp-nav-charging" : ""} ${bloom?.tab === d.tab ? "wp-nav-rooted" : ""}`}
            onPointerDown={(e) => onDown(e, d.tab)}
            onPointerMove={onMove}
            onPointerUp={endHold}
            onPointerCancel={endHold}
            onPointerLeave={endHold}
            onClick={() => {
              if (suppressClick.current) { suppressClick.current = false; return; }
              setTab(d.tab);
            }}
            title={t(d.key)}
            aria-label={t(d.key)}
          >
            <span className="wp-nav-pill">
              {navIndicator === "shape" && active && (
                <Suspense fallback={null}>
                  <MaterialShape shape={navShape} size={d.tab === "playing" ? 50 : 46} color="var(--md-secondary-container)" className="wp-nav-shape" />
                </Suspense>
              )}
              <svg className={`wp-nav-glyph ${d.tab === "playing" && vinylSpin ? "wp-nav-spin" : ""}`} viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{d.tab === "playing" && navCenterIcon === "ring" ? PLAYING_RING : GLYPH[d.tab]}</svg>
            </span>
          </button>
          );
        })}
      </nav>
      {bloom && (
        <NavBloom
          anchor={bloom.anchor}
          startPoint={bloom.start}
          items={bloomsFor(bloom.tab, setTab)}
          onClose={closeBloom}
        />
      )}
    </>
  );
}
