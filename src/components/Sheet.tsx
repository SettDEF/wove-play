import { useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useSwipeDown } from "@/lib/touch";
import { useBackGuard } from "@/lib/backStack";

interface Props {
  onClose: () => void;
  children: ReactNode;
  /** Extra class(es) on the sheet surface (e.g. "wp-ftree"). */
  className?: string;
  /** Tall (72vh) variant — the default for list/picker sheets. */
  tall?: boolean;
  /** Hide the drag grip (rare; the grip is also the swipe-down handle). */
  noGrip?: boolean;
}

const CLOSE_MS = 230;

/**
 * Reusable bottom sheet: dim backdrop (tap-out to close) + swipe-down-to-dismiss
 * (drag the grip/header) + the drag grip. Tap-out / Esc play a slide-DOWN close
 * animation before unmounting (not an instant disappear).
 */
export function Sheet({ onClose, children, className = "", tall = true, noGrip = false }: Props) {
  const [closing, setClosing] = useState(false);
  const closeTimer = useRef<number | null>(null);
  // animate the sheet down + fade the scrim, THEN actually unmount.
  const animateClose = () => {
    if (closing) return;
    setClosing(true);
    closeTimer.current = window.setTimeout(onClose, CLOSE_MS);
  };
  useBackGuard(true, animateClose);   // Android back / Esc closes any sheet (with the slide-down anim)
  const sw = useSwipeDown(onClose); // swipe already animates (drags the sheet out) then closes
  // Portal to <body>: a sheet rendered inside a transformed/contained ancestor (e.g. the player's
  // pull-down transform) would otherwise have its position:fixed re-anchored and drop mid-screen
  // instead of floating. Portaling escapes that containing block so it always overlays correctly.
  return createPortal(
    <div className={`wp-sheet-backdrop ${closing ? "wp-sheet-closing" : ""}`} onClick={animateClose}>
      <div
        className={`wp-sheet ${tall ? "wp-sheet-tall" : ""} ${className}`}
        onClick={(e) => e.stopPropagation()}
        ref={sw.ref}
        onPointerDown={sw.onPointerDown}
        onPointerMove={sw.onPointerMove}
        onPointerUp={sw.onPointerUp}
      >
        {!noGrip && <div className="wp-sheet-grip" />}
        {children}
      </div>
    </div>,
    document.body,
  );
}
