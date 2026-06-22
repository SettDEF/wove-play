import { useMemo, type MouseEvent } from "react";

/** Split a multi-artist string into individual names + the separators between them. The separators are a
 *  CAPTURING group so `split` keeps them — we re-render them as plain text between the clickable names, so
 *  "Bloodlust, Holy Priest" / "A feat. B" / "X x Y" each become tappable per-artist. Word separators
 *  (feat/ft/with/vs/x) require surrounding spaces so we never break names like "Within Temptation". */
const SEP = /(\s*,\s*|\s*;\s*|\s*\/\s*|\s*&\s*|\s+feat\.?\s+|\s+ft\.?\s+|\s+featuring\s+|\s+with\s+|\s+vs\.?\s+|\s+x\s+|\s+×\s+)/i;

/** Render an artist (or any people-list) string with each name a clickable link. */
export function ArtistLinks({ value, onActivate, onMenu, className }: {
  value: string;
  onActivate: (name: string) => void;          // left-click → go to artist
  onMenu: (name: string, ev: MouseEvent) => void; // right-click → options popup at the cursor
  className?: string;
}) {
  const parts = useMemo(() => (value ? value.split(SEP) : []), [value]);
  return (
    <span className={className}>
      {parts.map((p, i) =>
        i % 2 === 0
          ? (p.trim()
              ? <button key={i} type="button" className="wp-artlink" title={`Go to ${p.trim()} — right-click for options`}
                  onClick={(e) => { e.stopPropagation(); onActivate(p.trim()); }}
                  onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onMenu(p.trim(), e); }}>{p}</button>
              : null)
          : <span key={i}>{p}</span>,
      )}
    </span>
  );
}
