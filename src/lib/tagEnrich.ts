import type { Track } from "./types";
import { cachedAnalysis, analyzeTrackNative, writeTags, cacheSave, hasTauri } from "./backend";
import { usePlayer } from "@/store/player";
import { useSettings } from "@/store/settings";

const titleCase = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase());
const empty = (v: unknown) =>
  v === undefined || v === null || v === "" || /^unknown( artist| album)?$/i.test(String(v));

/** ONLINE lookup via MusicBrainz recording search (no API key; CORS-enabled GET). Returns canonical
 *  album/year/title/artist for a confident match. Sends the artist+title query to musicbrainz.org —
 *  only called when the user has enabled online tagging. Best-effort: any failure returns {}. */
export async function mbLookup(artist: string, title: string): Promise<Partial<Track>> {
  const q = `recording:"${title.replace(/"/g, "")}" AND artist:"${artist.replace(/"/g, "")}"`;
  const url = `https://musicbrainz.org/ws/2/recording?query=${encodeURIComponent(q)}&fmt=json&limit=1`;
  try {
    const r = await fetch(url, { headers: { Accept: "application/json" } });
    if (!r.ok) return {};
    const j = await r.json();
    const rec = j.recordings?.[0];
    if (!rec || (rec.score ?? 0) < 90) return {}; // confident matches only — never guess
    const rel = rec.releases?.[0];
    const patch: Partial<Track> = {};
    if (rec.title) patch.title = rec.title;
    if (rec["artist-credit"]?.[0]?.name) patch.artist = rec["artist-credit"][0].name;
    if (rel?.title) patch.album = rel.title;
    const date: string | undefined = rel?.date || rec["first-release-date"];
    const yr = date ? parseInt(date.slice(0, 4), 10) : NaN;
    if (Number.isFinite(yr)) patch.year = yr;
    return patch;
  } catch {
    return {};
  }
}

/** Build a tag patch for a track: on-device analysis (genre) always; optional online metadata. By default
 *  only fills EMPTY fields so it never clobbers good existing tags (pass `overwrite` to force). */
export async function enrichPatch(
  track: Track,
  opts: { online: boolean; overwrite?: boolean },
): Promise<Partial<Track>> {
  const patch: Partial<Track> = {};
  // on-device: genre from the analysis engine (free if cached, else a quick analyze)
  if (hasTauri && (opts.overwrite || empty(track.genre))) {
    const a = (await cachedAnalysis(track.path)) ?? (await analyzeTrackNative(track.path).catch(() => null));
    const g = a?.genre?.genre;
    if (g) patch.genre = titleCase(g);
  }
  // online: MusicBrainz for album/year/canonical title+artist
  if (opts.online && track.artist && track.title) {
    const mb = await mbLookup(track.artist, track.title);
    (Object.keys(mb) as (keyof Track)[]).forEach((k) => {
      if (opts.overwrite || empty(track[k])) (patch as Record<string, unknown>)[k] = mb[k];
    });
  }
  return patch;
}

/** Apply a tag patch: update the in-memory index + persist the JSONL cache, and OPTIONALLY write into the
 *  audio file (gated by the caller / the tagWriteFile setting). */
export async function applyTags(track: Track, patch: Partial<Track>, writeFile: boolean): Promise<void> {
  if (!patch || Object.keys(patch).length === 0) return;
  const { updateTrackMeta, folders } = usePlayer.getState();
  updateTrackMeta(track.id, patch);
  if (!hasTauri) return;
  cacheSave(folders[0] ?? "", usePlayer.getState().library); // persist the index after the update
  if (writeFile) {
    const m = { ...track, ...patch };
    await writeTags(track.path, {
      title: m.title, artist: m.artist, album: m.album, album_artist: m.albumArtist,
      genre: m.genre, year: m.year, track_no: m.trackNo,
    });
  }
}

const tagged = new Set<string>(); // de-dup: don't re-auto-tag the same track repeatedly in a session

/** One-shot auto-tag respecting the user's settings — used by the "while playing" background trigger and
 *  the manual action. Returns the applied patch (empty if nothing changed). */
export async function autoTagTrack(track: Track, force = false): Promise<Partial<Track>> {
  const s = useSettings.getState();
  if (!force) {
    if (tagged.has(track.id)) return {};
    tagged.add(track.id);
  }
  const patch = await enrichPatch(track, { online: s.tagOnline });
  await applyTags(track, patch, s.tagWriteFile);
  return patch;
}
