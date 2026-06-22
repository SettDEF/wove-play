/**
 * Material-You dynamic color: sample the dominant *vibrant* color from the current
 * track's album art and derive an M3 tonal ramp. When there's no art (or it's disabled),
 * we fall back to the manual accent theme rather than wiping it.
 */
import { rgbToHsl, setPrimaryRamp } from "./color";
import { useTheme } from "@/store/theme";
import { dnaHue } from "@/lib/soundDna";

/** Pick the most "vibrant" hue/sat from an image (saturation-weighted histogram). */
function vibrantHue(data: Uint8ClampedArray): { h: number; s: number } | null {
  const bins = 36;                 // 10° hue buckets
  const wsum = new Float64Array(bins);
  const hsum = new Float64Array(bins);
  const ssum = new Float64Array(bins);
  let total = 0;
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a < 8) continue;
    const [h, s, l] = rgbToHsl(data[i], data[i + 1], data[i + 2]);
    if (l < 12 || l > 92) continue;            // skip near-black / near-white
    const w = (s / 100) * (s / 100) * (1 - Math.abs(l - 55) / 55); // favour saturated mid-tones
    if (w <= 0) continue;
    const b = Math.min(bins - 1, Math.floor(h / 10));
    wsum[b] += w; hsum[b] += h * w; ssum[b] += s * w; total += w;
  }
  if (total <= 0) return null;
  let best = 0;
  for (let b = 1; b < bins; b++) if (wsum[b] > wsum[best]) best = b;
  if (wsum[best] <= 0) return null;
  return { h: hsum[best] / wsum[best], s: Math.max(35, Math.min(95, ssum[best] / wsum[best])) };
}

let lastKey = "";
// Remember each track's extracted accent so replays / skip-backs apply instantly without re-decoding
// the cover image (the only non-trivial cost here). Bounded; keyed by track id.
const colorCache = new Map<string, { h: number; s: number }>();

/** Apply a hue/sat as the M3 ramp (dark-aware), deduped so identical colors don't re-animate. */
function applyHs(h: number, s: number): void {
  const dark = useTheme.getState().isDark();
  const key = `${Math.round(h)}:${Math.round(s)}:${dark ? 1 : 0}`;
  if (key === lastKey) return;
  lastKey = key;
  animateRamp(h, s, dark);
}

// ── smooth crossfade between track colors ──────────────────────────────────────────────────
// The accent doesn't SNAP between songs — it eases from the current hue to the next over ~450ms,
// so the whole UI tints over like a slow dissolve. Pure JS rAF (CSS can't transition the M3 vars).
let displayed: { h: number; s: number } | null = null;
let raf = 0;
function hueLerp(a: number, b: number, t: number): number {
  const d = ((b - a + 540) % 360) - 180; // shortest signed delta, [-180,180]
  return (a + d * t + 360) % 360;
}
function animateRamp(h: number, s: number, dark: boolean): void {
  if (!displayed) { displayed = { h, s }; setPrimaryRamp(h, s, dark); return; } // first paint → snap
  if (raf) { cancelAnimationFrame(raf); raf = 0; }
  // Reduced-motion / eco (battery / dynamic governor) → SNAP. Rewriting the M3 vars cascades to an
  // app-wide style recalc, so a 450ms 60fps loop is exactly the wrong thing on a struggling device.
  const root = typeof document !== "undefined" ? document.documentElement : null;
  if (root && (root.dataset.anim === "off" || root.dataset.perf === "eco")) { displayed = { h, s }; setPrimaryRamp(h, s, dark); return; }
  const from = { ...displayed };
  const start = performance.now();
  const DUR = 450;
  let lastApply = 0;
  const step = (now: number) => {
    const t = Math.min(1, (now - start) / DUR);
    // Throttle to ~30fps: each apply forces an app-wide style recalc, so 60fps competes with the cover +
    // audio crossfade during a track change. 30fps is visually identical for a slow colour dissolve.
    if (t < 1 && now - lastApply < 28) { raf = requestAnimationFrame(step); return; }
    lastApply = now;
    const e = t * t * (3 - 2 * t); // smoothstep
    const h2 = hueLerp(from.h, h, e);
    const s2 = from.s + (s - from.s) * e;
    displayed = { h: h2, s: s2 };
    setPrimaryRamp(h2, s2, dark);
    raf = t < 1 ? requestAnimationFrame(step) : 0;
  };
  raf = requestAnimationFrame(step);
}

/** Apply dynamic color from an album-art data URL; if there's no usable art color, fall back to the
 *  track's deterministic Sound-DNA hue (so the accent always reflects the song). */
export function applyDynamicColor(dataUrl: string | null | undefined, fallbackId?: string): void {
  if (!dataUrl) { if (fallbackId) applyDnaColor(fallbackId); else clearDynamicColor(); return; }
  // Already extracted this track's color → apply instantly, skip the image decode entirely.
  if (fallbackId) { const c = colorCache.get(fallbackId); if (c) { applyHs(c.h, c.s); return; } }
  const img = new Image();
  img.decoding = "async";
  img.onload = () => {
    try {
      const N = 48;
      const cv = document.createElement("canvas"); cv.width = N; cv.height = N;
      const ctx = cv.getContext("2d", { willReadFrequently: true });
      if (!ctx) return;
      ctx.drawImage(img, 0, 0, N, N);
      const { data } = ctx.getImageData(0, 0, N, N);
      const v = vibrantHue(data);
      if (!v) { if (fallbackId) applyDnaColor(fallbackId); else clearDynamicColor(); return; }
      if (fallbackId) { if (colorCache.size > 600) colorCache.clear(); colorCache.set(fallbackId, v); }
      applyHs(v.h, v.s);
    } catch { if (fallbackId) applyDnaColor(fallbackId); /* else leave current theme */ }
  };
  img.src = dataUrl;
}

/** Theme from a track's Sound-DNA hue (art-less tracks) — matches the glyph the user sees. */
export function applyDnaColor(id: string): void {
  const dark = useTheme.getState().isDark();
  const h = dnaHue(id), s = 68;
  const key = `dna:${h}:${dark ? 1 : 0}`;
  if (key === lastKey) return;
  lastKey = key;
  animateRamp(h, s, dark);
}

/** Restore the manual accent theme (used when dynamic color is off). Resets the crossfade origin. */
export function clearDynamicColor(): void {
  lastKey = "";
  displayed = null;
  if (raf) { cancelAnimationFrame(raf); raf = 0; }
  useTheme.getState().apply();
}

const PREF = "wavrplay-dyncolor";
export function dynamicColorEnabled(): boolean {
  try { return localStorage.getItem(PREF) !== "0"; } catch { return true; }
}
export function setDynamicColorEnabled(on: boolean): void {
  try { localStorage.setItem(PREF, on ? "1" : "0"); } catch { /* ignore */ }
  if (!on) clearDynamicColor();
}
