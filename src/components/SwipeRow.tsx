import { useRef, useState, type ReactNode } from "react";
import { Icon } from "./Icons";
import { buzz } from "@/lib/touch";

export interface SwipeAct {
  icon: string;
  label: string;
  /** CSS color for the revealed action panel background. */
  color: string;
  on: () => void;
}

const THRESH = 82;   // px past which a release fires the action
const MAX = 130;     // clamp the drag so it never slides fully off
const ARM_MS = 220;  // press-and-hold before the row swipe arms (so a quick swipe switches tabs)

/**
 * WhatsApp-style row: PRESS-AND-HOLD briefly, then drag left/right to reveal an action behind the row.
 * The hold gate means a plain horizontal swipe is NOT captured here — it passes through to the library
 * tab-switcher. A live arrow rotates as you pull, the label slides in past the threshold, release fires
 * it then it snaps back. Vertical scrolls pass straight through.
 */
export function SwipeRow({ left, right, children }: { left?: SwipeAct; right?: SwipeAct; children: ReactNode }) {
  const [dx, setDx] = useState(0);
  const [past, setPast] = useState(false);
  const [armed, setArmed] = useState(false); // hold completed → the row owns the gesture
  const [animating, setAnimating] = useState(false);
  const start = useRef<{ x: number; y: number } | null>(null);
  const armedRef = useRef(false);
  const armTimer = useRef<number | null>(null);

  const disarm = () => { if (armTimer.current) { clearTimeout(armTimer.current); armTimer.current = null; } };
  const onTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0];
    start.current = { x: t.clientX, y: t.clientY };
    armedRef.current = false; setArmed(false); setPast(false); setAnimating(false);
    disarm();
    armTimer.current = window.setTimeout(() => { armTimer.current = null; armedRef.current = true; setArmed(true); buzz(9); }, ARM_MS);
  };
  const onTouchMove = (e: React.TouchEvent) => {
    if (!start.current) return;
    const t = e.touches[0];
    const ddx = t.clientX - start.current.x, ddy = t.clientY - start.current.y;
    if (!armedRef.current) {
      // moved before the hold completed → it's a scroll or a tab-swipe, NOT a row action.
      if (Math.abs(ddx) > 8 || Math.abs(ddy) > 8) { disarm(); start.current = null; }
      return; // let it bubble to the tab-switcher / scroller
    }
    e.stopPropagation(); // armed → this gesture is ours, don't also switch tabs
    let v = ddx;
    if (v > 0 && !left) v = 0;
    if (v < 0 && !right) v = 0;
    if (Math.abs(v) > THRESH) v = (v > 0 ? 1 : -1) * (THRESH + (Math.abs(v) - THRESH) * 0.4); // rubber-band
    v = Math.max(-MAX, Math.min(MAX, v));
    setDx(v);
    const p = Math.abs(v) >= THRESH;
    setPast((was) => { if (p && !was) buzz(11); return p; });
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    disarm();
    if (armedRef.current) {
      e.stopPropagation();
      if (past) (dx > 0 ? left : right)?.on();
    }
    start.current = null; armedRef.current = false; setArmed(false); setPast(false);
    setAnimating(true); setDx(0);
  };

  const prog = Math.min(1, Math.abs(dx) / THRESH);
  const act = dx > 0 ? left : dx < 0 ? right : undefined;
  const rightSide = dx < 0;

  return (
    <div className="wp-swipe">
      {act && (
        <div className={`wp-swipe-act ${rightSide ? "wp-swipe-right" : "wp-swipe-left"}`}
          style={{ width: Math.abs(dx), background: act.color, opacity: Math.min(1, 0.82 + prog * 0.18) }}>
          <div className="wp-swipe-content" style={{ transform: `scale(${past ? 1.06 : 0.86 + prog * 0.14})` }}>
            <span className="wp-swipe-arrow" style={{ transform: `rotate(${(rightSide ? -1 : 1) * prog * 180}deg)` }}>
              <Icon name={rightSide ? "prev" : "next"} size={20} />
            </span>
            <span className="wp-swipe-ico"><Icon name={act.icon} size={21} /></span>
            <span className={`wp-swipe-label ${past ? "on" : ""}`}>{act.label}</span>
          </div>
        </div>
      )}
      <div
        className={`wp-swipe-body ${armed ? "wp-swipe-armed" : ""}`}
        style={{ transform: dx ? `translateX(${dx}px)` : undefined, transition: animating ? "transform .26s cubic-bezier(.2,.9,.2,1)" : "none" }}
        onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd} onTouchCancel={onTouchEnd}
      >
        {children}
      </div>
    </div>
  );
}
