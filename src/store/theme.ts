import { create } from "zustand";
import { hexToHsl, setPrimaryRamp } from "@/theme/color";
import { loadSystemColors } from "@/lib/backend";

/** Accent swatches (M3-style seeds). The first matches the app's original green. */
export const ACCENTS: { name: string; hex: string }[] = [
  { name: "Mint", hex: "#7ce2b0" }, { name: "Sky", hex: "#7cc4e2" }, { name: "Indigo", hex: "#9aa0ff" },
  { name: "Violet", hex: "#c0a0ff" }, { name: "Pink", hex: "#ff9ecb" }, { name: "Coral", hex: "#ff9e80" },
  { name: "Amber", hex: "#ffce7c" }, { name: "Lime", hex: "#c7e27c" },
];

/** AMOLED true-black surface ramp (near-black, rising) vs the default dark surfaces in m3.css. */
const AMOLED_VARS: Record<string, string> = {
  "--md-background": "#000000",
  "--md-surface": "#000000",
  "--md-surface-dim": "#000000",
  "--md-surface-container-lowest": "#000000",
  "--md-surface-container-low": "#0a0a0a",
  "--md-surface-container": "#101010",
  "--md-surface-container-high": "#161616",
  "--md-surface-container-highest": "#1d1d1d",
};

export type ThemeMode = "system" | "light" | "dark" | "amoled";

const LS = "wavrplay-theme";
interface Stored { accent: string; mode: ThemeMode; useSystem: boolean; }
const DEFAULTS: Stored = { accent: ACCENTS[0].hex, mode: "dark", useSystem: false };
function load(): Stored {
  try {
    const s = JSON.parse(localStorage.getItem(LS) || "");
    const mode: ThemeMode = s.mode ?? (s.amoled ? "amoled" : "dark"); // migrate old { amoled } pref
    return { accent: s.accent ?? DEFAULTS.accent, mode, useSystem: !!s.useSystem };
  } catch { return { ...DEFAULTS }; }
}
function persist(s: Stored) { try { localStorage.setItem(LS, JSON.stringify(s)); } catch { /* ignore */ } }

function prefersDark(): boolean { try { return matchMedia("(prefers-color-scheme: dark)").matches; } catch { return true; } }
/** Whether a mode resolves to a dark palette (system follows the OS). */
export function isDarkMode(mode: ThemeMode): boolean { return mode === "light" ? false : mode === "system" ? prefersDark() : true; }

interface ThemeState extends Stored {
  systemAccent: string | null;     // fetched Material You wallpaper accent (Android 12+)
  setAccent: (hex: string) => void;
  setMode: (m: ThemeMode) => void;
  setUseSystem: (on: boolean) => void;
  fetchSystem: () => Promise<void>;
  isDark: () => boolean;
  /** Re-apply the theme (data-theme + accent ramp + AMOLED surfaces). Called on load + when dynamic color clears. */
  apply: () => void;
}

export const useTheme = create<ThemeState>((set, get) => ({
  ...load(),
  systemAccent: null,
  setAccent: (accent) => { set({ accent }); persist(get()); get().apply(); },
  setMode: (mode) => { set({ mode }); persist(get()); get().apply(); },
  setUseSystem: (useSystem) => { set({ useSystem }); persist(get()); if (useSystem) void get().fetchSystem(); else get().apply(); },
  fetchSystem: async () => {
    const c = await loadSystemColors();
    set({ systemAccent: c?.available && c.accent ? c.accent : null });
    get().apply();
  },
  isDark: () => isDarkMode(get().mode),
  apply: () => {
    const { accent, mode, useSystem, systemAccent } = get();
    const dark = isDarkMode(mode);
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    const seed = useSystem && systemAccent ? systemAccent : accent;  // Material You overrides the manual accent
    const [h, s] = hexToHsl(seed);
    setPrimaryRamp(h, s, dark);
    const root = document.documentElement.style;
    for (const [k, v] of Object.entries(AMOLED_VARS)) {
      if (mode === "amoled") root.setProperty(k, v); else root.removeProperty(k);
    }
  },
}));
