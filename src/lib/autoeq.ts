/**
 * AutoEq import. The community AutoEq project ships per-headphone correction curves as
 * "ParametricEQ.txt" files (preamp + a list of biquad filters). Wove's 10-band parametric EQ
 * can apply them directly → instant audiophile-grade headphone correction that Poweramp lacks.
 *
 * File format:
 *   Preamp: -6.8 dB
 *   Filter 1: ON PK Fc 105 Hz Gain 5.5 dB Q 0.70
 *   Filter 2: ON LSC Fc 105 Hz Gain 5.5 dB Q 0.70
 *   ...
 * Types: PK = peaking, LSC/LS = low shelf, HSC/HS = high shelf. (Our engine is all-peaking, so
 * shelves are applied as an approximation — most correction energy is in the PK bands + preamp.)
 */
export interface AutoEqFilter { type: string; fc: number; gain: number; q: number }
export interface AutoEqResult { preamp: number; filters: AutoEqFilter[]; hasShelf: boolean }

export function parseAutoEq(text: string): AutoEqResult {
  let preamp = 0;
  const filters: AutoEqFilter[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const pre = line.match(/^Preamp:\s*(-?\d+(?:\.\d+)?)\s*dB/i);
    if (pre) { preamp = parseFloat(pre[1]); continue; }
    const m = line.match(/^Filter\s+\d+:\s*(ON|OFF)\s+(\w+)\s+Fc\s+([\d.]+)\s*Hz\s+Gain\s+(-?[\d.]+)\s*dB\s+Q\s+([\d.]+)/i);
    if (m && m[1].toUpperCase() === "ON") {
      filters.push({ type: m[2].toUpperCase(), fc: parseFloat(m[3]), gain: parseFloat(m[4]), q: parseFloat(m[5]) });
    }
  }
  if (filters.length === 0) throw new Error("No filters found — pick a headphone's AutoEq “ParametricEQ.txt”.");
  return { preamp, filters, hasShelf: filters.some((f) => f.type.startsWith("LS") || f.type.startsWith("HS")) };
}

/** Derive a friendly preset name from an AutoEq filename ("Sennheiser HD 600 ParametricEQ.txt"). */
export function headphoneName(filename: string): string {
  return filename
    .replace(/\.[^.]+$/, "")
    .replace(/\s*Parametric ?EQ\s*$/i, "")
    .replace(/\s*GraphicEQ\s*$/i, "")
    .trim() || "AutoEq";
}
