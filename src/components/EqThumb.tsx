import { useMemo } from "react";
import { EQ_FREQS } from "@/store/player";

const FMIN = 20, FMAX = 20000, DB_RANGE = 15;

/** Approx peaking response in log-freq space (same visual model as EqCurve, simplified). */
function curveDb(lf: number, gains: number[], freqs: number[], qs: number[], preamp: number): number {
  let db = preamp;
  for (let i = 0; i < gains.length; i++) {
    if (!gains[i]) continue;
    const lfi = Math.log10(freqs[i] || 1000);
    const sigma = 0.34 / (Math.max(0.25, qs[i] || 1.1) + 0.4);
    const d = (lf - lfi) / sigma;
    db += gains[i] * Math.exp(-0.5 * d * d);
  }
  return db;
}

/** A tiny, read-only EQ curve thumbnail (inline SVG → cheap, scales, no canvas per row). Used in the
 *  preset browser list so each preset is recognisable at a glance, like Poweramp's preset curves. */
export function EqThumb({ gains, freqs = EQ_FREQS, qs, preamp = 0, w = 72, h = 34, color = "var(--md-primary)" }: {
  gains: number[]; freqs?: number[]; qs?: number[]; preamp?: number; w?: number; h?: number; color?: string;
}) {
  const { line, area } = useMemo(() => {
    const q = qs ?? new Array(gains.length).fill(1.1);
    const N = 40, lmin = Math.log10(FMIN), lmax = Math.log10(FMAX);
    const pts: [number, number][] = [];
    for (let i = 0; i <= N; i++) {
      const x = (i / N) * w;
      const lf = lmin + (i / N) * (lmax - lmin);
      const db = Math.max(-DB_RANGE, Math.min(DB_RANGE, curveDb(lf, gains, freqs, q, preamp)));
      const y = h / 2 - (db / DB_RANGE) * (h / 2 - 2);
      pts.push([x, y]);
    }
    const ln = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
    return { line: ln, area: `${ln} L${w} ${h} L0 ${h} Z` };
  }, [gains, freqs, qs, preamp, w, h]);
  return (
    <svg className="wp-eqthumb" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden>
      <line x1={0} y1={h / 2} x2={w} y2={h / 2} stroke="currentColor" strokeOpacity={0.18} strokeWidth={1} />
      <path d={area} fill={color} fillOpacity={0.16} />
      <path d={line} fill="none" stroke={color} strokeWidth={1.8} strokeLinejoin="round" />
    </svg>
  );
}
