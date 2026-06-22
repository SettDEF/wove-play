import { useEffect, useRef, useState } from "react";

/** Android-12-style "squiggly" progress: the PLAYED part is an animated sine wave that flows while
 *  playing (and eases flat when paused); the rest is a flat line, with a thumb at the playhead. Drag to
 *  seek. The wave is drawn imperatively in a rAF (no per-frame React render). */
export function SquiggleSeek({ value, max = 1, onChange, onCommit, playing = true, amp = 4, speed = 1, height = 40 }: {
  value: number; max?: number;
  onChange: (v: number) => void; onCommit?: (v: number) => void;
  playing?: boolean; amp?: number; speed?: number; height?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const playedRef = useRef<SVGPathElement>(null);
  const restRef = useRef<SVGPathElement>(null);
  const thumbRef = useRef<SVGCircleElement>(null);
  const [w, setW] = useState(320);
  const span = max || 1;

  // live values read by the rAF loop (so it never restarts on a position tick)
  const pctRef = useRef(0); pctRef.current = Math.max(0, Math.min(1, value / span));
  const playingRef = useRef(playing); playingRef.current = playing;
  const ampRef = useRef(amp); ampRef.current = amp;
  const speedRef = useRef(speed); speedRef.current = speed;

  useEffect(() => {
    const el = ref.current; if (!el) return;
    const measure = () => setW(Math.max(40, el.clientWidth || 320));
    measure();
    const ro = new ResizeObserver(measure); ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    let raf = 0, last = 0, phase = 0, curAmp = 0;
    const mid = height / 2, wl = 26, step = 3;
    const tick = (t: number) => {
      const dt = last ? Math.min(0.05, (t - last) / 1000) : 0; last = t;
      const target = playingRef.current ? ampRef.current : 0;     // flatten when paused
      curAmp += (target - curAmp) * Math.min(1, dt * 6);
      if (playingRef.current) phase += dt * speedRef.current * 5;
      const px = pctRef.current * w;
      let d = `M 0 ${mid}`;
      for (let x = step; x <= px; x += step) {
        const y = mid + curAmp * Math.sin((x / wl) * Math.PI * 2 - phase);
        d += ` L ${x.toFixed(1)} ${y.toFixed(2)}`;
      }
      playedRef.current?.setAttribute("d", d);
      restRef.current?.setAttribute("d", `M ${px.toFixed(1)} ${mid} L ${w} ${mid}`);
      thumbRef.current?.setAttribute("cx", px.toFixed(1));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [w, height]);

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

  return (
    <div ref={ref} className="wp-squig" style={{ height }} onPointerDown={onDown}>
      <svg width={w} height={height} viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none">
        <path ref={restRef} className="wp-squig-rest" fill="none" />
        <path ref={playedRef} className="wp-squig-played" fill="none" />
        <circle ref={thumbRef} cy={height / 2} r={6} className="wp-squig-thumb" />
      </svg>
    </div>
  );
}
