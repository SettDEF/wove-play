import { createPortal } from "react-dom";
import { usePlayer } from "@/store/player";
import { useSettings } from "@/store/settings";
import { useCover } from "./Cover";

/**
 * App-wide blurred album-art backdrop (Poweramp-style). Sits behind all content via a negative
 * z-index inside the (transparent) app shell; a scrim keeps foreground text readable. Toggled by
 * Settings → Appearance → Background. Renders nothing when off or when there's no art.
 */
export function AppBackground() {
  const appBg = useSettings((s) => s.appBg);
  const tab = usePlayer((s) => s.tab);
  const path = usePlayer((s) => s.current()?.path);
  const art = useCover(path);
  // Always render on the player tab (even with the app background OFF): the player's own backdrop is
  // clipped to the content area, so without this the strip behind the floating nav fell through to the
  // dark window base. This full-window backdrop (portaled to <body>) fills it with the same art.
  if (appBg !== "blur" && tab !== "playing") return null;
  // Portal to <body> so the blurred art is a true FULL-WINDOW backdrop — behind the app shell, the
  // floating tab bar AND the Android system-nav strip (which sits below .wp-app's 100dvh box). Kept
  // inside .wp-app it was clipped to that box, so the area under the tabs/nav showed the solid base.
  return createPortal(
    <div className="wp-appbg" aria-hidden>
      {art && <div className="wp-appbg-img" style={{ backgroundImage: `url(${art})` }} />}
      <div className="wp-appbg-scrim" />
    </div>,
    document.body,
  );
}
