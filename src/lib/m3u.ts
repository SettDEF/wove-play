import type { Track } from "./types";

/** Serialize tracks to extended M3U (#EXTM3U + #EXTINF lines). */
export function toM3u(tracks: Track[]): string {
  let out = "#EXTM3U\n";
  for (const t of tracks) {
    const dur = t.duration ? Math.round(t.duration) : -1;
    out += `#EXTINF:${dur},${t.artist} - ${t.title}\n${t.path}\n`;
  }
  return out;
}

export interface M3uEntry { path: string; title?: string; artist?: string; }

/** Parse an (extended) M3U playlist into path + optional artist/title from #EXTINF. */
export function parseM3u(text: string): M3uEntry[] {
  const out: M3uEntry[] = [];
  let pending: { title?: string; artist?: string } = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#EXTINF:")) {
      const m = line.slice(8).match(/^-?\d+\s*,\s*(.*)$/);
      if (m) {
        const label = m[1];
        const dash = label.indexOf(" - ");
        pending = dash > 0 ? { artist: label.slice(0, dash).trim(), title: label.slice(dash + 3).trim() } : { title: label.trim() };
      }
      continue;
    }
    if (line.startsWith("#")) continue;
    out.push({ path: line, ...pending });
    pending = {};
  }
  return out;
}

/** Match imported entries against the existing library by path; fall back to a filename-derived track. */
export function entriesToTracks(entries: M3uEntry[], byPath: Map<string, Track>): Track[] {
  return entries.map((e) => {
    const hit = byPath.get(e.path);
    if (hit) return hit;
    const base = (e.path.split(/[\\/]/).pop() || e.path).replace(/\.[^.]+$/, "");
    return {
      id: e.path, path: e.path,
      title: e.title || base,
      artist: e.artist || "Unknown artist",
      album: "Imported",
      duration: 0,
    } as Track;
  });
}
