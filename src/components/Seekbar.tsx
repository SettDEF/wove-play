import { useRef } from "react";

/** A draggable M3 slider (used for the seek bar and volume). value/min/max in absolute units. */
export function Seekbar({ value, min = 0, max = 1, onChange, onCommit, height = 4 }: {
  value: number; min?: number; max?: number;
  onChange: (v: number) => void; onCommit?: (v: number) => void; height?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const span = max - min || 1;
  const pct = Math.max(0, Math.min(1, (value - min) / span));

  const posToVal = (clientX: number) => {
    const el = ref.current; if (!el) return value;
    const r = el.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    return min + f * span;
  };
  const onDown = (e: React.PointerEvent) => {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
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

  return (
    <div ref={ref} className="wp-slider" style={{ height: Math.max(height, 16) }} onPointerDown={onDown}>
      <div className="wp-slider-track" style={{ height }}>
        <div className="wp-slider-fill" style={{ width: `${pct * 100}%` }} />
      </div>
      <div className="wp-slider-thumb" style={{ left: `${pct * 100}%` }} />
    </div>
  );
}
