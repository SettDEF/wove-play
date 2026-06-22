import { useEffect, useRef } from "react";
import { engine } from "@/audio/engine";
import { scratchMove, scratchEnd } from "@/audio/scratch";
import { usePlayer } from "@/store/player";
import { buzz } from "@/lib/touch";
import { Icon } from "./Icons";

/** Seconds of audio a FULL hand-turn of the record scrubs (lower = touchier scratch). */
const SECS_PER_REV = 6;

/**
 * A spinning vinyl record cover: the album art sits on the label and the disc rotates at ~33⅓ rpm while
 * playing. Grab it and "scratch" — the disc follows your finger, the playhead scrubs with the rotation,
 * and the velocity-driven scratch SFX (audio/scratch.ts) pitch-bends with how fast you move. Rotation is
 * driven in JS (rAF) so manual scratching and auto-spin share one angle with no CSS-animation fight.
 */
export function VinylCover({ art, playing }: { art: string | null; playing: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const angle = useRef(0);          // current visual rotation (deg)
  const raf = useRef(0);
  const last = useRef(0);
  const scratch = useRef<null | { cx: number; cy: number; prev: number; total: number; grabTime: number }>(null);

  // One rAF loop: auto-advance the angle at 33⅓ rpm while playing, unless a scratch owns it.
  useEffect(() => {
    const tick = (t: number) => {
      // Backgrounded? The keepAlive trick resumes WebView timers for audio, so this rAF keeps firing —
      // skip the work (compositor write) and reset dt so the angle doesn't lurch on return. [perf/heat]
      if (document.hidden) { last.current = 0; raf.current = requestAnimationFrame(tick); return; }
      const el = ref.current;
      if (el) {
        const dt = last.current ? t - last.current : 0;
        last.current = t;
        if (playing && !scratch.current) angle.current = (angle.current + dt * 0.2) % 360; // ~0.2°/ms ≈ 33⅓ rpm
        el.style.transform = `rotate(${angle.current}deg)`;
      }
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [playing]);

  const angleOf = (x: number, y: number, cx: number, cy: number) => (Math.atan2(y - cy, x - cx) * 180) / Math.PI;

  const onDown = (e: React.PointerEvent) => {
    const el = ref.current; if (!el) return;
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    el.setPointerCapture?.(e.pointerId);
    scratch.current = { cx, cy, prev: angleOf(e.clientX, e.clientY, cx, cy), total: 0, grabTime: engine.currentTime };
    buzz(8);
  };
  const onMove = (e: React.PointerEvent) => {
    const s = scratch.current; if (!s) return;
    const a = angleOf(e.clientX, e.clientY, s.cx, s.cy);
    let step = a - s.prev;
    while (step > 180) step -= 360;     // unwrap so crossing the ±180 seam doesn't jump
    while (step < -180) step += 360;
    s.prev = a;
    s.total += step;
    angle.current = (angle.current + step + 360) % 360;                 // disc follows the finger
    const target = Math.max(0, Math.min(engine.duration || s.grabTime, s.grabTime + (s.total / 360) * SECS_PER_REV));
    engine.seek(target);
    usePlayer.setState({ position: target });                          // keep the seekbar in sync while scratching
    scratchMove(e.clientX, e.timeStamp);                               // velocity → pitch-bent scratch SFX
  };
  const onUp = (e: React.PointerEvent) => {
    if (!scratch.current) return;
    scratch.current = null;
    ref.current?.releasePointerCapture?.(e.pointerId);
    scratchEnd();
  };

  return (
    <div
      className="wp-vinyl-wrap"
      onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
      // Swallow touch + click so the player's swipe-to-skip / pull-to-dismiss / reveal don't fire while
      // you're scratching the record (pointer events above still drive the scratch).
      onTouchStart={(e) => e.stopPropagation()} onTouchMove={(e) => e.stopPropagation()} onTouchEnd={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <div ref={ref} className="wp-vinyl">
        <div className="wp-vinyl-grooves" />
        <div className="wp-vinyl-label">
          {art ? <img src={art} alt="" draggable={false} /> : <Icon name="music" size={42} color="var(--md-on-surface-variant)" />}
        </div>
        <div className="wp-vinyl-hole" />
      </div>
      <div className="wp-vinyl-sheen" />
    </div>
  );
}
