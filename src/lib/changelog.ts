/** Single source of truth for the app version + changelog (shown in Settings AND the launch "What's new"
 *  popup). Bump APP_VERSION + add a CHANGELOG entry on every release — the popup auto-shows it once. */

export const APP_VERSION = "0.2.2"; // keep in sync with package.json + tauri.conf.json

export interface ChangelogEntry { v: string; date: string; notes: string[] }

export const CHANGELOG: ChangelogEntry[] = [
  { v: "0.2.2", date: "Jun 2026", notes: [
    "Album art that sometimes wouldn’t load in the player now loads reliably (a brief read at track start retries instead of going blank)",
    "Text stays readable over the blurred-art background, even on bright covers",
    "New “Ring” player icon — a gapped ring on the centre nav tab that visibly spins while playing (Settings → Look → Nav)",
    "Library: the folder / add / reindex menu is now a tidy bottom sheet on Android, and the tab bar reads cleaner",
    "Faster launch — the “W” splash settles quicker, and the app-icon picker shows the real, centred marks",
    "Fixes: the Settings “Audio timeline” row layout, and more",
  ] },
  { v: "0.2.1", date: "Jun 2026", notes: [
    "New optional “Waveform” seek style — a real, on-device waveform that loads when you pick it (Settings → Look)",
    "Browse: more categories (Never Played, Shuffle All) + fixed the Low Rated icon",
    "For You: the “Sounds like” mixes now sit in a tidy grid on desktop / swipe carousel on phone",
    "Smoother back-swipe (the screen shrinks away while the previous one grows in)",
    "Library: folder / add / reindex tucked into a ⋯ menu for a cleaner header",
    "Crisper, centered app icon",
    "Fixes: album art not loading in the player on Android, and more",
  ] },
  { v: "0.2.0", date: "Jun 2026", notes: [
    "Desktop media controls (MPRIS): cover, title & playback buttons in your system tray / lock screen",
    "New UI-zoom control — scale the whole interface to fit HiDPI displays (Ctrl +/−/0)",
    "Mini-player timeline: drag to seek, plus an optional Android-12 “wavy” squiggle look",
    "Right-click a cover or artist for quick actions; first-visit intros for Explore & For You",
    "Sharper, aspect-correct Sound-DNA glyphs",
    "Proper Linux desktop integration (app-menu entry + audio file associations)",
    "Many settings & layout refinements",
  ] },
  { v: "0.1.0", date: "Jun 2026", notes: [
    "A fast, local-first music player — no account, no cloud",
    "Real Android media player: lock-screen controls + true background playback",
    "Reworked player: customizable layout, a vinyl cover you can scratch, and a song-section timeline you can zoom into",
    "Parametric 10-band equalizer with per-output audio info",
    "“For You” taste engine — on-device mixes & stations from your own library",
    "Built for huge libraries (40k+ songs): windowed lists, instant tab switching, much faster scrolling & launch",
  ] },
  { v: "0.0.9", date: "Jun 2026", notes: [
    "Pinch-zoom library ladder + Browse categories",
    "Parametric EQ clone + per-output audio info",
    "For You taste engine: on-device mixes & stations",
  ] },
  { v: "0.0.8", date: "May 2026", notes: [
    "Blurred album-art background + first-boot personalization",
    "Crossfade, gapless & smart transitions",
  ] },
];

/** Compare two dotted versions (e.g. "0.2.0" vs "0.1.9"). >0 if a is newer, <0 if older, 0 if equal.
 *  Ignores any "-beta"/build suffix so "0.2.0-beta" compares as "0.2.0". */
export function cmpVersion(a: string, b: string): number {
  const parse = (v: string) => v.split("-")[0].split(".").map((n) => parseInt(n, 10) || 0);
  const pa = parse(a), pb = parse(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}
