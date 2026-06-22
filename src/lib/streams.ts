import type { Track } from "./types";
import { httpGetBytes } from "./backend";
import { usePlayer } from "@/store/player";

const hostName = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return "Stream"; } };

/** Build an online-stream Track from a URL (+ optional title). */
export function streamTrack(url: string, title?: string, source = "Stream"): Track {
  return {
    id: url, path: url,
    title: title || decodeURIComponent(url.split("/").pop() || "") || hostName(url),
    artist: hostName(url), album: source, duration: 0, streaming: true, source,
  };
}

async function fetchText(url: string): Promise<string | null> {
  const got = await httpGetBytes(url); // Rust proxy (no CORS)
  if (got) { try { return new TextDecoder().decode(got.data); } catch { /* fall through */ } }
  try { return await (await fetch(url)).text(); } catch { return null; }
}

function parseM3U(text: string): Track[] {
  const out: Track[] = [];
  let title: string | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#EXTINF")) { title = line.match(/#EXTINF:[^,]*,(.*)/)?.[1]?.trim() || undefined; continue; }
    if (line.startsWith("#")) continue;
    if (/^https?:\/\//i.test(line)) { out.push(streamTrack(line, title)); title = undefined; }
  }
  return out;
}

function parsePLS(text: string): Track[] {
  const files: Record<string, string> = {}, titles: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const m = raw.match(/^(File|Title)(\d+)=(.*)$/i);
    if (!m) continue;
    if (/file/i.test(m[1])) files[m[2]] = m[3].trim(); else titles[m[2]] = m[3].trim();
  }
  return Object.keys(files).filter((n) => /^https?:\/\//i.test(files[n])).map((n) => streamTrack(files[n], titles[n]));
}

/** Turn a user-supplied URL into playable tracks: an .m3u/.m3u8/.pls playlist (fetched + parsed) or a
 *  single direct stream URL. (.m3u8/HLS that isn't a URL list is left to the <audio> element to play.) */
export async function parseStreamInput(input: string): Promise<Track[]> {
  const url = input.trim();
  if (!/^https?:\/\//i.test(url)) return [];
  if (/\.pls(\?|$)/i.test(url)) { const t = await fetchText(url); const p = t ? parsePLS(t) : []; return p.length ? p : [streamTrack(url)]; }
  if (/\.m3u8?(\?|$)/i.test(url)) {
    const t = await fetchText(url);
    if (t && t.includes("#EXTINF")) { const p = parseM3U(t); if (p.length) return p; }
    return [streamTrack(url)]; // plain direct stream / HLS playlist → play directly
  }
  return [streamTrack(url)];
}

/** Parse + start playing a stream/playlist URL. Returns how many tracks were queued. */
export async function openStream(input: string): Promise<number> {
  const tracks = await parseStreamInput(input);
  if (!tracks.length) return 0;
  usePlayer.getState().playFrom(tracks, 0, tracks[0].source || "Stream");
  return tracks.length;
}
