/** Shared M3 tonal-ramp math, used by both the manual accent theme and album-art dynamic color. */

export function hslToHex(h: number, s: number, l: number): string {
  s /= 100; l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const to = (x: number) => Math.round(255 * x).toString(16).padStart(2, "0");
  return `#${to(f(0))}${to(f(8))}${to(f(4))}`;
}

export function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return [h, s * 100, l * 100];
}

export function hexToHsl(hex: string): [number, number, number] {
  const m = hex.replace("#", "");
  const v = m.length === 3 ? m.split("").map((c) => c + c).join("") : m;
  const r = parseInt(v.slice(0, 2), 16), g = parseInt(v.slice(2, 4), 16), b = parseInt(v.slice(4, 6), 16);
  return rgbToHsl(r, g, b);
}

/** Derive an M3 primary/secondary/tertiary ramp from a hue+saturation and write it to :root.
 *  Dark themes use light tones on dark containers; light themes invert the polarity. */
export function setPrimaryRamp(h: number, s: number, isDark = true): void {
  const root = document.documentElement.style;
  const sat = Math.min(s, 80);
  const h2 = (h + 60) % 360;
  if (isDark) {
    root.setProperty("--md-primary", hslToHex(h, sat, 78));
    root.setProperty("--md-on-primary", hslToHex(h, sat, 18));
    root.setProperty("--md-primary-container", hslToHex(h, Math.min(sat, 60), 30));
    root.setProperty("--md-on-primary-container", hslToHex(h, sat, 90));
    root.setProperty("--md-secondary", hslToHex(h, sat * 0.35, 74));
    root.setProperty("--md-secondary-container", hslToHex(h, sat * 0.4, 26));
    root.setProperty("--md-on-secondary-container", hslToHex(h, sat * 0.5, 88));
    root.setProperty("--md-tertiary", hslToHex(h2, sat * 0.6, 76));
    root.setProperty("--md-surface-tint", hslToHex(h, sat, 78));
  } else {
    root.setProperty("--md-primary", hslToHex(h, Math.min(sat, 70), 38));
    root.setProperty("--md-on-primary", hslToHex(h, sat, 99));
    root.setProperty("--md-primary-container", hslToHex(h, Math.min(sat, 55), 86));
    root.setProperty("--md-on-primary-container", hslToHex(h, sat, 12));
    root.setProperty("--md-secondary", hslToHex(h, sat * 0.35, 40));
    root.setProperty("--md-secondary-container", hslToHex(h, sat * 0.35, 86));
    root.setProperty("--md-on-secondary-container", hslToHex(h, sat * 0.5, 14));
    root.setProperty("--md-tertiary", hslToHex(h2, sat * 0.5, 40));
    root.setProperty("--md-surface-tint", hslToHex(h, sat, 40));
  }
}
