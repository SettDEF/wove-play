import { create } from "zustand";

export type NpBg = "blur" | "gradient" | "solid" | "viz";
export type NpShape = "rounded" | "circle" | "square" | "vinyl";
export type NpDim = "off" | "soft" | "strong";       // contrast scrim over the backdrop
export type NpAccent = "theme" | "art";              // theme primary, or a hue derived from the album art
export type NpControls = "round" | "pill" | "minimal"; // transport button styling

/** Customizable Now-Playing layout (Poweramp-v5 style), persisted to localStorage. */
interface Stored {
  bg: NpBg;          // backdrop behind the whole screen
  shape: NpShape;    // album-art / stage shape
  showViz: boolean;  // show the Art⇄Visualizer toggle on the stage
  bigArt: boolean;   // larger stage vs more breathing room for controls
  spinArt: boolean;  // rotate the artwork like a vinyl record while playing (great with the circle shape)
  glow: boolean;     // ambient album-colour glow behind the artwork
  bgDim: NpDim;      // how strongly to darken the backdrop (readability over busy art)
  accent: NpAccent;  // where the accent colour (FAB / glow / active controls) comes from
  controls: NpControls; // transport button look
  showStars: boolean;   // show the inline 5-star rating row under the title
  compact: boolean;     // tighter vertical spacing (fits more on small screens)
}
const DEFAULTS: Stored = {
  bg: "blur", shape: "rounded", showViz: true, bigArt: true, spinArt: false, glow: false,
  bgDim: "off", accent: "theme", controls: "round", showStars: true, compact: false,
};

const LS = "wavrplay-nplayout";
function load(): Stored {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(LS) || "") }; } catch { return { ...DEFAULTS }; }
}
function persist(s: Stored) { try { localStorage.setItem(LS, JSON.stringify(s)); } catch { /* ignore */ } }

interface NpLayoutState extends Stored {
  set: <K extends keyof Stored>(k: K, v: Stored[K]) => void;
  reset: () => void;
}

export const useNpLayout = create<NpLayoutState>((set, get) => ({
  ...load(),
  set: (k, v) => {
    set({ [k]: v } as Partial<NpLayoutState>);
    const { set: _s, reset: _r, ...rest } = get();
    persist(rest);
  },
  reset: () => { set({ ...DEFAULTS }); persist({ ...DEFAULTS }); },
}));
