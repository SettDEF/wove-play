import { useRef } from "react";

/** Fire a short haptic tick on devices that support it (Android WebView / mobile). */
export function buzz(ms = 12): void {
  try { navigator.vibrate?.(ms); } catch { /* unsupported */ }
}

/**
 * Press-and-hold detector. `onLong` fires after `ms` unless the pointer moves >10px or lifts early.
 * Spread `handlers` onto the target; in its onClick, bail when `fired.current` is true (then reset it)
 * so the release that completed a long-press doesn't also count as a tap.
 */
export function useLongPress(onLong: () => void, ms = 500) {
  const timer = useRef<number | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);
  const cancel = () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } start.current = null; };
  const handlers = {
    onPointerDown: (e: React.PointerEvent) => {
      fired.current = false;
      start.current = { x: e.clientX, y: e.clientY };
      timer.current = window.setTimeout(() => { fired.current = true; buzz(15); cancel(); onLong(); }, ms);
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (start.current && Math.hypot(e.clientX - start.current.x, e.clientY - start.current.y) > 10) cancel();
    },
    onPointerUp: cancel,
    onPointerLeave: cancel,
  };
  return { fired, handlers };
}

/**
 * Swipe-down-to-dismiss for bottom sheets. Returns pointer handlers + a live `style`
 * that translates the sheet as you drag; past the threshold (or a fast flick) it calls onClose.
 */
/** Nearest scrollable ancestor of `node` up to (but not including) `boundary` — or null if none. */
function scrollableUnder(node: HTMLElement | null, boundary: HTMLElement | null): HTMLElement | null {
  let n: HTMLElement | null = node;
  while (n && n !== boundary) {
    const oy = getComputedStyle(n).overflowY;
    if ((oy === "auto" || oy === "scroll") && n.scrollHeight > n.clientHeight + 1) return n;
    n = n.parentElement;
  }
  return null;
}

export function useSwipeDown(onClose: () => void, threshold = 90) {
  const start = useRef<{ y: number; t: number; scroller: HTMLElement | null } | null>(null);
  const dragging = useRef(false); // actively dragging the sheet (vs. letting inner content scroll)?
  const el = useRef<HTMLElement | null>(null);

  const setNode = (node: HTMLElement | null) => { el.current = node; };
  const reset = () => { if (el.current) { el.current.style.transform = ""; el.current.style.transition = ""; } };

  const onPointerDown = (e: React.PointerEvent) => {
    const target = e.target as HTMLElement;
    // From the grip/header → drag immediately. From inner content → ALSO allow dismiss, but wait for a
    // clear downward pull AND only when the content's own scroll area is at the top, so we never hijack a
    // normal scroll-up. Resolve that scroll area now so onPointerMove can check its position.
    const fromHandle = !!target.closest(".wp-sheet-grip, .wp-sheet-head");
    const scroller = fromHandle ? null : scrollableUnder(target, el.current);
    start.current = { y: e.clientY, t: e.timeStamp, scroller };
    dragging.current = fromHandle;
    if (fromHandle) {
      if (el.current) el.current.style.transition = "none";
      // capture so the drag keeps tracking even if the finger slides off the handle onto the list
      try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* ignore */ }
    }
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const s = start.current; if (!s || !el.current) return;
    const dy = e.clientY - s.y;
    if (!dragging.current) {
      const atTop = !s.scroller || s.scroller.scrollTop <= 0;
      if (dy > 8 && atTop) {
        dragging.current = true; // pulled down from the top → take over as a dismiss-drag
        el.current.style.transition = "none";
        try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* ignore */ }
      } else {
        return; // let the inner content scroll normally
      }
    }
    if (dy > 0) el.current.style.transform = `translateY(${dy}px)`;
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const s = start.current; start.current = null;
    const wasDragging = dragging.current; dragging.current = false;
    if (!s || !el.current || !wasDragging) return;
    const dy = e.clientY - s.y;
    const v = dy / Math.max(1, e.timeStamp - s.t); // px/ms — flick velocity
    el.current.style.transition = "transform .18s ease";
    if (dy > threshold || v > 0.6) { el.current.style.transform = `translateY(110%)`; buzz(8); setTimeout(onClose, 150); }
    else reset();
  };

  return { ref: setNode, onPointerDown, onPointerMove, onPointerUp };
}
