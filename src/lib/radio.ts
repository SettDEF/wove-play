import { httpGetBytes } from "./backend";
import { usePlayer } from "@/store/player";
import { streamTrack } from "./streams";
import type { Track } from "./types";

/** A radio station from the (free, no-key) Radio-Browser directory. */
export interface Station {
  id: string; name: string; url: string;
  favicon?: string; tags?: string; country?: string; codec?: string; bitrate?: number; votes?: number;
}

interface RawStation {
  stationuuid: string; name: string; url: string; url_resolved?: string;
  favicon?: string; tags?: string; country?: string; codec?: string; bitrate?: number; votes?: number;
}

const BASE = "https://de1.api.radio-browser.info/json"; // a Radio-Browser mirror

async function api(path: string): Promise<RawStation[]> {
  const url = `${BASE}${path}`;
  // prefer the Rust proxy (sets a User-Agent, which Radio-Browser asks for, + dodges CORS)
  const got = await httpGetBytes(url);
  const text = got ? new TextDecoder().decode(got.data) : await fetch(url).then((r) => r.text()).catch(() => "");
  try { return JSON.parse(text) as RawStation[]; } catch { return []; }
}

const toStation = (s: RawStation): Station => ({
  id: s.stationuuid, name: s.name?.trim() || "Station", url: s.url_resolved || s.url,
  favicon: s.favicon || undefined, tags: s.tags, country: s.country, codec: s.codec, bitrate: s.bitrate, votes: s.votes,
});

/** Most-clicked stations (the default browse view). */
export async function topStations(limit = 60): Promise<Station[]> {
  return (await api(`/stations/topclick/${limit}`)).map(toStation).filter((s) => s.url);
}

/** Search by name (falls back to top stations for an empty query). */
export async function searchStations(q: string, limit = 60): Promise<Station[]> {
  if (!q.trim()) return topStations(limit);
  return (await api(`/stations/search?name=${encodeURIComponent(q.trim())}&limit=${limit}&order=votes&reverse=true&hidebroken=true`))
    .map(toStation).filter((s) => s.url);
}

/** Play a station as an online stream (uses Phase-1 stream playback). */
export function playStation(st: Station) {
  const t: Track = {
    ...streamTrack(st.url, st.name, "Radio"),
    artist: st.tags?.split(",")[0]?.trim() || st.country || "Radio",
    artUrl: st.favicon,
  };
  usePlayer.getState().playFrom([t], 0, "Radio");
}
