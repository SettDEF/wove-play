import { useRef } from "react";

/** A themed horizontal slider (rounded thick track + filled portion + big thumb). Pointer-driven,
 *  so it looks/feels identical on desktop + Android (no ugly native range input). */
export function Slider({ value, min, max, step = 1, onChange, accent }: {
  value: number; min: number; max: number; step?: number; onChange: (v: number) => void; accent?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const pct = Math.max(0, Math.min(1, (value - min) / (max - min)));
  const apply = (clientX: number) => {
    const el = ref.current; if (!el) return;
    const r = el.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    const snapped = Math.round((min + f * (max - min)) / step) * step;
    onChange(Math.max(min, Math.min(max, parseFloat(snapped.toFixed(4)))));
  };
  const onDown = (e: React.PointerEvent) => {
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    apply(e.clientX);
    const move = (ev: PointerEvent) => apply(ev.clientX);
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  };
  return (
    <div className="wp-slider" ref={ref} onPointerDown={onDown} style={accent ? ({ "--sl-accent": accent } as React.CSSProperties) : undefined}>
      <div className="wp-slider-track"><div className="wp-slider-fill" style={{ width: `${pct * 100}%` }} /></div>
      <div className="wp-slider-thumb" style={{ left: `${pct * 100}%` }} />
    </div>
  );
}
