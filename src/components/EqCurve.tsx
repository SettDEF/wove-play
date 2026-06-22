import { useEffect, useRef } from "react";

const FMIN = 20, FMAX = 20000;
const DB_RANGE = 15; // vertical half-range for the display

/** Approx peaking-filter response in log-freq space (visual, not exact biquad math). */
function curveDb(lf: number, bands: number[], freqs: number[], qs: number[], preamp: number): number {
  let db = preamp;
  for (let i = 0; i < bands.length; i++) {
    if (!bands[i]) continue;
    const lfi = Math.log10(freqs[i] || 1000);
    const sigma = 0.34 / (Math.max(0.25, qs[i] || 1.1) + 0.4); // higher Q → narrower bell
    const d = (lf - lfi) / sigma;
    db += bands[i] * Math.exp(-0.5 * d * d);
  }
  return db;
}

/**
 * Live EQ response curve. Draws the combined band response as a filled, colored curve with band
 * handles. Tap a band handle (or the curve near it) to select it. Colour is fully customisable.
 */
export function EqCurve({ bands, freqs, qs, preamp, enabled, color, selected, onPick, onDrag, gMin = -12, gMax = 12 }: {
  bands: number[]; freqs: number[]; qs: number[]; preamp: number; enabled: boolean;
  color: string; selected?: number; onPick?: (i: number) => void;
  /** Direct manipulation: drag a band node — `gain` from vertical, `freq` from horizontal. */
  onDrag?: (i: number, gain: number, freq: number) => void;
  gMin?: number; gMax?: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const dims = useRef({ w: 300, h: 150 });
  const drag = useRef<{ i: number; moved: boolean } | null>(null);

  // observe size once (mount); redraw on data change via the effect below
  useEffect(() => {
    const el = box.current; if (!el) return;
    const ro = new ResizeObserver(() => draw());
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // redraw only when the EQ data / colour actually changes (not on every render)
  useEffect(() => { draw(); },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bands, freqs, qs, preamp, enabled, color, selected]);

  function draw() {
    const cv = ref.current, host = box.current; if (!cv || !host) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = host.clientWidth, h = host.clientHeight || 150;
    dims.current = { w, h };
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    cv.style.width = `${w}px`; cv.style.height = `${h}px`;
    const ctx = cv.getContext("2d"); if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    // Canvas can't parse CSS custom properties ("var(--md-primary)") — resolve to a concrete colour
    // first, or addColorStop()/strokeStyle throw (white-screen crash) or silently fail.
    const col = resolveColor(color);

    const xOf = (f: number) => ((Math.log10(f) - Math.log10(FMIN)) / (Math.log10(FMAX) - Math.log10(FMIN))) * w;
    const midY = h / 2;
    const yOf = (db: number) => midY - (Math.max(-DB_RANGE, Math.min(DB_RANGE, db)) / DB_RANGE) * (h / 2 - 10);

    // grid: vertical lines at decade-ish freqs + the 0 dB centre line
    ctx.strokeStyle = "rgba(255,255,255,0.07)"; ctx.lineWidth = 1;
    for (const f of [100, 1000, 10000]) { ctx.beginPath(); ctx.moveTo(xOf(f), 0); ctx.lineTo(xOf(f), h); ctx.stroke(); }
    ctx.strokeStyle = "rgba(255,255,255,0.13)";
    ctx.beginPath(); ctx.moveTo(0, midY); ctx.lineTo(w, midY); ctx.stroke();

    // the response curve
    const pts: [number, number][] = [];
    const N = Math.max(64, Math.floor(w));
    for (let i = 0; i <= N; i++) {
      const x = (i / N) * w;
      const lf = Math.log10(FMIN) + (i / N) * (Math.log10(FMAX) - Math.log10(FMIN));
      const db = enabled ? curveDb(lf, bands, freqs, qs, preamp) : 0;
      pts.push([x, yOf(db)]);
    }
    ctx.globalAlpha = enabled ? 1 : 0.4;
    // fill under the curve
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, hexA(col, 0.42));
    grad.addColorStop(1, hexA(col, 0.02));
    ctx.beginPath();
    ctx.moveTo(0, h);
    for (const [x, y] of pts) ctx.lineTo(x, y);
    ctx.lineTo(w, h); ctx.closePath();
    ctx.fillStyle = grad; ctx.fill();
    // stroke the curve
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.strokeStyle = col; ctx.lineWidth = 2.5; ctx.lineJoin = "round"; ctx.stroke();

    // band handles
    for (let i = 0; i < bands.length; i++) {
      const x = xOf(freqs[i]); const y = yOf(enabled ? preamp + bands[i] : 0);
      const sel = i === selected;
      ctx.beginPath(); ctx.arc(x, y, sel ? 6 : 4, 0, Math.PI * 2);
      ctx.fillStyle = sel ? col : "rgba(255,255,255,0.85)"; ctx.fill();
      if (sel) { ctx.lineWidth = 2; ctx.strokeStyle = "#fff"; ctx.stroke(); }
    }
    ctx.globalAlpha = 1;
  }

  /** Nearest band to an x within the box. */
  const pick = (x: number, w: number): number => {
    let best = 0, bd = Infinity;
    const xOf = (f: number) => ((Math.log10(f) - Math.log10(FMIN)) / (Math.log10(FMAX) - Math.log10(FMIN))) * w;
    for (let i = 0; i < freqs.length; i++) { const d = Math.abs(xOf(freqs[i]) - x); if (d < bd) { bd = d; best = i; } }
    return best;
  };
  /** Set band `i` to the gain/freq under the cursor (vertical → gain, horizontal → freq). */
  const applyDrag = (clientX: number, clientY: number, i: number) => {
    const host = box.current; if (!host || !onDrag) return;
    const r = host.getBoundingClientRect();
    const w = r.width, h = r.height || 150;
    const y = clientY - r.top, x = clientX - r.left;
    const db = ((h / 2 - y) / (h / 2 - 10)) * DB_RANGE;            // invert yOf()
    const gain = Math.max(gMin, Math.min(gMax, Math.round((db - preamp) * 2) / 2));
    const lf = Math.log10(FMIN) + Math.max(0, Math.min(1, x / w)) * (Math.log10(FMAX) - Math.log10(FMIN));
    let f = Math.round(Math.pow(10, lf));
    const lo = i > 0 ? (freqs[i - 1] || FMIN) * 1.06 : FMIN;       // keep between neighbours (no reordering)
    const hi = i < freqs.length - 1 ? (freqs[i + 1] || FMAX) * 0.94 : FMAX;
    f = Math.max(lo, Math.min(hi, f));
    onDrag(i, gain, f);
  };
  const onPointerDown = (e: React.PointerEvent) => {
    const host = box.current; if (!host) return;
    const r = host.getBoundingClientRect();
    const i = pick(e.clientX - r.left, r.width);
    onPick?.(i);                                                   // a plain tap just selects
    if (!onDrag) return;
    drag.current = { i, moved: false };
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    const move = (ev: PointerEvent) => { const d = drag.current; if (!d) return; d.moved = true; applyDrag(ev.clientX, ev.clientY, d.i); };
    const up = () => { drag.current = null; window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div className="wp-eqcurve" ref={box} onPointerDown={onPointerDown} style={{ touchAction: "none" }}>
      <canvas ref={ref} />
    </div>
  );
}

/** Resolve a CSS custom property reference ("var(--md-primary)") to its concrete value, since canvas
 *  APIs can't parse var(). Non-var colours pass through unchanged. */
function resolveColor(c: string): string {
  const s = c.trim();
  if (!s.startsWith("var(")) return s;
  const m = s.match(/var\(\s*(--[\w-]+)/);
  if (!m) return s;
  const v = getComputedStyle(document.documentElement).getPropertyValue(m[1]).trim();
  return v || "#7ce2b0";
}

/** Apply alpha to a #rgb/#rrggbb or rgb()/named color (best-effort) → rgba string. */
function hexA(c: string, a: number): string {
  const s = c.trim();
  if (s.startsWith("#")) {
    let r = 0, g = 0, b = 0;
    if (s.length === 4) { r = parseInt(s[1] + s[1], 16); g = parseInt(s[2] + s[2], 16); b = parseInt(s[3] + s[3], 16); }
    else if (s.length >= 7) { r = parseInt(s.slice(1, 3), 16); g = parseInt(s.slice(3, 5), 16); b = parseInt(s.slice(5, 7), 16); }
    return `rgba(${r},${g},${b},${a})`;
  }
  const m = s.match(/rg\w*\(([^)]+)\)/);
  if (m) { const [r, g, b] = m[1].split(",").map((n) => parseFloat(n)); return `rgba(${r},${g},${b},${a})`; }
  return s; // fallback: ignore alpha
}
