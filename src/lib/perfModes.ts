import type { PerfKnobs, PerfMode } from "@/store/settings";

/** A concrete (non-"custom") performance preset id. "custom" isn't a preset — it just records that
 *  your knobs no longer match any preset, so it carries no definition here. */
export type PerfPreset = Exclude<PerfMode, "custom">;

/** One performance mode, fully described in ONE place: its UI card (label / icon / blurb), how hard it
 *  drives album-art prefetch, and the full knob preset it writes when picked. */
export interface PerfModeDef {
  id: PerfPreset;
  label: string;
  icon: string;
  sub: string;
  /** Album-art fetch concurrency multiplier — strongest modes fill a grid fastest, eco modes sip. */
  coverMult: number;
  /** The complete set of knobs written into settings when this mode is selected. */
  knobs: PerfKnobs;
}

/**
 * SINGLE SOURCE OF TRUTH for the performance modes. The settings store (preset knobs + cover
 * multiplier) and the Settings UI (the mode cards) both derive from this list — add or tune a mode in
 * ONE place and everything stays in sync. Order = display order.
 *
 * Crucially, NONE of these trade away interaction responsiveness or audio latency — the always-on
 * render fixes (memoised rows, isolated seekbar, throttled spectrum) keep scrolling + skipping instant
 * in every mode. Modes only scale genuinely-optional load: visualizer fps/resolution, background blur,
 * album-art cache, and when on-device analysis runs.
 *   ultra/high — max eye-candy      · smooth    — UI-first hybrid (kills blur for buttery lists)
 *   balanced   — sensible default   · cinematic — visuals-first hybrid (full viz, lazy lists)
 *   battery    — endurance          · dynamic   — starts at balanced, then auto-adapts (perfRuntime)
 */
export const PERF_MODES: PerfModeDef[] = [
  { id: "ultra",     label: "Ultra",     icon: "bolt",      sub: "Everything maxed — still lag-free",        coverMult: 2.2,
    knobs: { fpsCap: 0,  lowPower: false, lazyCovers: false, coverCacheSize: 2500, exploreBlur: 40, bgBlur: 80,  appBg: "blur", tastePerf: "high", analysisMode: "onplay", liveSearch: true,  searchDebounce: 100, uiAnimations: "full",    batterySaver: false } },
  { id: "high",      label: "High",      icon: "graphicEq", sub: "Rich visuals · 60 fps",                    coverMult: 1.6,
    knobs: { fpsCap: 60, lowPower: false, lazyCovers: false, coverCacheSize: 1500, exploreBlur: 28, bgBlur: 64,  appBg: "blur", tastePerf: "high", analysisMode: "onplay", liveSearch: true,  searchDebounce: 150, uiAnimations: "full",    batterySaver: false } },
  { id: "balanced",  label: "Balanced",  icon: "tune",      sub: "The sensible default",                     coverMult: 1,
    knobs: { fpsCap: 60, lowPower: false, lazyCovers: false, coverCacheSize: 800,  exploreBlur: 18, bgBlur: 64,  appBg: "blur", tastePerf: "high", analysisMode: "onplay", liveSearch: true,  searchDebounce: 180, uiAnimations: "full",    batterySaver: false } },
  { id: "smooth",    label: "Smooth",    icon: "next",      sub: "Hybrid · UI-first: buttery lists, no blur", coverMult: 0.7,
    knobs: { fpsCap: 30, lowPower: true,  lazyCovers: true,  coverCacheSize: 1200, exploreBlur: 0,  bgBlur: 0,   appBg: "off",  tastePerf: "high", analysisMode: "idle",   liveSearch: false, searchDebounce: 250, uiAnimations: "reduced", batterySaver: false } },
  { id: "cinematic", label: "Cinematic", icon: "image",     sub: "Hybrid · visuals-first: full viz & blur",  coverMult: 1.4,
    knobs: { fpsCap: 0,  lowPower: false, lazyCovers: true,  coverCacheSize: 1000, exploreBlur: 40, bgBlur: 100, appBg: "blur", tastePerf: "high", analysisMode: "idle",   liveSearch: true,  searchDebounce: 180, uiAnimations: "full",    batterySaver: false } },
  { id: "battery",   label: "Battery",   icon: "battery",   sub: "Endurance — minimal load",                 coverMult: 0.5,
    knobs: { fpsCap: 30, lowPower: true,  lazyCovers: true,  coverCacheSize: 400,  exploreBlur: 0,  bgBlur: 24,  appBg: "blur", tastePerf: "low",  analysisMode: "off",    liveSearch: false, searchDebounce: 350, uiAnimations: "reduced", batterySaver: true } },
  { id: "dynamic",   label: "Dynamic",   icon: "refresh",   sub: "Auto-adapts to your device live",          coverMult: 1,
    knobs: { fpsCap: 60, lowPower: false, lazyCovers: false, coverCacheSize: 800,  exploreBlur: 18, bgBlur: 64,  appBg: "blur", tastePerf: "high", analysisMode: "idle",   liveSearch: true,  searchDebounce: 180, uiAnimations: "full",    batterySaver: false } },
];

/** The "custom" card (not a preset — keeps whatever mix you've dialled in). UI-only. */
export const CUSTOM_CARD = { id: "custom" as const, label: "Custom", icon: "shape", sub: "Your own mix of the knobs" };

/** id → knob preset, derived from PERF_MODES (what `setPerfMode` writes). */
export const PERF_PRESETS = Object.fromEntries(PERF_MODES.map((m) => [m.id, m.knobs])) as Record<PerfPreset, PerfKnobs>;

const COVER_MULT = Object.fromEntries(PERF_MODES.map((m) => [m.id, m.coverMult])) as Record<PerfPreset, number>;
/** Album-art fetch concurrency multiplier for a mode ("custom" and unknowns → 1). */
export const coverMultFor = (mode: PerfMode): number => (mode === "custom" ? 1 : COVER_MULT[mode] ?? 1);
