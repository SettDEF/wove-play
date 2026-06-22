import { create } from "zustand";

// ── model ────────────────────────────────────────────────────────────────────
export type Aspect = "16:9" | "9:16" | "1:1" | "fit";
export type BandSource = "bass" | "mid" | "treble" | "level";
export type BindMode = "continuous" | "beat";
/** Route a band's energy (0..1) into a numeric property: value += clamp(f(band) × amount).
 *  - mode "beat": fire 1.0 only when the band spikes above its running average (transient).
 *  - curve: >1 = exponential punch.  attack/release: rise/fall envelope (0..0.95 smoothing).
 *  - min/max: clamp the contribution (e.g. scale only grows 0..0.8 above base). */
export interface AudioBind {
  source: BandSource;
  amount: number;
  mode?: BindMode;
  curve?: number;
  attack?: number;
  release?: number;
  /** legacy single falloff (used as `release` if attack/release unset). */
  smoothing?: number;
  min?: number;
  max?: number;
  /** Per-binding frequency window in Hz (Avee-style). When BOTH are set the binding reads energy
   *  from that exact range instead of the named `source` band (which stays as the UI label). */
  freqLo?: number;
  freqHi?: number;
}

/** "group" is a composite node: renders nothing, just a transform/opacity container whose
 *  modulated transform is inherited by its children (a real scene graph). */
export type LayerType = "group" | "background" | "spectrum" | "wave" | "radial" | "particles" | "image" | "text" | "shape";

export type PropValue = number | string | boolean;
export interface Layer {
  id: string;
  type: LayerType;
  name: string;
  visible: boolean;
  /** parent group id (scene-graph hierarchy); null = root. */
  parent: string | null;
  opacity: number;       // 0..1
  blend: GlobalCompositeOperation;
  // transform — x/y are normalized offsets of canvas size (0 = centred); scale 0..3; rotation in degrees
  x: number; y: number; scale: number; rotation: number;
  props: Record<string, PropValue>;
  /** audio-reactive bindings keyed by transform field ("scale"/"opacity"/…) or numeric prop name */
  bind: Record<string, AudioBind>;
}

export interface Scene { id: string; name: string; aspect: Aspect; layers: Layer[]; }

export const BLEND_MODES: GlobalCompositeOperation[] = ["source-over", "lighter", "screen", "overlay", "multiply"];

// ── id + layer factory ───────────────────────────────────────────────────────
let _seq = 0;
const genId = (p: string) => `${p}${(_seq++).toString(36)}_${Math.floor((typeof performance !== "undefined" ? performance.now() : 0)).toString(36)}`;

const DEFAULT_PROPS: Record<LayerType, Record<string, PropValue>> = {
  group: {},
  background: { color1: "#0f1411", color2: "#0a0a14", useGradient: false, hue: 0 },
  spectrum:   { style: "bars", count: 64, gap: 2, rounded: true, thickness: 1, anchor: "bottom", logFreq: false, peakHold: false,
                color1: "#7ce2b0", color2: "#a4cdde", useGradient: true, glow: 12, sensitivity: 1.3, smoothing: 0.78, hue: 0 },
  wave:       { lineWidth: 3, color1: "#7ce2b0", color2: "#7ce2b0", useGradient: false, glow: 18, sensitivity: 1, smoothing: 0.7, hue: 0 },
  radial:     { count: 96, radius: 0.22, lineWidth: 3, logFreq: false, color1: "#cda4de", color2: "#7ce2b0", useGradient: true, glow: 20, sensitivity: 1.3, smoothing: 0.8, hue: 0 },
  particles:  { count: 220, size: 3, gravity: 1, spread: 1, origin: "bottom", color1: "#7ce2b0", color2: "#a4cdde", useGradient: true, glow: 18, sensitivity: 1.4, hue: 0 },
  image:      { source: "url", src: "", fit: "cover", circle: false, glow: 0 },
  text:       { token: "title", custom: "Your text", size: 0.09, align: "center", glow: 6, color1: "#ffffff", hue: 0 },
  shape:      { shape: "rect", fill: false, w: 0.5, h: 0.3, stroke: 6, radius: 0.12, glow: 8, useGradient: false, color1: "#ffffff", color2: "#ffffff", hue: 0 },
};
const NICE_NAME: Record<LayerType, string> = {
  group: "Group", background: "Background", spectrum: "Spectrum", wave: "Waveform", radial: "Radial", particles: "Particles", image: "Image", text: "Text", shape: "Shape",
};

export function newLayer(type: LayerType): Layer {
  return {
    id: genId("ly"), type, name: NICE_NAME[type], visible: true, parent: null,
    opacity: 1, blend: "source-over", x: 0, y: 0, scale: 1, rotation: 0,
    props: { ...DEFAULT_PROPS[type] }, bind: {},
  };
}

// ── templates (the old presets, now full scenes) ──────────────────────────────
function bg(color1: string, color2?: string): Layer {
  const l = newLayer("background");
  l.props.color1 = color1;
  if (color2) { l.props.color2 = color2; l.props.useGradient = true; }
  return l;
}
function spectrum(over: Partial<Record<string, PropValue>>): Layer {
  const l = newLayer("spectrum"); Object.assign(l.props, over); return l;
}

export const TEMPLATES: { name: string; build: () => Scene }[] = [
  { name: "Spectrum", build: () => scene("Spectrum", "16:9", [bg("#0f1411"), spectrum({ style: "bars" })]) },
  { name: "Mirror", build: () => scene("Mirror", "16:9", [bg("#0f1411"), spectrum({ style: "mirror", count: 80, color1: "#ffb4ab", color2: "#ffd27c", glow: 16 })]) },
  { name: "Oscilloscope", build: () => scene("Oscilloscope", "16:9", [bg("#08110d"), layerWith("wave", { glow: 20 })]) },
  { name: "Radial", build: () => { const r = layerWith("radial", {}); const s = scene("Radial", "1:1", [bg("#0a0a14"), r]); return s; } },
  { name: "Particles", build: () => { const b = bg("#0a0a14"); b.opacity = 0.28; const p = layerWith("particles", {}); return scene("Particles", "9:16", [b, p]); } },
  { name: "Neon Night", build: () => scene("Neon Night", "16:9", [bg("#0a0a14"),
      spectrum({ style: "mirror", color1: "#ff7ce2", color2: "#7ce2ff", glow: 30 }),
      layerWith("wave", { color1: "#7ce2ff", glow: 24, sensitivity: 0.8 })]) },
  { name: "Trap City", build: trapCity },
];

/** Trap Nation / Trap City–style scene: replaceable background image, a glowing radial spectrum
 *  ring, additive particles, a beat-pulsing centre image, and a bold title. */
function trapCity(): Scene {
  const back = bg("#0a0a18", "#1a0a2e");                 // dark purple gradient (shows until you set the bg image)
  const bgImg = layerWith("image", { src: "", fit: "cover" }); bgImg.name = "Background image"; // ← replace this layer's source
  const ring = layerWith("radial", { count: 150, radius: 0.2, lineWidth: 4, color1: "#a36bff", color2: "#6bd0ff", useGradient: true, glow: 30, sensitivity: 1.4 });
  ring.name = "Spectrum ring";
  const parts = layerWith("particles", { count: 320, size: 2.5, gravity: 0, spread: 1.6, origin: "center", color1: "#c0a0ff", color2: "#6bd0ff", useGradient: true, glow: 26, sensitivity: 1.5 });
  parts.name = "Particles"; parts.blend = "lighter";
  const ringShape = layerWith("shape", { shape: "circle", fill: false, w: 0.4, h: 0.4, stroke: 3, glow: 22, useGradient: true, color1: "#a36bff", color2: "#6bd0ff" });
  ringShape.name = "Ring";
  const centre = layerWith("image", { src: "", fit: "cover", circle: true }); centre.name = "Centre art"; centre.scale = 0.26;
  centre.bind = { scale: { source: "bass", amount: 0.16, mode: "beat", attack: 0, release: 0.85 } }; // punch on the beat
  const frame = layerWith("shape", { shape: "rect", fill: false, w: 0.44, h: 0.13, radius: 0.28, stroke: 4, glow: 14, color1: "#ffffff" });
  frame.name = "Logo frame"; frame.y = 0.36;
  const title = layerWith("text", { token: "custom", custom: "TRAP CITY", size: 0.06, align: "center", color1: "#ffffff", glow: 18 });
  title.name = "Title"; title.y = 0.36;
  return scene("Trap City", "16:9", [back, bgImg, ringShape, ring, parts, centre, frame, title]);
}

function layerWith(type: LayerType, over: Partial<Record<string, PropValue>>): Layer {
  const l = newLayer(type); Object.assign(l.props, over); return l;
}
function scene(name: string, aspect: Aspect, layers: Layer[]): Scene {
  return { id: genId("sc"), name, aspect, layers };
}

// ── persistence ───────────────────────────────────────────────────────────────
const LS = "wavrplay-scene";
function loadScene(): Scene {
  try {
    const s = JSON.parse(localStorage.getItem(LS) || "");
    if (s && Array.isArray(s.layers)) return s as Scene;
  } catch { /* default */ }
  return TEMPLATES[0].build();
}

// ── renderer prefs (app-level, not part of a scene) ───────────────────────────
export type RendererKind = "gl" | "2d";
const PREFS = "wavrplay-vizprefs";
function loadPrefs(): { renderer: RendererKind; bloom: number; vignette: number } {
  try { const p = JSON.parse(localStorage.getItem(PREFS) || ""); return { renderer: p.renderer === "2d" ? "2d" : "gl", bloom: typeof p.bloom === "number" ? p.bloom : 1.1, vignette: typeof p.vignette === "number" ? p.vignette : 0 }; }
  catch { return { renderer: "gl", bloom: 1.1, vignette: 0 }; }
}
function savePrefs(renderer: RendererKind, bloom: number, vignette: number) { try { localStorage.setItem(PREFS, JSON.stringify({ renderer, bloom, vignette })); } catch { /* ignore */ } }

// ── store ──────────────────────────────────────────────────────────────────────
interface VizState {
  scene: Scene;
  selectedLayerId: string | null;
  fullscreen: boolean;
  panelPos: { x: number; y: number };
  panelCollapsed: boolean;
  renderer: RendererKind;
  bloom: number;
  vignette: number;

  selected: () => Layer | null;
  setFullscreen: (on: boolean) => void;
  setAspect: (a: Aspect) => void;
  selectLayer: (id: string | null) => void;
  addLayer: (type: LayerType) => void;
  removeLayer: (id: string) => void;
  duplicateLayer: (id: string) => void;
  reorderLayer: (id: string, dir: -1 | 1) => void;
  moveLayerEdge: (id: string, edge: "front" | "back") => void;
  toggleVisible: (id: string) => void;
  setParent: (id: string, parent: string | null) => void;
  updateLayer: (id: string, patch: Partial<Layer>) => void;
  setProp: (id: string, key: string, value: PropValue) => void;
  setBind: (id: string, key: string, bind: AudioBind | null) => void;
  applyTemplate: (name: string) => void;
  loadSceneObj: (s: Scene) => void;
  setPanelPos: (x: number, y: number) => void;
  setPanelCollapsed: (c: boolean) => void;
  setRenderer: (r: RendererKind) => void;
  setBloom: (v: number) => void;
  setVignette: (v: number) => void;
}

const initial = loadScene();
const prefs = loadPrefs();

export const useViz = create<VizState>((set, get) => ({
  scene: initial,
  selectedLayerId: initial.layers[initial.layers.length - 1]?.id ?? null,
  fullscreen: false,
  panelPos: { x: -1, y: -1 }, // -1 = use CSS default until first drag
  panelCollapsed: false,
  renderer: prefs.renderer,
  bloom: prefs.bloom,
  vignette: prefs.vignette,

  selected: () => { const { scene, selectedLayerId } = get(); return scene.layers.find((l) => l.id === selectedLayerId) ?? null; },

  setFullscreen: (on) => set({ fullscreen: on }),
  setAspect: (a) => mutate(set, get, (sc) => { sc.aspect = a; }),
  selectLayer: (id) => set({ selectedLayerId: id }),

  addLayer: (type) => {
    const l = newLayer(type);
    mutate(set, get, (sc) => { sc.layers.push(l); });
    set({ selectedLayerId: l.id });
  },
  removeLayer: (id) => {
    mutate(set, get, (sc) => { sc.layers = sc.layers.filter((l) => l.id !== id); });
    if (get().selectedLayerId === id) set({ selectedLayerId: get().scene.layers.at(-1)?.id ?? null });
  },
  duplicateLayer: (id) => {
    const src = get().scene.layers.find((l) => l.id === id); if (!src) return;
    const copy: Layer = { ...src, id: genId("ly"), name: src.name + " copy", props: { ...src.props }, bind: { ...src.bind } };
    mutate(set, get, (sc) => { const i = sc.layers.findIndex((l) => l.id === id); sc.layers.splice(i + 1, 0, copy); });
    set({ selectedLayerId: copy.id });
  },
  reorderLayer: (id, dir) => mutate(set, get, (sc) => {
    const i = sc.layers.findIndex((l) => l.id === id); const j = i + dir;
    if (i < 0 || j < 0 || j >= sc.layers.length) return;
    const [m] = sc.layers.splice(i, 1); sc.layers.splice(j, 0, m);
  }),
  moveLayerEdge: (id, edge) => mutate(set, get, (sc) => {
    const i = sc.layers.findIndex((l) => l.id === id); if (i < 0) return;
    const [m] = sc.layers.splice(i, 1);
    if (edge === "front") sc.layers.push(m); else sc.layers.unshift(m);
  }),
  toggleVisible: (id) => mutate(set, get, (sc) => { const l = sc.layers.find((x) => x.id === id); if (l) l.visible = !l.visible; }),
  setParent: (id, parent) => mutate(set, get, (sc) => {
    if (id === parent) return;
    // guard against cycles: a node cannot be parented to its own descendant
    let p = parent;
    while (p) { if (p === id) return; p = sc.layers.find((x) => x.id === p)?.parent ?? null; }
    const l = sc.layers.find((x) => x.id === id); if (l) l.parent = parent;
  }),
  updateLayer: (id, patch) => mutate(set, get, (sc) => { const l = sc.layers.find((x) => x.id === id); if (l) Object.assign(l, patch); }),
  setProp: (id, key, value) => mutate(set, get, (sc) => { const l = sc.layers.find((x) => x.id === id); if (l) l.props[key] = value; }),
  setBind: (id, key, bind) => mutate(set, get, (sc) => {
    const l = sc.layers.find((x) => x.id === id); if (!l) return;
    if (bind) l.bind[key] = bind; else delete l.bind[key];
  }),
  applyTemplate: (name) => {
    const t = TEMPLATES.find((x) => x.name === name); if (!t) return;
    const sc = t.build();
    set({ scene: sc, selectedLayerId: sc.layers.at(-1)?.id ?? null });
    persist(sc);
  },
  loadSceneObj: (s) => { set({ scene: s, selectedLayerId: s.layers.at(-1)?.id ?? null }); persist(s); },
  setPanelPos: (x, y) => set({ panelPos: { x, y } }),
  setPanelCollapsed: (c) => set({ panelCollapsed: c }),
  setRenderer: (r) => { set({ renderer: r }); savePrefs(r, get().bloom, get().vignette); },
  setBloom: (v) => { set({ bloom: v }); savePrefs(get().renderer, v, get().vignette); },
  setVignette: (v) => { set({ vignette: v }); savePrefs(get().renderer, get().bloom, v); },
}));

/** Immutably replace the scene via a mutator on a shallow clone, then persist. */
function mutate(set: (p: Partial<VizState>) => void, get: () => VizState, fn: (sc: Scene) => void) {
  const sc: Scene = { ...get().scene, layers: get().scene.layers.map((l) => ({ ...l, props: { ...l.props }, bind: { ...l.bind } })) };
  fn(sc);
  set({ scene: sc });
  persist(sc);
}
function persist(sc: Scene) { try { localStorage.setItem(LS, JSON.stringify(sc)); } catch { /* ignore */ } }

/** Serialize the current scene to a `.wavrviz` JSON string (for export/import in P6). */
export function serializeScene(sc: Scene): string { return JSON.stringify(sc, null, 2); }
