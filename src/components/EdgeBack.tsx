import { useEffect } from "react";
import { hasBack, goBack } from "@/lib/backStack";

/**
 * LIVE swipe-back (iOS-style). Drag right and the current window/overlay follows your finger, while the
 * destination underneath is revealed sliding in from the LEFT (a parallax "peek" panel). Release past a
 * third of the width (or a quick flick) completes the back; otherwise it springs back. Works anywhere
 * there's something to go back to — sheets, Settings sub-pages, playlist details, any guarded screen —
 * because it drives the same back-stack the hardware back button uses. Mounted once in App.
 *
 * The start zone is the left ~45% of the width (not just the rim), so you don't have to hit the exact
 * edge — but a drag that begins ON a horizontal control (slider / segmented button / seekbar / EQ fader)
 * is left to that control, so settings sliders etc. still work.
 */
const EDGE_FRAC = 0.45; // a back-swipe may start anywhere in the left 45% of the width…
const EDGE_MIN = 84;    // …but always at least this many px (narrow screens)
const SLOP = 8;         // px before we decide it's a horizontal gesture
const COMMIT = 0.32;    // fraction of width (or a flick) that completes the back
// Controls whose own horizontal drag must NOT be hijacked by the back-swipe.
const NO_SWIPE = "input, textarea, select, [role=slider], .wp-seg, .wp-switch, .wp-knob, .wp-slider, .wp-eqf-track, .wp-fader, .wp-range, [data-noswipe]";

export function EdgeBack() {
  useEffect(() => {
    let target: HTMLElement | null = null;
    let peek: HTMLElement | null = null;
    let startX = 0, startY = 0, startT = 0, w = 1;
    let active = false, decided = false;
    let settleTimer = 0; // pending spring-back / commit cleanup (cancelled if a new swipe starts)

    // The thing to slide: the topmost sheet, else the active screen, else the whole content area.
    const pick = (): HTMLElement | null =>
      [...document.querySelectorAll<HTMLElement>(".wp-sheet")].pop()
      ?? [...document.querySelectorAll<HTMLElement>(".wp-screen")].pop()
      ?? document.querySelector<HTMLElement>(".wp-content");

    // A surface-coloured panel inserted just BEHIND the sliding pane, so the gap left as the pane moves
    // right shows the destination arriving from the left (parallax) instead of an empty void.
    const makePeek = (el: HTMLElement) => {
      const p = document.createElement("div");
      p.className = "wp-edgeback-peek";
      el.parentElement?.insertBefore(p, el);
      return p;
    };
    // Reset specific nodes (captured per-gesture) so a pending settle from a previous swipe never touches
    // the element a NEW swipe is driving.
    const resetEl = (el: HTMLElement | null, pk: HTMLElement | null) => {
      if (el) { el.style.transform = ""; el.style.transition = ""; el.style.boxShadow = ""; el.style.willChange = ""; }
      if (pk) pk.remove();
    };

    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 1 || !hasBack()) return;
      const t = e.touches[0];
      w = window.innerWidth || 1;
      if (t.clientX > Math.max(EDGE_MIN, w * EDGE_FRAC)) return;          // started too far right → not a back-swipe
      if ((e.target as HTMLElement)?.closest?.(NO_SWIPE)) return;          // a slider/segment owns this drag
      if (settleTimer) { clearTimeout(settleTimer); settleTimer = 0; resetEl(target, peek); } // snap a still-animating prior swipe
      startX = t.clientX; startY = t.clientY; startT = Date.now();
      active = true; decided = false; target = null; peek = null;
    };
    const onMove = (e: TouchEvent) => {
      if (!active) return;
      const t = e.touches[0];
      const dx = t.clientX - startX, dy = t.clientY - startY;
      if (!decided) {
        if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return;
        if (Math.abs(dy) > Math.abs(dx)) { active = false; return; } // a vertical scroll, not a back-swipe
        decided = true;
        target = pick();
        if (target) {
          // A full-screen nav reveals a void behind it → add the peek panel. A bottom sheet already has the
          // real screen painted behind it, so no peek (it would just cover the screen with a flat surface).
          if (!target.classList.contains("wp-sheet")) peek = makePeek(target);
          target.style.willChange = "transform"; target.style.transition = "none";
        }
      }
      if (!target) return;
      const x = Math.max(0, dx);
      const frac = Math.min(1, x / w);
      target.style.transform = `translate3d(${x}px,0,0)`;
      target.style.boxShadow = "-16px 0 38px rgba(0,0,0,.4)";
      // Destination parallax: starts shifted ~18% to the left and eases to 0 as you pull across — so it
      // reads as the previous window coming in, and it's brightest (most "arrived") near the commit point.
      if (peek) { peek.style.transform = `translate3d(${(frac - 1) * w * 0.18}px,0,0)`; peek.style.opacity = String(0.55 + frac * 0.45); }
      e.preventDefault(); // claim the gesture from horizontal page scroll
    };
    const finish = (e: TouchEvent) => {
      if (!active) return;
      active = false;
      const el = target, pk = peek; target = null; peek = null; // capture; shared slots free for the next swipe
      if (!el || !decided) { resetEl(el, pk); return; }
      const dx = (e.changedTouches[0]?.clientX ?? startX) - startX;
      const vx = dx / Math.max(1, Date.now() - startT); // px/ms
      const commit = dx > w * COMMIT || vx > 0.5;
      const ease = "transform .22s cubic-bezier(.2,.8,.2,1), box-shadow .22s, opacity .22s";
      el.style.transition = ease;
      if (pk) pk.style.transition = ease;
      if (commit) {
        el.style.transform = `translate3d(${w}px,0,0)`;
        if (pk) { pk.style.transform = "translate3d(0,0,0)"; pk.style.opacity = "1"; }
        settleTimer = window.setTimeout(() => { settleTimer = 0; resetEl(el, pk); goBack(); }, 200); // reset BEFORE back (el may stay mounted, e.g. a tab)
      } else {
        el.style.transform = "translate3d(0,0,0)";
        if (pk) pk.style.opacity = "0";
        settleTimer = window.setTimeout(() => { settleTimer = 0; resetEl(el, pk); }, 240);
      }
    };

    window.addEventListener("touchstart", onStart, { passive: true });
    window.addEventListener("touchmove", onMove, { passive: false });
    window.addEventListener("touchend", finish);
    window.addEventListener("touchcancel", finish);
    return () => {
      window.removeEventListener("touchstart", onStart);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", finish);
      window.removeEventListener("touchcancel", finish);
      if (settleTimer) clearTimeout(settleTimer);
      resetEl(target, peek);
    };
  }, []);
  return null;
}
