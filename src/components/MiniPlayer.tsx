import { useRef, useState } from "react";
import { usePlayer } from "@/store/player";
import { useSettings } from "@/store/settings";
import { buzz } from "@/lib/touch";
import { Icon } from "./Icons";
import { Cover, useCover } from "./Cover";
import { SquiggleSeek } from "./SquiggleSeek";

const SWIPE = 56; // px threshold to register a gesture

/** Poweramp-style fully-rounded mini player pinned above the nav.
 *  Tap → Now Playing · swipe ↑ → expand · swipe ←/→ → next/prev. Hidden in Now Playing & Settings (App). */
export function MiniPlayer() {
  const t = usePlayer((s) => s.current());
  const playing = usePlayer((s) => s.playing);
  const { toggle, next, prev, setTab } = usePlayer.getState();
  const art = useCover(t?.path);

  const start = useRef<{ x: number; y: number } | null>(null);
  const [dx, setDx] = useState(0);          // live horizontal drag (visual follow)
  const [hint, setHint] = useState<"prev" | "next" | null>(null);

  if (!t) return null;

  const onDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest(".wp-mini-btn")) return; // let buttons handle their own taps
    start.current = { x: e.clientX, y: e.clientY };
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    if (!start.current) return;
    const ddx = e.clientX - start.current.x;
    const ddy = e.clientY - start.current.y;
    if (Math.abs(ddx) > Math.abs(ddy)) {
      setDx(Math.max(-64, Math.min(64, ddx)));
      setHint(ddx <= -SWIPE ? "next" : ddx >= SWIPE ? "prev" : null);
    }
  };
  const onUp = (e: React.PointerEvent) => {
    const s = start.current; start.current = null;
    const reset = () => { setDx(0); setHint(null); };
    if (!s) return reset();
    const ddx = e.clientX - s.x, ddy = e.clientY - s.y;
    const moved = Math.abs(ddx) + Math.abs(ddy);
    if (ddy < -SWIPE && Math.abs(ddy) > Math.abs(ddx)) { setTab("playing"); return reset(); } // swipe up
    if (ddx <= -SWIPE) { next(); buzz(); return reset(); }                                     // swipe left → next
    if (ddx >= SWIPE) { prev(); buzz(); return reset(); }                                      // swipe right → prev
    if (moved < 10) setTab("playing");                                                         // tap
    reset();
  };

  return (
    <div className="wp-mini-shell">
      {hint && <span className={`wp-mini-hint wp-mini-hint-${hint}`}><Icon name={hint === "next" ? "next" : "prev"} size={20} /></span>}
      <div className="wp-mini" style={{ transform: dx ? `translateX(${dx}px)` : undefined, transition: start.current ? "none" : undefined }}
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
        {/* album-art glow backdrop — the bar takes on the playing track's colours (Poweramp v5 / Apple Music) */}
        {art && <div className="wp-mini-art" style={{ backgroundImage: `url(${art})` }} />}
        <div className="wp-mini-scrim" />
        <Cover path={t.path} size={46} radius="md" fade />
        <div className="wp-mini-main">
          <div className="wp-row-text">
            <div className="md-title-s ellipsis">{t.title}</div>
            <div className="md-body-s wp-muted ellipsis">{t.artist}</div>
          </div>
          <MiniProgress />
        </div>
        <button className="md-icon-btn wp-mini-btn wp-mini-play" onPointerDown={(e) => e.stopPropagation()} onClick={() => toggle()} title={playing ? "Pause" : "Play"}>
          <Icon name={playing ? "pause" : "play"} />
        </button>
        <button className="md-icon-btn wp-mini-btn" onPointerDown={(e) => e.stopPropagation()} onClick={() => next()} title="Next"><Icon name="next" /></button>
      </div>
    </div>
  );
}

/** Isolated so the per-tick position update repaints ONLY the progress bar (a compositor-only scaleX
 *  on its own layer), never the whole mini-player — and so it can't force the frosted nav / popups to
 *  re-blur every frame during playback. [perf] */
function MiniProgress() {
  const position = usePlayer((s) => s.position);
  const duration = usePlayer((s) => s.duration);
  const playing = usePlayer((s) => s.playing);
  const seek = usePlayer((s) => s.seek);
  const seekStyle = useSettings((s) => s.seekStyle);
  const amp = useSettings((s) => s.waveAmp);
  const speed = useSettings((s) => s.waveSpeed);
  const ref = useRef<HTMLDivElement>(null);
  const pct = duration ? Math.max(0, Math.min(1, position / duration)) : 0;

  // Drag (or tap) anywhere on the bar to scrub. stopPropagation so it never triggers the mini-player's
  // swipe/tap-to-expand gestures.
  const seekTo = (clientX: number) => {
    const el = ref.current; if (!el || !duration) return;
    const r = el.getBoundingClientRect();
    seek(Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * duration);
  };
  const onDown = (e: React.PointerEvent) => {
    e.stopPropagation(); e.preventDefault();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    seekTo(e.clientX);
    const move = (ev: PointerEvent) => seekTo(ev.clientX);
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // Wavy (Android-12 squiggle) look — reuses the SquiggleSeek used by the full player, which is draggable.
  if (seekStyle === "wavy") {
    return (
      <div className="wp-mini-prog-wavy" onPointerDown={(e) => e.stopPropagation()}>
        <SquiggleSeek value={position} max={duration || 1} onChange={seek} onCommit={seek}
          playing={playing} amp={amp} speed={speed} height={16} />
      </div>
    );
  }
  return (
    <div ref={ref} className="wp-mini-prog-hit" onPointerDown={onDown} title="Drag to seek">
      <div className="wp-mini-prog"><div className="wp-mini-prog-fill" style={{ transform: `scaleX(${pct})` }} /></div>
    </div>
  );
}
