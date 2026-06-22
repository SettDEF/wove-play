import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useBackGuard } from "@/lib/backStack";
import { engine } from "@/audio/engine";

export interface BloomItem {
  id: string;
  label: string;
  icon: ReactNode;
  action: () => void;
}

interface Props {
  anchor: DOMRect;
  /** Pointer position when the bloom opened — present ⇒ we're mid press-and-hold
   *  (one-gesture slide-select). null ⇒ opened without a held finger (tap mode). */
  startPoint: { x: number; y: number } | null;
  items: BloomItem[];
  onClose: () => void;
}

const REDUCED =
  typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

const R = 102; // arc radius (px)
const SPREAD = 118; // arc spread (deg)
const PILL = 60; // blob diameter / hit-target
// solid theme colours cycled across the blobs (vivid, on-theme, like organic candy shapes).
const BLOB_COLORS = [
  "var(--md-primary)",
  "var(--md-tertiary)",
  "var(--md-secondary)",
  "color-mix(in srgb, var(--md-primary) 55%, var(--md-tertiary))",
  "color-mix(in srgb, var(--md-tertiary) 65%, white)",
];
// organic amoeba radii (8-value border-radius) so each blob is a distinct soft shape.
const BLOB_SHAPES = [
  "58% 42% 52% 48% / 50% 56% 44% 50%",
  "45% 55% 50% 50% / 56% 44% 56% 44%",
  "52% 48% 60% 40% / 44% 52% 48% 56%",
  "48% 52% 44% 56% / 54% 46% 56% 44%",
  "56% 44% 50% 50% / 44% 56% 46% 54%",
];

/** A fan of blob centres growing OUT of the held bottom-nav tab. The fan is anchored at the
 *  tab and AIMED up + toward the screen centre, so an edge tab opens its blobs inward (always
 *  on-screen, evenly spaced, still clearly attached to the tab you pressed — not floated away). */
function layout(anchor: DOMRect, n: number) {
  const vw = window.innerWidth;
  const m = PILL / 2 + 8;
  const cx = anchor.left + anchor.width / 2;
  const cy = anchor.top + anchor.height / 2; // blobs grow FROM the button centre
  // centre direction: up and toward the middle of the screen. Centre tab → straight up;
  // left tab → up-right; right tab → up-left. Always points INTO the screen.
  const centerAng = Math.atan2((cy - R - 24) - cy, vw / 2 - cx); // radians, naturally ≈ -90° at centre
  const spread = SPREAD * (Math.PI / 180);
  return Array.from({ length: n }, (_, i) => {
    const t = n === 1 ? 0.5 : i / (n - 1);
    const ang = centerAng + (t - 0.5) * spread;
    const x = Math.max(m, Math.min(vw - m, cx + R * Math.cos(ang)));
    const y = Math.max(m, Math.min(cy, cy + R * Math.sin(ang))); // never below the tab
    return { x, y, cx, cy };
  });
}

export function NavBloom({ anchor, startPoint, items, onClose }: Props) {
  const pos = layout(anchor, items.length);
  const cx = pos[0]?.cx ?? anchor.left + anchor.width / 2;
  const cy = pos[0]?.cy ?? anchor.top + anchor.height / 2;
  const pillRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [active, setActive] = useState(-1);
  const tracking = useRef(startPoint != null);

  useBackGuard(true, onClose);

  // entrance spring (staggered): each glass pill springs out of the held button's centre with a
  // bouncy overshoot, then settles — clean and satisfying, no muddy goo.
  useLayoutEffect(() => {
    pillRefs.current.forEach((el, i) => {
      if (!el) return;
      if (REDUCED) { el.style.opacity = "1"; return; }
      const dx = cx - pos[i].x;
      const dy = cy - pos[i].y;
      el.animate(
        [
          { transform: `translate(${dx}px, ${dy}px) scale(0.2)`, opacity: 0, offset: 0 },
          { transform: "translate(0,0) scale(1.18)", opacity: 1, offset: 0.6 },
          { transform: "translate(0,0) scale(0.95)", opacity: 1, offset: 0.82 },
          { transform: "translate(0,0) scale(1)", opacity: 1, offset: 1 },
        ],
        { duration: 360, delay: i * 28, easing: "cubic-bezier(0.22, 0.7, 0.3, 1)", fill: "both" },
      ).onfinish = () => { el.style.opacity = "1"; el.style.transform = ""; };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // one-finger slide-select (pointer bubbles from the originating tab via implicit
  // touch capture → window). elementFromPoint hits the crisp icon layer on top.
  useEffect(() => {
    if (!tracking.current) return;
    const pillAt = (x: number, y: number) => {
      const el = document.elementFromPoint(x, y)?.closest("[data-bloom-idx]") as HTMLElement | null;
      return el ? Number(el.dataset.bloomIdx) : -1;
    };
    const onMove = (e: PointerEvent) => setActive(pillAt(e.clientX, e.clientY));
    const onUp = (e: PointerEvent) => {
      const idx = pillAt(e.clientX, e.clientY);
      const moved = startPoint ? Math.hypot(e.clientX - startPoint.x, e.clientY - startPoint.y) : 999;
      tracking.current = false;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      if (idx >= 0) { navigator.vibrate?.(12); items[idx].action(); onClose(); }
      else if (moved < 14) setActive(-1); // lifted in place → tap mode
      else onClose();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // capped "music-alive" glow off the analyser (skipped under reduced motion).
  useEffect(() => {
    if (REDUCED) return;
    let raf = 0;
    const an = engine.analyser;
    const buf = an ? new Uint8Array(an.frequencyBinCount) : null;
    const tick = () => {
      if (an && buf && rootRef.current && !document.hidden) {
        an.getByteFrequencyData(buf);
        let s = 0;
        const n = Math.min(48, buf.length);
        for (let i = 0; i < n; i++) s += buf[i];
        rootRef.current.style.setProperty("--bloom-level", String(s / n / 255));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const cls = (i: number) =>
    active === i ? "active" : active >= 0 && Math.abs(active - i) === 1 ? "near" : "";
  const activeLabel = active >= 0 ? items[active] : null;

  return createPortal(
    <div className="wp-bloom" ref={rootRef}>
      <div className="wp-bloom-scrim" onPointerDown={() => onClose()} />

      {/* solid organic theme-coloured blobs — symmetric fan, springy, legible. No goo. */}
      <div className="wp-bloom-icons">
        {items.map((it, i) => (
          <button
            key={it.id}
            data-bloom-idx={i}
            ref={(el) => (pillRefs.current[i] = el)}
            className={`wp-bloom-pill ${cls(i)}`}
            style={{
              left: pos[i].x - PILL / 2, top: pos[i].y - PILL / 2,
              width: PILL, height: PILL,
              background: BLOB_COLORS[i % BLOB_COLORS.length],
              borderRadius: BLOB_SHAPES[i % BLOB_SHAPES.length],
            }}
            title={it.label}
            aria-label={it.label}
            onClick={() => { navigator.vibrate?.(12); it.action(); onClose(); }}
          >
            {it.icon}
          </button>
        ))}
        {activeLabel && (
          <div
            className="wp-bloom-label"
            style={{ left: pos[active].x, top: pos[active].y - PILL / 2 - 30 }}
          >
            {activeLabel.label}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
