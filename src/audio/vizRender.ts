import type { Scene, Layer, PropValue } from "@/store/viz";

export interface VizBuffers {
  freq: Uint8Array<ArrayBuffer>;            // byte magnitudes (legacy / cheap paths)
  time: Uint8Array<ArrayBuffer>;            // byte time-domain (waveform)
  ffreq: Float32Array<ArrayBuffer>;         // dB magnitudes (getFloatFrequencyData)
  mag: Float32Array<ArrayBuffer>;           // normalized 0..1 magnitude per bin (derived)
}
export function makeBuffers(): VizBuffers {
  return {
    freq: new Uint8Array(new ArrayBuffer(1024)),
    time: new Uint8Array(new ArrayBuffer(2048)),
    ffreq: new Float32Array(new ArrayBuffer(1024 * 4)),
    mag: new Float32Array(new ArrayBuffer(1024 * 4)),
  };
}

export interface Bands { bass: number; mid: number; treble: number; level: number; }

/** Everything a binding/draw needs from one frame of audio: the named bands (Hz-true), the full
 *  normalized magnitude spectrum, the Nyquist (for Hz→bin), a real RMS loudness, and a per-frame
 *  cache of arbitrary Hz-range energies (P1). */
export interface AudioField {
  bands: Bands;
  mag: Float32Array;   // normalized 0..1 per bin
  bins: number;
  nyquist: number;
  rangeCache: Map<string, number>;
}

interface Particle { x: number; y: number; vx: number; vy: number; size: number; life: number; }
interface LayerState { particles: Particle[]; sm?: Float32Array; pk?: Float32Array; }
export type StateMap = Map<string, LayerState>;
export function makeStateMap(): StateMap { return new Map(); }

// ── prop accessors ─────────────────────────────────────────────────────────────
const N = (o: Record<string, PropValue>, k: string, d = 0) => (typeof o[k] === "number" ? (o[k] as number) : d);
const S = (o: Record<string, PropValue>, k: string, d = "") => (typeof o[k] === "string" ? (o[k] as string) : d);
const B = (o: Record<string, PropValue>, k: string, d = false) => (typeof o[k] === "boolean" ? (o[k] as boolean) : d);

function paint(ctx: CanvasRenderingContext2D, wp: Record<string, PropValue>, h: number) {
  if (B(wp, "useGradient")) {
    const g = ctx.createLinearGradient(0, h, 0, 0);
    g.addColorStop(0, S(wp, "color1", "#fff"));
    g.addColorStop(1, S(wp, "color2", "#fff"));
    return g;
  }
  return S(wp, "color1", "#fff");
}

function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  roundRectPath(ctx, x, y, w, h, r); ctx.fill();
}

/** Perceptual (log-ish) bucketed magnitudes (0..1) from the normalized spectrum, for bar drawing.
 *  Reuses `out` to avoid per-frame allocation. */
export function buckets(mag: Float32Array, n: number, sens: number, log = false, out?: number[]): number[] {
  const arr = out && out.length === n ? out : new Array<number>(n);
  const usable = Math.max(2, Math.floor(mag.length * 0.72));
  for (let b = 0; b < n; b++) {
    let i0: number, i1: number;
    if (log) { // true log-frequency spacing (Avee "pro" look)
      i0 = Math.floor(Math.pow(usable, b / n));
      i1 = Math.min(usable, Math.max(i0 + 1, Math.floor(Math.pow(usable, (b + 1) / n))));
    } else {   // perceptual-ish power curve
      i0 = Math.floor(Math.pow(b / n, 1.6) * usable);
      i1 = Math.min(usable, Math.max(i0 + 1, Math.floor(Math.pow((b + 1) / n, 1.6) * usable)));
    }
    let max = 0;
    for (let i = i0; i < i1; i++) if (mag[i] > max) max = mag[i];
    arr[b] = Math.min(1, max * sens);
  }
  return arr;
}

/** Per-layer temporal smoothing of the buckets (EMA), dt-corrected so the feel is identical at any
 *  refresh rate. `smoothing` is the 60 fps per-frame retain factor (0 = none). Replaces the old
 *  per-frame writes to the SHARED analyser node (which made layers + the EQ panel fight). */
export function smoothBuckets(field: AudioField, n: number, sens: number, smoothing: number, dt: number, st: { sm?: Float32Array }, log = false): number[] {
  const raw = buckets(field.mag, n, sens, log);
  if (smoothing <= 0) return raw;
  let sm = st.sm;
  if (!sm || sm.length !== n) { sm = new Float32Array(raw); st.sm = sm; return Array.from(sm) as number[]; }
  const a = Math.pow(Math.min(0.999, smoothing), dt * 60);
  for (let i = 0; i < n; i++) { sm[i] = sm[i] * a + raw[i] * (1 - a); raw[i] = sm[i]; }
  return raw;
}

/** Average normalized energy in an arbitrary Hz window, cached per-frame (P1). */
export function rangeEnergy(field: AudioField, lo: number, hi: number): number {
  if (field.nyquist <= 0) return 0;
  const key = `${lo}|${hi}`;
  const c = field.rangeCache.get(key);
  if (c !== undefined) return c;
  const i0 = Math.max(0, Math.floor((lo / field.nyquist) * field.bins));
  const i1 = Math.min(field.bins, Math.max(i0 + 1, Math.ceil((hi / field.nyquist) * field.bins)));
  let s = 0;
  for (let i = i0; i < i1; i++) s += field.mag[i];
  const v = s / Math.max(1, i1 - i0);
  field.rangeCache.set(key, v);
  return v;
}

const ZERO_FIELD: AudioField = { bands: { bass: 0, mid: 0, treble: 0, level: 0 }, mag: new Float32Array(1), bins: 1, nyquist: 24000, rangeCache: new Map() };

/** One frame of audio → AudioField. Uses FLOAT magnitudes (no double-smoothing), Hz-TRUE named
 *  bands, and a real time-domain RMS for `level`. */
export function analyzeField(analyser: AnalyserNode | null, buf: VizBuffers): AudioField {
  if (!analyser) return ZERO_FIELD;
  const bins = analyser.frequencyBinCount;
  analyser.getFloatFrequencyData(buf.ffreq);
  const minDb = analyser.minDecibels, span = Math.max(1, analyser.maxDecibels - minDb);
  const mag = buf.mag;
  for (let i = 0; i < bins; i++) mag[i] = Math.max(0, Math.min(1, (buf.ffreq[i] - minDb) / span));
  const nyquist = analyser.context.sampleRate / 2;
  const field: AudioField = { bands: { bass: 0, mid: 0, treble: 0, level: 0 }, mag, bins, nyquist, rangeCache: new Map() };
  // Hz-true named bands (fixes the old bin-percentage mislabeling).
  field.bands.bass = rangeEnergy(field, 20, 150);
  field.bands.mid = rangeEnergy(field, 400, 2000);
  field.bands.treble = rangeEnergy(field, 4000, 12000);
  // real loudness from the time domain (RMS), not a bass-weighted bin average.
  analyser.getByteTimeDomainData(buf.time);
  let sum = 0; const tn = buf.time.length;
  for (let i = 0; i < tn; i++) { const v = (buf.time[i] - 128) / 128; sum += v * v; }
  field.bands.level = Math.min(1, Math.sqrt(sum / tn) * 1.8);
  return field;
}

// ── scene graph: matrices + audio-bound transforms ───────────────────────────────
const TRANSFORM_KEYS = new Set(["x", "y", "scale", "rotation", "opacity"]);
/** 2×3 affine [a,b,c,d,e,f]: x' = a·x + c·y + e, y' = b·x + d·y + f. */
export type Mat = [number, number, number, number, number, number];
const IDENT: Mat = [1, 0, 0, 1, 0, 0];
/** mul(A,B) = apply B then A. */
function mul(A: Mat, B: Mat): Mat {
  return [
    A[0] * B[0] + A[2] * B[1], A[1] * B[0] + A[3] * B[1],
    A[0] * B[2] + A[2] * B[3], A[1] * B[2] + A[3] * B[3],
    A[0] * B[4] + A[2] * B[5] + A[4], A[1] * B[4] + A[3] * B[5] + A[5],
  ];
}
/** Local transform of a node: translate(center+offset) · rotate · scale · translate(-center). */
function localMatrix(x: number, y: number, s: number, rotDeg: number, w: number, h: number): Mat {
  const cx = w / 2, cy = h / 2, rad = (rotDeg * Math.PI) / 180, co = Math.cos(rad), si = Math.sin(rad);
  const T1: Mat = [1, 0, 0, 1, cx + x * w, cy + y * h];
  const RS: Mat = [co * s, si * s, -si * s, co * s, 0, 0];
  const T0: Mat = [1, 0, 0, 1, -cx, -cy];
  return mul(mul(T1, RS), T0);
}

/** Per-frame audio-bind memory (envelope state / running averages), keyed by `${layerId}:${prop}`.
 *  Reserved keys `__t` (last frame timestamp) and `__n` (layer count, for pruning) also live here. */
export type BindMem = Map<string, number>;
interface BindCfg { source: keyof Bands; amount: number; mode?: "continuous" | "beat"; curve?: number; attack?: number; release?: number; smoothing?: number; min?: number; max?: number; freqLo?: number; freqHi?: number }
/** Evaluate a binding's contribution with (Hz range OR named band) · curve · beat-trigger ·
 *  dt-based attack/release envelope · clamp. `dt` is the real frame delta in seconds, so the feel
 *  is identical at 60 vs 144 Hz (stored 0..0.95 values stay the 60fps-equivalent). */
export function bindAdd(field: AudioField, bind: BindCfg, mem: BindMem, key: string, dt: number): number {
  let a = (bind.freqLo !== undefined && bind.freqHi !== undefined && bind.freqHi > bind.freqLo)
    ? rangeEnergy(field, bind.freqLo, bind.freqHi)
    : (field.bands[bind.source] ?? 0);
  if (bind.curve && bind.curve !== 1) a = Math.pow(Math.max(0, a), bind.curve);

  const dt60 = dt * 60;
  // beat trigger (P6): adaptive threshold = running mean + k·stddev over a ~1s window, with a
  // refractory lockout so one transient fires once. Stats use the PREVIOUS sample's history.
  if (bind.mode === "beat") {
    const mk = key + ":avg", sk = key + ":sq", rk = key + ":refr";
    const c = Math.pow(0.92, dt60);               // ~1s EMA window (dt-correct)
    const mean = mem.get(mk) ?? a;
    const meanSq = mem.get(sk) ?? a * a;
    const std = Math.sqrt(Math.max(0, meanSq - mean * mean));
    mem.set(mk, mean * c + a * (1 - c));
    mem.set(sk, meanSq * c + a * a * (1 - c));
    let refr = (mem.get(rk) ?? 0) - dt;           // count down the lockout
    const fired = a > mean + 1.6 * std && a > 0.1 && refr <= 0;
    if (fired) refr = 0.12;                        // 120 ms refractory period
    mem.set(rk, Math.max(0, refr));
    a = fired ? 1 : 0;
  }

  // attack/release envelope (fast rise / slow fall feel) — coefficients are dt-corrected retains
  const prev = mem.get(key) ?? 0;
  const atk = bind.attack ?? 0;
  const rel = bind.release ?? bind.smoothing ?? 0;
  let v: number;
  if (a >= prev) v = atk > 0 ? prev * Math.pow(atk, dt60) + a * (1 - Math.pow(atk, dt60)) : a;
  else v = rel > 0 ? Math.max(a, prev * Math.pow(rel, dt60)) : a;
  mem.set(key, v);

  let out = v * bind.amount;
  if (bind.min !== undefined) out = Math.max(bind.min, out);
  if (bind.max !== undefined) out = Math.min(bind.max, out);
  return out;
}

/** Frame delta (seconds) tracked inside the bind memory; clamped so a backgrounded tab can't jump. */
export function frameDt(mem: BindMem): number {
  const now = typeof performance !== "undefined" ? performance.now() : 0;
  const last = mem.get("__t");
  mem.set("__t", now);
  if (last === undefined) return 1 / 60;
  return Math.min(1 / 15, Math.max(1 / 240, (now - last) / 1000));
}

/** Drop envelope/beat state for layers that no longer exist (only when the layer count changes). */
export function pruneMem(mem: BindMem, scene: Scene) {
  if (mem.get("__n") === scene.layers.length) return;
  const ids = new Set(scene.layers.map((l) => l.id));
  for (const k of mem.keys()) {
    if (k === "__t" || k === "__n") continue;
    const id = k.slice(0, k.indexOf(":"));
    if (id && !ids.has(id)) mem.delete(k);
  }
  mem.set("__n", scene.layers.length);
}

// ── hue rotation (P3 color reactivity) ──────────────────────────────────────────
function hexToRgb(hex: string): [number, number, number] {
  let h = hex.replace("#", "");
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const n = parseInt(h || "ffffff", 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const toHex = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
/** Rotate a hex color's hue by `deg`, preserving sat/lightness — cheap CPU path so BOTH renderers
 *  get identical "color pumps with the music". */
export function rotateHue(hex: string, deg: number): string {
  if (!deg) return hex;
  const [r, g, b] = hexToRgb(hex);
  const c = Math.cos((deg * Math.PI) / 180), s = Math.sin((deg * Math.PI) / 180);
  // YIQ-style hue rotation matrix
  const m = [
    0.299 + 0.701 * c + 0.168 * s, 0.587 - 0.587 * c + 0.330 * s, 0.114 - 0.114 * c - 0.497 * s,
    0.299 - 0.299 * c - 0.328 * s, 0.587 + 0.413 * c + 0.035 * s, 0.114 - 0.114 * c + 0.292 * s,
    0.299 - 0.300 * c + 1.250 * s, 0.587 - 0.588 * c - 1.050 * s, 0.114 + 0.886 * c - 0.203 * s,
  ];
  return "#" + toHex(r * m[0] + g * m[1] + b * m[2]) + toHex(r * m[3] + g * m[4] + b * m[5]) + toHex(r * m[6] + g * m[7] + b * m[8]);
}
/** If `wp.hue` is set, rotate the layer's colors in place (so every downstream draw/shader sees it). */
export function applyHue(wp: Record<string, PropValue>) {
  const hue = typeof wp.hue === "number" ? (wp.hue as number) : 0;
  if (!hue) return;
  if (typeof wp.color1 === "string") wp.color1 = rotateHue(wp.color1, hue);
  if (typeof wp.color2 === "string") wp.color2 = rotateHue(wp.color2, hue);
}

export interface WorldT { m: Mat; op: number; visible: boolean; }
/** Compose every layer's WORLD transform = parent.world × local (scene graph), applying audio
 *  bindings to each node's local transform/opacity ONCE per frame. */
export function buildTransforms(scene: Scene, w: number, h: number, field: AudioField, mem: BindMem, dt: number): Map<string, WorldT> {
  const byId = new Map(scene.layers.map((l) => [l.id, l]));
  const local = new Map<string, { ml: Mat; op: number }>();
  for (const l of scene.layers) {
    const tb = (key: string): number => { const b = l.bind[key]; return b ? bindAdd(field, b, mem, `${l.id}:${key}`, dt) : 0; };
    const ml = localMatrix(l.x + tb("x"), l.y + tb("y"), l.scale + tb("scale"), l.rotation + tb("rotation"), w, h);
    const op = Math.max(0, Math.min(1, l.opacity + tb("opacity")));
    local.set(l.id, { ml, op });
  }
  const world = new Map<string, WorldT>();
  const wof = (id: string): WorldT => {
    const cached = world.get(id); if (cached) return cached;
    const l = byId.get(id)!; const loc = local.get(id)!;
    let wt: WorldT;
    if (l.parent && byId.has(l.parent)) { const pw = wof(l.parent); wt = { m: mul(pw.m, loc.ml), op: loc.op * pw.op, visible: l.visible && pw.visible }; }
    else wt = { m: loc.ml, op: loc.op, visible: l.visible };
    world.set(id, wt); return wt;
  };
  for (const l of scene.layers) wof(l.id);
  return world;
}

/** Render every visible LEAF (groups are transform-only) bottom→top, with its composed world
 *  transform, blend, opacity and audio bindings. */
export function renderScene(
  ctx: CanvasRenderingContext2D, w: number, h: number,
  scene: Scene, analyser: AnalyserNode | null, buf: VizBuffers, stateMap: StateMap, mem: BindMem,
  text?: { title: string; artist: string; lyric?: string },
) {
  const dt = frameDt(mem);
  pruneMem(mem, scene);
  const field = analyzeField(analyser, buf);
  const world = buildTransforms(scene, w, h, field, mem, dt);
  const hasBg = scene.layers.some((l) => l.visible && l.type === "background");
  if (!hasBg) ctx.clearRect(0, 0, w, h);

  for (const layer of scene.layers) {
    if (layer.type === "group") continue; // composite node: no geometry
    const wt = world.get(layer.id)!;
    if (!wt.visible) continue;
    // leaf prop bindings (transform binds already applied in buildTransforms)
    const wp: Record<string, PropValue> = { ...layer.props };
    for (const key in layer.bind) {
      if (TRANSFORM_KEYS.has(key)) continue;
      const cur = wp[key];
      if (typeof cur === "number") wp[key] = cur + bindAdd(field, layer.bind[key], mem, `${layer.id}:${key}`, dt);
      else if (key === "hue") wp[key] = bindAdd(field, layer.bind[key], mem, `${layer.id}:${key}`, dt); // bindable even if no base
    }
    applyHue(wp); // P3: color reactivity (hue can itself be a bound prop)
    ctx.save();
    ctx.globalAlpha = wt.op;
    ctx.globalCompositeOperation = layer.blend;
    const m = layer.type === "background" ? IDENT : wt.m;
    ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
    drawLayer(ctx, w, h, layer, wp, analyser, buf, field, dt, state(stateMap, layer.id), text);
    ctx.restore();
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

function drawLayer(
  ctx: CanvasRenderingContext2D, w: number, h: number, layer: Layer, wp: Record<string, PropValue>,
  an: AnalyserNode | null, buf: VizBuffers, field: AudioField, dt: number, st: LayerState,
  _text?: { title: string; artist: string; lyric?: string },
) {
  ctx.shadowBlur = N(wp, "glow", 0);
  ctx.shadowColor = S(wp, "color1", "#000");
  switch (layer.type) {
    case "background": drawBackground(ctx, w, h, wp); break;
    case "spectrum": if (an) drawSpectrum(ctx, w, h, wp, field, dt, st); break;
    case "wave": if (an) drawWave(ctx, w, h, wp, an, buf); break;
    case "radial": if (an) drawRadial(ctx, w, h, wp, field, dt, st); break;
    case "particles": drawParticles(ctx, w, h, wp, field.bands, st); break;
    case "image": drawImageLayer(ctx, w, h, wp); break;
    case "text": drawTextLayer(ctx, w, h, wp, _text); break;
    case "shape": drawShapeLayer(ctx, w, h, wp); break;
  }
}

/** Vector shape (rect or circle, outline or filled) — the boxed-logo frame / ring. */
function drawShapeLayer(ctx: CanvasRenderingContext2D, w: number, h: number, wp: Record<string, PropValue>) {
  const bw = Math.max(2, N(wp, "w", 0.5) * w), bh = Math.max(2, N(wp, "h", 0.3) * h);
  const fill = B(wp, "fill", false), stroke = Math.max(1, N(wp, "stroke", 6));
  ctx.shadowBlur = N(wp, "glow", 0); ctx.shadowColor = S(wp, "color1", "#fff");
  ctx.fillStyle = paint(ctx, wp, h); ctx.strokeStyle = paint(ctx, wp, h); ctx.lineWidth = stroke;
  if (S(wp, "shape", "rect") === "circle") {
    const r = Math.min(bw, bh) / 2;
    ctx.beginPath(); ctx.arc(w / 2, h / 2, r, 0, Math.PI * 2);
  } else {
    const r = N(wp, "radius", 0.12) * Math.min(bw, bh);
    roundRectPath(ctx, (w - bw) / 2, (h - bh) / 2, bw, bh, r);
  }
  if (fill) ctx.fill(); else ctx.stroke();
}

function state(map: StateMap, id: string): LayerState {
  let s = map.get(id); if (!s) { s = { particles: [] }; map.set(id, s); } return s;
}

/** Shared image element cache (object/data/SVG URLs). Textures are created per-renderer in glRender. */
const imgCache = new Map<string, HTMLImageElement>();
export function loadImage(src: string): HTMLImageElement | null {
  if (!src) return null;
  let img = imgCache.get(src);
  if (!img) { img = new Image(); img.crossOrigin = "anonymous"; img.src = src; imgCache.set(src, img); }
  return img;
}

function isSvg(src: string) { return /^data:image\/svg/i.test(src) || /\.svg(\?|$)/i.test(src); }
const svgRaster = new Map<string, HTMLCanvasElement | null>(); // SVG → rasterized crisp canvas

/** A canvas-drawable for a src (raster image OR a crisply-rasterized SVG) + its pixel size, or null
 *  while still loading. SVGs are drawn once to a 1024px canvas so they texture correctly and stay sharp. */
export function getDrawable(src: string): { source: HTMLImageElement | HTMLCanvasElement; w: number; h: number } | null {
  const img = loadImage(src);
  if (!img || !img.complete) return null;
  if (isSvg(src)) {
    if (!svgRaster.has(src)) {
      const nw = img.naturalWidth, nh = img.naturalHeight;
      let w = 1024, h = 1024;
      if (nw > 0 && nh > 0) { const s = 1024 / Math.max(nw, nh); w = Math.max(1, Math.round(nw * s)); h = Math.max(1, Math.round(nh * s)); }
      const cv = document.createElement("canvas"); cv.width = w; cv.height = h;
      const c = cv.getContext("2d");
      try { c?.drawImage(img, 0, 0, w, h); svgRaster.set(src, cv); } catch { svgRaster.set(src, null); }
    }
    const cv = svgRaster.get(src);
    return cv ? { source: cv, w: cv.width, h: cv.height } : null;
  }
  if (!img.naturalWidth) return null;
  return { source: img, w: img.naturalWidth, h: img.naturalHeight };
}
/** Resolve a text layer's content from its token (title/artist/custom). */
export function textContent(wp: Record<string, PropValue>, text?: { title: string; artist: string; lyric?: string }): string {
  const token = S(wp, "token", "title");
  if (token === "custom") return S(wp, "custom", "");
  if (token === "artist") return text?.artist || "";
  if (token === "lyric") return text?.lyric || "";
  return text?.title || "";
}

function drawImageLayer(ctx: CanvasRenderingContext2D, w: number, h: number, wp: Record<string, PropValue>) {
  const d = getDrawable(S(wp, "src", ""));
  if (!d) return;
  ctx.shadowBlur = 0;
  if (B(wp, "circle", false)) {
    const sq = Math.min(w, h), x = (w - sq) / 2, y = (h - sq) / 2;
    ctx.save();
    ctx.beginPath(); ctx.arc(w / 2, h / 2, sq / 2, 0, Math.PI * 2); ctx.clip();
    ctx.drawImage(d.source, x, y, sq, sq);
    ctx.restore();
    return;
  }
  const fit = S(wp, "fit", "cover");
  if (fit === "fill") { ctx.drawImage(d.source, 0, 0, w, h); return; }
  const sc = fit === "contain" ? Math.min(w / d.w, h / d.h) : Math.max(w / d.w, h / d.h);
  const dw = d.w * sc, dh = d.h * sc;
  ctx.drawImage(d.source, (w - dw) / 2, (h - dh) / 2, dw, dh);
}

function drawTextLayer(ctx: CanvasRenderingContext2D, w: number, h: number, wp: Record<string, PropValue>, text?: { title: string; artist: string; lyric?: string }) {
  const content = textContent(wp, text);
  if (!content) return;
  const size = Math.max(6, N(wp, "size", 0.09) * h);
  const align = S(wp, "align", "center");
  ctx.fillStyle = S(wp, "color1", "#ffffff");
  ctx.textAlign = align === "left" ? "left" : align === "right" ? "right" : "center";
  ctx.textBaseline = "middle";
  ctx.font = `800 ${size}px Montserrat, Roboto, system-ui, sans-serif`;
  const x = align === "left" ? size * 0.3 : align === "right" ? w - size * 0.3 : w / 2;
  ctx.fillText(content, x, h / 2);
}

function drawBackground(ctx: CanvasRenderingContext2D, w: number, h: number, wp: Record<string, PropValue>) {
  ctx.shadowBlur = 0;
  ctx.fillStyle = paint(ctx, wp, h);
  ctx.fillRect(0, 0, w, h);
}

function drawSpectrum(ctx: CanvasRenderingContext2D, w: number, h: number, wp: Record<string, PropValue>, field: AudioField, dt: number, st: LayerState) {
  const n = Math.max(2, Math.round(N(wp, "count", 64)));
  const logFreq = B(wp, "logFreq", false);
  const mags = smoothBuckets(field, n, N(wp, "sensitivity", 1.3), N(wp, "smoothing", 0.78), dt, st, logFreq);
  const style = S(wp, "style", "bars");
  const gap = N(wp, "gap", 2);
  const rounded = B(wp, "rounded", true);
  const anchor = S(wp, "anchor", "bottom");
  ctx.fillStyle = paint(ctx, wp, h);
  ctx.strokeStyle = paint(ctx, wp, h);

  const yFor = (bh: number) => anchor === "top" ? 0 : anchor === "center" ? h / 2 - bh / 2 : h - bh;

  if (style === "line" || style === "area") {
    ctx.lineWidth = Math.max(1, N(wp, "thickness", 2));
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = (i + 0.5) / n * w;
      const y = h - mags[i] * mags[i] * h;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    if (style === "area") { ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath(); ctx.fill(); }
    else ctx.stroke();
    return;
  }

  // falling peak caps (Avee staple) — held maxima that decay over time
  const peakHold = B(wp, "peakHold", false);
  let pk: Float32Array | null = null;
  if (peakHold) {
    if (!st.pk || st.pk.length !== n) st.pk = new Float32Array(n);
    pk = st.pk;
    const decay = Math.pow(0.90, dt * 60);
    for (let i = 0; i < n; i++) pk[i] = Math.max(mags[i], pk[i] * decay);
  }

  // bars / mirror
  const mirror = style === "mirror";
  if (mirror) {
    const half = Math.max(1, Math.floor(n / 2));
    const bw = (w / 2 - gap * half) / half;
    for (let i = 0; i < half; i++) {
      const bh = Math.max(2, mags[i] * mags[i] * h);
      const y = yFor(bh);
      const r = rounded ? Math.min(bw / 2, 4) : 0;
      roundRect(ctx, w / 2 + i * (bw + gap), y, bw, bh, r);
      roundRect(ctx, w / 2 - (i + 1) * (bw + gap), y, bw, bh, r);
      if (pk) { const ph = pk[i] * pk[i] * h; ctx.fillRect(w / 2 + i * (bw + gap), yFor(ph) - 1, bw, 2); ctx.fillRect(w / 2 - (i + 1) * (bw + gap), yFor(ph) - 1, bw, 2); }
    }
  } else {
    const bw = (w - gap * (n - 1)) / n;
    for (let i = 0; i < n; i++) {
      const bh = Math.max(2, mags[i] * mags[i] * h);
      const r = rounded ? Math.min(bw / 2, 4) : 0;
      roundRect(ctx, i * (bw + gap), yFor(bh), bw, bh, r);
      if (pk) { const ph = pk[i] * pk[i] * h; ctx.fillRect(i * (bw + gap), yFor(ph) - 1, bw, 2); }
    }
  }
}

function drawWave(ctx: CanvasRenderingContext2D, w: number, h: number, wp: Record<string, PropValue>, an: AnalyserNode, buf: VizBuffers) {
  an.getByteTimeDomainData(buf.time);
  ctx.lineWidth = N(wp, "lineWidth", 3);
  ctx.strokeStyle = paint(ctx, wp, h);
  ctx.beginPath();
  const n = buf.time.length, amp = N(wp, "sensitivity", 1);
  for (let i = 0; i < n; i++) {
    const x = (i / n) * w;
    const y = h / 2 + ((buf.time[i] - 128) / 128) * (h / 2) * amp;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.stroke();
}

function drawRadial(ctx: CanvasRenderingContext2D, w: number, h: number, wp: Record<string, PropValue>, field: AudioField, dt: number, st: LayerState) {
  const n = Math.max(2, Math.round(N(wp, "count", 96)));
  const mags = smoothBuckets(field, n, N(wp, "sensitivity", 1.3), N(wp, "smoothing", 0.8), dt, st, B(wp, "logFreq", false));
  const cx = w / 2, cy = h / 2;
  const radius = Math.min(w, h) * N(wp, "radius", 0.22);
  ctx.lineWidth = Math.max(2, N(wp, "lineWidth", 3));
  ctx.strokeStyle = paint(ctx, wp, h);
  ctx.lineCap = "round";
  for (let i = 0; i < n; i++) {
    const ang = (i / n) * Math.PI * 2 - Math.PI / 2;
    const len = radius + mags[i] * mags[i] * Math.min(w, h) * 0.3;
    const c = Math.cos(ang), s = Math.sin(ang);
    ctx.beginPath();
    ctx.moveTo(cx + c * radius, cy + s * radius);
    ctx.lineTo(cx + c * len, cy + s * len);
    ctx.stroke();
  }
}

function drawParticles(ctx: CanvasRenderingContext2D, w: number, h: number, wp: Record<string, PropValue>, bands: Bands, st: LayerState) {
  const sens = N(wp, "sensitivity", 1.4);
  const cap = Math.max(10, Math.round(N(wp, "count", 220)));
  const baseSize = N(wp, "size", 3);
  const gravity = N(wp, "gravity", 1);
  const spread = N(wp, "spread", 1);
  const energy = bands.bass * sens;
  const center = S(wp, "origin", "bottom") === "center";
  const spawn = Math.floor(energy * 6);
  for (let i = 0; i < spawn && st.particles.length < cap; i++) {
    if (center) {
      const a = Math.random() * Math.PI * 2, spd = (1.5 + energy * 5) * (0.5 + spread);
      st.particles.push({ x: w / 2, y: h / 2, vx: Math.cos(a) * spd, vy: Math.sin(a) * spd, size: baseSize * (0.5 + Math.random()), life: 1 });
    } else {
      st.particles.push({ x: Math.random() * w, y: h + 4, vx: (Math.random() - 0.5) * spread * 2, vy: -(1 + energy * 6 + Math.random() * 2), size: baseSize * (0.5 + Math.random()), life: 1 });
    }
  }
  ctx.fillStyle = paint(ctx, wp, h);
  for (const p of st.particles) {
    p.x += p.vx; p.y += p.vy; if (!center) p.vy += gravity * 0.02; p.life -= 0.006;
    ctx.globalAlpha = Math.max(0, p.life);
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  st.particles = st.particles.filter((p) => p.life > 0);
}
