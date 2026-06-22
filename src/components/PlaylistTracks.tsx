import { useEffect, useRef, useState } from "react";
import { usePlayer } from "@/store/player";
import { usePlaylists } from "@/store/playlists";
import { Cover } from "./Cover";
import { Icon } from "./Icons";
import { buzz } from "@/lib/touch";
import type { Track } from "@/lib/types";

const ROW = 60;   // fixed row height → simple index math + windowing
const EDGE = 88;  // auto-scroll zone at the top/bottom while dragging

/** Reorderable playlist track list. WINDOWED — only the visible rows (+ overscan) are mounted, so a huge
 *  playlist opens instantly and scrolls smoothly instead of mounting thousands of rows + covers at once.
 *  Drag the ☰ handle to move a track (index math, so it works with windowing); holding near an edge
 *  auto-scrolls. Tap a row to play, × to remove. */
export function PlaylistTracks({ plId, tracks }: { plId: string; tracks: Track[] }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [from, setFrom] = useState<number | null>(null); // index being dragged
  const [over, setOver] = useState<number | null>(null); // insertion position 0..n
  const yRef = useRef(0);                                 // latest pointer Y (viewport)
  const rafRef = useRef(0);
  // Windowing state: which slice of rows to mount, from the live scroll position + viewport height.
  const [scroll, setScroll] = useState(0);
  const [vh, setVh] = useState(600);
  const sRaf = useRef(0);
  useEffect(() => {
    const el = scrollRef.current; if (!el) return;
    const ro = new ResizeObserver(() => setVh(el.clientHeight)); ro.observe(el); setVh(el.clientHeight);
    return () => ro.disconnect();
  }, []);
  const onScroll = () => {
    if (sRaf.current) return;
    sRaf.current = requestAnimationFrame(() => { sRaf.current = 0; const el = scrollRef.current; if (el) setScroll(el.scrollTop); });
  };

  const insertionAtY = (clientY: number): number => {
    const el = scrollRef.current; if (!el) return over ?? 0;
    const r = el.getBoundingClientRect();
    const localY = clientY - r.top + el.scrollTop;
    return Math.max(0, Math.min(tracks.length, Math.round(localY / ROW)));
  };
  const stopScroll = () => { if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = 0; } };
  const tickScroll = () => {
    const el = scrollRef.current;
    if (!el || from === null) { rafRef.current = 0; return; }
    const r = el.getBoundingClientRect();
    const d = yRef.current < r.top + EDGE ? -1 : yRef.current > r.bottom - EDGE ? 1 : 0;
    if (d) { el.scrollTop += d * 10; setScroll(el.scrollTop); setOver(insertionAtY(yRef.current)); }
    rafRef.current = requestAnimationFrame(tickScroll);
  };
  const start = (i: number, e: React.PointerEvent) => {
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    yRef.current = e.clientY; setFrom(i); setOver(i); buzz(12);
    if (!rafRef.current) rafRef.current = requestAnimationFrame(tickScroll);
  };
  const move = (e: React.PointerEvent) => { if (from === null) return; yRef.current = e.clientY; setOver(insertionAtY(e.clientY)); };
  const end = () => {
    stopScroll();
    if (from !== null && over !== null) {
      let to = over > from ? over - 1 : over;           // account for the dragged row being removed first
      to = Math.max(0, Math.min(tracks.length - 1, to));
      if (to !== from) usePlaylists.getState().moveTrack(plId, from, to);
    }
    setFrom(null); setOver(null);
  };

  const n = tracks.length;
  const overscan = 8;
  const vStart = Math.max(0, Math.floor(scroll / ROW) - overscan);
  const vEnd = Math.min(n, Math.ceil((scroll + vh) / ROW) + overscan);
  const rows: JSX.Element[] = [];
  for (let i = vStart; i < vEnd; i++) {
    const t = tracks[i];
    rows.push(
      <div key={`${t.id}:${i}`} className={`wp-pl-row ${from === i ? "wp-pl-dragging" : ""}`}
        style={{ position: "absolute", top: i * ROW, left: 0, right: 0, height: ROW }}>
        <button className="wp-pl-main" onClick={() => usePlayer.getState().playFrom(tracks, i)}>
          <Cover path={t.path} size={42} />
          <div className="wp-row-text"><div className="md-body-l ellipsis">{t.title}</div><div className="md-body-s wp-muted ellipsis">{t.artist} · {t.album}</div></div>
        </button>
        <button className="md-icon-btn wp-icon-sm" title="Remove" onClick={() => usePlaylists.getState().removeTrack(plId, t.id)}><Icon name="close" size={18} /></button>
        <button className="md-icon-btn wp-pl-handle" title="Drag to reorder" aria-label="Drag to reorder"
          onPointerDown={(e) => start(i, e)} onPointerMove={move} onPointerUp={end} onPointerCancel={end}>
          <Icon name="drag" size={20} />
        </button>
      </div>,
    );
  }

  return (
    <div ref={scrollRef} className="wp-pl-reorder" onScroll={onScroll}>
      <div style={{ height: n * ROW, position: "relative" }}>
        {rows}
        {/* single drop indicator at the insertion point (absolute, so it shows even if that row isn't mounted) */}
        {from !== null && over !== null && over !== from && over !== from + 1 && (
          <div className="wp-pl-drop" style={{ top: over * ROW - 1 }} />
        )}
      </div>
    </div>
  );
}
