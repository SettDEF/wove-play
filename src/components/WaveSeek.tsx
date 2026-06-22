import { useMemo, useRef, useState, useEffect } from "react";

/** Deterministic pseudo-waveform: stable per-track bar heights from a hashed seed (the track id).
 *  `count` bars are generated to FIT the current width — so on resize we re-bucket into new sectors
 *  instead of stretching a fixed set. A real precomputed waveform can replace this later. */
function waveBars(seed: string, count: number): number[] {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    h ^= h << 13; h ^= h >>> 17; h ^= h << 5; h >>>= 0;
    const r = (h % 1000) / 1000;                          // 0..1 noise
    const env = 0.5 + 0.5 * Math.sin((i / count) * Math.PI); // song-like envelope (quiet ends)
    out.push(0.16 + 0.84 * r * env);
  }
  return out;
}

/** Poweramp-style waveform scrubber: played bars tinted, the rest muted; click/drag to seek. The bar
 *  COUNT tracks the element's width (re-sectored on resize) so it never looks stretched on a wide window. */
export function WaveSeek({ value, max = 1, seed, onChange, onCommit, height = 48 }: {
  value: number; max?: number; seed: string;
  onChange: (v: number) => void; onCommit?: (v: number) => void; height?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [count, setCount] = useState(72);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    // ~5px per bar+gap → re-bucket to fit the current width (clamped to a sane range).
    const measure = () => setCount(Math.max(24, Math.min(480, Math.round((el.clientWidth || 320) / 5))));
    measure();
    const ro = new ResizeObserver(measure); ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const bars = useMemo(() => waveBars(seed, count), [seed, count]);
  const span = max || 1;
  const pct = Math.max(0, Math.min(1, value / span));

  const posToVal = (clientX: number) => {
    const el = ref.current; if (!el) return value;
    const r = el.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * span;
  };
  const onDown = (e: React.PointerEvent) => {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    onChange(posToVal(e.clientX));
    const move = (ev: PointerEvent) => onChange(posToVal(ev.clientX));
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      onCommit?.(posToVal(ev.clientX));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // Two stacked bar layers: a dim full set + a coloured set clipped to the played fraction. The clip
  // transitions smoothly, so the stripes gain colour gradually as the song plays (not a jumpy per-bar edge).
  const barSpans = bars.map((hgt, i) => <span key={i} className="wp-wave-bar" style={{ height: `${Math.round(hgt * 100)}%` }} />);
  return (
    <div ref={ref} className="wp-wave" style={{ height }} onPointerDown={onDown}>
      <div className="wp-wave-layer wp-wave-dim">{barSpans}</div>
      <div className="wp-wave-layer wp-wave-lit" style={{ clipPath: `inset(0 ${(1 - pct) * 100}% 0 0)` }}>{barSpans}</div>
    </div>
  );
}
