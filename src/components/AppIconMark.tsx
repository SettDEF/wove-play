/** The five "Signature" app-icon marks as inline SVG — the SAME vector art as the Android launcher icons
 *  (src-tauri/.../res/drawable/ic_fg_*.xml) and the launch splash. Rendering the real marks here makes the
 *  in-app picker previews pixel-true and each glyph distinct, every one optically centred in the 108
 *  viewBox (so they stop looking like generic, off-centre icon-font glyphs). `fg` tints the mark. */
import type { ReactNode } from "react";

export function AppIconMark({ id, fg }: { id: string; fg: string }) {
  const svg = (children: ReactNode) => (
    <svg className="wp-icontile-mark" viewBox="0 0 108 108" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      {children}
    </svg>
  );
  switch (id) {
    case "wave": {
      // five pill bars, symmetric about x=54 (centres 28·41·54·67·80), tallest in the middle.
      const bars = [26, 44, 58, 44, 26];
      return svg(bars.map((h, i) => (
        <rect key={i} x={28 + i * 13 - 3.5} y={54 - h / 2} width={7} height={h} rx={3.5} fill={fg} />
      )));
    }
    case "endless":
      // lemniscate (∞) as a thick rounded stroke, centred at (54,54).
      return svg(
        <path d="M54,54 C44,40 28,40 28,54 C28,68 44,68 54,54 C64,40 80,40 80,54 C80,68 64,68 54,54 Z"
          stroke={fg} strokeWidth={11} strokeLinecap="round" strokeLinejoin="round" />,
      );
    case "play":
      // rounded play triangle — its centroid sits on x=54, so it reads centred.
      return svg(
        <path d="M42,36 a5,5 0 0 1 7.6,-4.3 L78,49.7 a5,5 0 0 1 0,8.6 L49.6,76.3 a5,5 0 0 1 -7.6,-4.3 Z" fill={fg} />,
      );
    case "mono":
      // minimal ring (donut) via even-odd fill, centred at (54,54).
      return svg(
        <path fillRule="evenodd" clipRule="evenodd" fill={fg}
          d="M54,32 a22,22 0 1 1 0,44 a22,22 0 1 1 0,-44 Z M54,44 a10,10 0 1 1 0,20 a10,10 0 1 1 0,-20 Z" />,
      );
    default:
      // the flagship "W" monogram (same path as the launcher icon + splash).
      return svg(
        <path fill={fg}
          d="M26,34 L36,34 L48,76 L40,76 Z M42,76 L50,76 L58,50 L50,50 Z M50,50 L58,50 L70,76 L62,76 Z M64,76 L72,76 L82,34 L72,34 Z" />,
      );
  }
}
