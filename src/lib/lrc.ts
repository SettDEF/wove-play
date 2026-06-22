export interface LrcLine { t: number; text: string; } // t = seconds, or -1 for unsynced

const TAG = /\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g;

/** Parse an .lrc (or plain text) lyric. Synced lines carry their timestamp; plain lines get t=-1. */
export function parseLrc(src: string): LrcLine[] {
  const out: LrcLine[] = [];
  for (const raw of src.split(/\r?\n/)) {
    const tags = [...raw.matchAll(TAG)];
    const text = raw.replace(TAG, "").trim();
    if (tags.length) {
      for (const m of tags) {
        const frac = m[3] ? parseFloat(`0.${m[3]}`) : 0;
        out.push({ t: (+m[1]) * 60 + (+m[2]) + frac, text });
      }
    } else if (text) {
      out.push({ t: -1, text });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

/** Index of the active synced line for a playback position (or -1). */
export function activeLine(lines: LrcLine[], pos: number): number {
  let idx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].t >= 0 && lines[i].t <= pos + 0.05) idx = i; else if (lines[i].t > pos) break;
  }
  return idx;
}
