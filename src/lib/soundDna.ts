/**
 * Sound DNA — a unique, DETERMINISTIC "fingerprint" glyph per track. Same track id → same glyph,
 * always (no storage needed). Reads like a radial spectrum: a ring of bars whose amplitudes come
 * from a few seeded harmonic peaks + noise, hue-cycled from a per-track base. The library becomes
 * a gallery where you recognise songs by SHAPE before reading the name; it's also the cover
 * fallback for art-less tracks. (Later it can be fed the real cached analysis instead of the id.)
 */

function hashStr(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
/** Tiny deterministic PRNG (mulberry32). */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The deterministic base hue (0–359) for a track's Sound DNA — same value the glyph uses, so the
 *  app's tonal theme matches the glyph the user sees for art-less tracks. */
export function dnaHue(id: string): number {
  return Math.floor(mulberry32(hashStr(id || "?"))() * 360);
}

/** Render a track's Sound-DNA glyph into a 2D context sized w×h (already DPR-scaled by the caller). */
export function drawDna(ctx: CanvasRenderingContext2D, w: number, h: number, id: string) {
  ctx.clearRect(0, 0, w, h);
  const rnd = mulberry32(hashStr(id || "?"));
  const cx = w / 2, cy = h / 2;
  const R = Math.min(w, h) * 0.5;
  const baseHue = Math.floor(rnd() * 360);
  const inner = R * 0.28;
  const bars = 40 + Math.floor(rnd() * 56);          // "resolution" of the fingerprint
  const peaks = 2 + Math.floor(rnd() * 4);            // harmonic peaks = the song's character
  const peakW = 0.04 + rnd() * 0.11;
  const peakPos = Array.from({ length: peaks }, () => rnd());
  const peakH = Array.from({ length: peaks }, () => 0.5 + rnd() * 0.5);

  // soft tonal backing so it reads as art, not a sticker — fills the whole tile (edge-to-edge)
  const bg = ctx.createRadialGradient(cx, cy, inner * 0.3, cx, cy, R * 1.4);
  bg.addColorStop(0, `hsl(${baseHue} 40% 15%)`);
  bg.addColorStop(1, `hsl(${(baseHue + 40) % 360} 34% 7%)`);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  ctx.lineCap = "round";
  const noise: number[] = Array.from({ length: bars }, () => 0.1 + rnd() * 0.12);
  for (let i = 0; i < bars; i++) {
    const t = i / bars;
    let amp = noise[i];
    for (let p = 0; p < peaks; p++) {
      const d = Math.min(Math.abs(t - peakPos[p]), 1 - Math.abs(t - peakPos[p])); // wrap-around distance
      amp += Math.exp(-(d * d) / (2 * peakW * peakW)) * peakH[p];
    }
    amp = Math.min(1, amp);
    const ang = t * Math.PI * 2 - Math.PI / 2;
    const len = inner + amp * (R - inner) * 0.95;
    const c = Math.cos(ang), s = Math.sin(ang);
    const hue = (baseHue + t * 130) % 360;
    ctx.strokeStyle = `hsl(${hue} 72% ${46 + amp * 26}%)`;
    ctx.lineWidth = Math.max(1.1, (R / bars) * 1.5);
    ctx.beginPath();
    ctx.moveTo(cx + c * inner, cy + s * inner);
    ctx.lineTo(cx + c * len, cy + s * len);
    ctx.stroke();
  }

  // a small bright core = the downbeat / centre of the fingerprint
  ctx.fillStyle = `hsl(${baseHue} 64% 64%)`;
  ctx.beginPath(); ctx.arc(cx, cy, inner * 0.46, 0, Math.PI * 2); ctx.fill();
}
