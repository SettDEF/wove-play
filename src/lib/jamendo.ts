import { httpGetBytes } from "./backend";
import { usePlayer } from "@/store/player";
import { useSettings } from "@/store/settings";
import type { Track } from "./types";

interface RawJ {
  id: string; name: string; artist_name: string; album_name?: string;
  audio: string; audiodownload?: string; image?: string; duration?: number;
}

const toTrack = (r: RawJ): Track => ({
  id: r.audio, path: r.audio,
  title: r.name || "Track", artist: r.artist_name || "Unknown", album: r.album_name || "Jamendo",
  duration: r.duration || 0, streaming: true, source: "Jamendo", artUrl: r.image,
});

async function api(path: string): Promise<RawJ[]> {
  const key = useSettings.getState().jamendoKey.trim();
  if (!key) return [];
  const url = `https://api.jamendo.com/v3.0${path}${path.includes("?") ? "&" : "?"}client_id=${encodeURIComponent(key)}&format=json&audioformat=mp32`;
  const got = await httpGetBytes(url);
  const text = got ? new TextDecoder().decode(got.data) : await fetch(url).then((r) => r.text()).catch(() => "");
  try { return (JSON.parse(text).results ?? []) as RawJ[]; } catch { return []; }
}

export const hasJamendoKey = () => !!useSettings.getState().jamendoKey.trim();

/** Search Jamendo (or the most-popular tracks for an empty query). CC-licensed, streamable + downloadable. */
export async function jamendoSearch(q: string, limit = 50): Promise<Track[]> {
  const p = q.trim()
    ? `/tracks/?search=${encodeURIComponent(q.trim())}&limit=${limit}`
    : `/tracks/?order=popularity_total&limit=${limit}`;
  return (await api(p)).filter((r) => r.audio).map(toTrack);
}

/** Play a Jamendo result list starting at `index` (uses the Phase-1 stream pipeline). */
export function playJamendo(tracks: Track[], index: number) {
  usePlayer.getState().playFrom(tracks, index, "Jamendo");
}
