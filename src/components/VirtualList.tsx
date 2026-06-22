import { useEffect, useRef, useState } from "react";

/**
 * Windowed list/grid — only the visible rows (+ a small overscan) are mounted,
 * so it stays smooth with 40k+ items. `cols=1` is a plain list.
 */
export function VirtualGrid({ count, cols, rowH, render, className, revealIndex, revealKey, indicator, sections }: {
  count: number; cols: number; rowH: number; render: (i: number) => React.ReactNode; className?: string;
  /** Scroll item `revealIndex` into view (centered) whenever `revealKey` changes. */
  revealIndex?: number; revealKey?: number;
  /** Dynamic fast-scroll bubble: given an item index, the label to show (e.g. its A–Z / year / ★ key).
   *  Pass null/undefined for none (default — existing call-sites are unchanged). */
  indicator?: ((itemIndex: number) => string) | null;
  /** A–Z index rail: ordered section labels + the item index each starts at. Tap/drag → jump there. */
  sections?: { label: string; index: number }[] | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState(0);
  const [vh, setVh] = useState(600);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    const ro = new ResizeObserver(() => setVh(el.clientHeight)); ro.observe(el); setVh(el.clientHeight);
    return () => ro.disconnect();
  }, []);
  // Scroll handling: a raw `onScroll`→setState fires a full window re-render on EVERY scroll event
  // (dozens per frame on a trackpad/touch fling) — the source of list/queue jank. Coalesce to one
  // update per frame via rAF, and only re-render when the first visible row actually changes
  // (i.e. we crossed a row boundary); pixel offsets are absolute, so sub-row scrolls need no render.
  const rafRef = useRef(0);
  const lastStartRef = useRef(-1);
  const lastTopRef = useRef(0);
  const dirRef = useRef(1); // +1 = scrolling down, -1 = up — bias the overscan this way
  const onScroll = () => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      const el = ref.current; if (!el) return;
      const top = el.scrollTop;
      if (top !== lastTopRef.current) dirRef.current = top > lastTopRef.current ? 1 : -1;
      lastTopRef.current = top;
      const sr = Math.floor(top / rowH);
      if (sr !== lastStartRef.current) { lastStartRef.current = sr; setScroll(top); }
    });
  };
  useEffect(() => () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); }, []);
  useEffect(() => {
    if (revealKey == null || revealIndex == null || revealIndex < 0) return;
    const el = ref.current; if (!el) return;
    const top = Math.max(0, Math.floor(revealIndex / cols) * rowH - el.clientHeight / 2 + rowH / 2);
    el.scrollTo({ top, behavior: "smooth" }); setScroll(top); lastStartRef.current = Math.floor(top / rowH);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealKey]);
  const rowCount = Math.ceil(count / cols);
  // Directional overscan: pre-mount a BIG lead (~2 screens) in the direction you're scrolling and a small
  // trail behind. So rows — and their covers, which start fetching the moment a row mounts — are READY
  // before they reach the viewport (no blank rows popping in on a fling), without paying to keep many
  // off-screen rows in the other direction. Scales with how many rows fit the viewport. [perf — scroll]
  const vp = Math.max(4, Math.ceil(vh / rowH));                 // rows per viewport
  const lead = Math.min(60, vp * 2);                            // ~2 screens ahead in the travel direction
  const trail = Math.min(14, Math.max(3, Math.ceil(vp / 2)));
  const down = dirRef.current >= 0;
  const startRow = Math.max(0, Math.floor(scroll / rowH) - (down ? trail : lead));
  const endRow = Math.min(rowCount, Math.ceil((scroll + vh) / rowH) + (down ? lead : trail));
  const out: React.ReactNode[] = [];
  for (let r = startRow; r < endRow; r++) {
    if (cols === 1) {
      out.push(<div key={r} style={{ position: "absolute", top: r * rowH, left: 0, right: 0, height: rowH }}>{render(r)}</div>);
      continue;
    }
    const cells: React.ReactNode[] = [];
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (i >= count) break;
      cells.push(<div key={i} className="wp-vg-cell" style={{ width: `${100 / cols}%` }}>{render(i)}</div>);
    }
    out.push(<div key={r} className="wp-vg-row" style={{ position: "absolute", top: r * rowH, left: 0, right: 0, height: rowH, display: "flex" }}>{cells}</div>);
  }
  const hasRail = !!(sections && sections.length >= 2);
  const overlay = !!indicator || hasRail;
  // Reserve room on the right for the rail/thumb so row content (track times/numbers) clears it — the
  // A–Z rail is wider + needs a real gap from the labels; the thin bubble thumb needs less.
  const padR = hasRail ? 38 : indicator ? 22 : undefined;
  const scrollEl = (
    <div ref={ref} className={className ?? "wp-vlist"} onScroll={onScroll}>
      <div style={{ height: rowCount * rowH, position: "relative", paddingRight: padR }}>{out}</div>
    </div>
  );
  // No overlay → return the plain scroller (byte-identical to before). With a bubble or A–Z rail, wrap
  // it so the (non-scrolling) overlay can float over the right edge.
  if (!overlay) return scrollEl;
  return (
    <div className="wp-vscroll-wrap">
      {scrollEl}
      {hasRail
        ? <IndexRail sections={sections!} scrollRef={ref} rowH={rowH} cols={cols} />
        : <FastScroll scrollRef={ref} scroll={scroll} rowH={rowH} cols={cols} count={count} label={indicator!} />}
    </div>
  );
}

/** A–Z (or year/★/…) index rail: tap or drag the strip to jump to that section. Condensed to fit the
 *  height so it never overflows. */
function IndexRail({ sections, scrollRef, rowH, cols }: {
  sections: { label: string; index: number }[]; scrollRef: React.RefObject<HTMLDivElement | null>; rowH: number; cols: number;
}) {
  const [active, setActive] = useState<number | null>(null);
  const MAX = 30;
  const list = sections.length <= MAX
    ? sections
    : Array.from({ length: MAX }, (_, i) => sections[Math.round((i * (sections.length - 1)) / (MAX - 1))]);

  const pick = (clientY: number, railEl: HTMLElement) => {
    const r = railEl.getBoundingClientRect();
    const j = Math.max(0, Math.min(list.length - 1, Math.floor(((clientY - r.top) / Math.max(1, r.height)) * list.length)));
    setActive(j);
    const node = scrollRef.current;
    if (node) node.scrollTop = Math.floor(list[j].index / cols) * rowH;
  };
  return (
    <div
      className={`wp-azrail ${active != null ? "wp-azrail-drag" : ""}`}
      onPointerDown={(e) => { (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId); pick(e.clientY, e.currentTarget); }}
      onPointerMove={(e) => { if (active != null) pick(e.clientY, e.currentTarget); }}
      onPointerUp={(e) => { setActive(null); (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId); }}
      onPointerCancel={() => setActive(null)}
    >
      {list.map((s, j) => <span key={j} className={`wp-az-letter ${active === j ? "wp-az-on" : ""}`}>{s.label}</span>)}
      {active != null && <div className="wp-az-bubble">{list[active].label}</div>}
    </div>
  );
}

const THUMB_H = 46;
/** Draggable right-edge thumb + a floating bubble that labels where you are (via `label`). Appears on
 *  scroll, drag jumps the list. Reads the live scroll element so the drag math needs no layout state. */
function FastScroll({ scrollRef, scroll, rowH, cols, count, label }: {
  scrollRef: React.RefObject<HTMLDivElement | null>; scroll: number; rowH: number; cols: number; count: number;
  label: (i: number) => string;
}) {
  const [drag, setDrag] = useState(false);
  const [show, setShow] = useState(false);
  const hideRef = useRef(0);
  useEffect(() => {
    setShow(true);
    if (hideRef.current) clearTimeout(hideRef.current);
    hideRef.current = window.setTimeout(() => setShow(false), 1500);
    return () => { if (hideRef.current) clearTimeout(hideRef.current); };
  }, [scroll]);

  const rowCount = Math.max(1, Math.ceil(count / cols));
  const el = scrollRef.current;
  const view = el?.clientHeight ?? 0;
  const maxScroll = Math.max(1, rowCount * rowH - view);
  const frac = Math.max(0, Math.min(1, scroll / maxScroll));
  const thumbY = frac * Math.max(0, view - THUMB_H);
  const idx = Math.min(count - 1, Math.round(frac * (rowCount - 1)) * cols);

  const jump = (clientY: number) => {
    const node = scrollRef.current; if (!node) return;
    const r = node.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (clientY - r.top) / Math.max(1, r.height)));
    node.scrollTop = f * Math.max(1, rowCount * rowH - r.height);
  };
  if (rowCount < 12) return null; // not worth it for short lists
  return (
    <div className={`wp-fastscroll ${show || drag ? "wp-fastscroll-show" : ""} ${drag ? "wp-fastscroll-drag" : ""}`}>
      {drag && <div className="wp-fs-bubble" style={{ transform: `translateY(${thumbY}px)` }}>{label(idx)}</div>}
      <button
        className="wp-fs-thumb" style={{ transform: `translateY(${thumbY}px)` }}
        aria-label="Fast scroll"
        onPointerDown={(e) => { setDrag(true); (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId); jump(e.clientY); }}
        onPointerMove={(e) => { if (drag) jump(e.clientY); }}
        onPointerUp={(e) => { setDrag(false); (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId); }}
        onPointerCancel={() => setDrag(false)}
      />
    </div>
  );
}

/** Plain windowed list (cols=1). */
export function VirtualList({ count, rowH, render, className, revealIndex, revealKey }: {
  count: number; rowH: number; render: (i: number) => React.ReactNode; className?: string;
  revealIndex?: number; revealKey?: number;
}) {
  return <VirtualGrid count={count} cols={1} rowH={rowH} render={render} className={className} revealIndex={revealIndex} revealKey={revealKey} />;
}
