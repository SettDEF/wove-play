/** Alternate app-icon variants (Settings → Appearance → App icon) — the "Signature 5". Each is a bold
 *  gradient MARK on the dark app background (no rounded coloured plate); on Android, picking one enables
 *  the matching <activity-alias> so the launcher icon + its draw-on launch animation change (needs an APK
 *  rebuild). `id` MUST match the Android alias/resource suffix (ic_fg_<id> / avd_icon_<id> / Icon_<id>). */
/** `bg` = the dark tile the in-app preview sits on (matches the launcher's plate-less dark background);
 *  `fg` = the mark's accent colour; `glyph` = its motif (an Icon name), omitted → the "W" monogram. */
export interface AppIconVariant { id: string; label: string; bg: string; fg: string; glyph?: string }

const TILE = "linear-gradient(145deg, #16201a, #0b0f0d)"; // shared dark tile — no bright plate

export const APP_ICONS: AppIconVariant[] = [
  { id: "default", label: "Monogram", bg: TILE, fg: "#d2697f" },                          // the flagship "W"
  { id: "wave",    label: "Waveform", bg: TILE, fg: "#e0556a", glyph: "graphicEq" },
  { id: "endless", label: "Endless",  bg: TILE, fg: "#9a6be8", glyph: "allInclusive" },
  { id: "play",    label: "Play",     bg: TILE, fg: "#f0954a", glyph: "play" },
  { id: "mono",    label: "Mono",     bg: TILE, fg: "#e8e8e8", glyph: "circle" },
];

export const isAppIcon = (id: string): boolean => APP_ICONS.some((v) => v.id === id);
/** The valid icon id for a (possibly stale) stored value — falls back to the flagship default. */
export const safeAppIcon = (id: string): string => (isAppIcon(id) ? id : "default");
