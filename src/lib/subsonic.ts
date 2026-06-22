import { httpGetBytes, md5Hex } from "./backend";
import { usePlayer } from "@/store/player";
import { useSettings } from "@/store/settings";
import type { Track } from "./types";

const SALT = "wovexplay"; // constant token-auth salt (self-hosted server, over the user's own network)
let tokenCache: { pass: string; token: string } | null = null;

export const hasSubsonic = () => {
  const s = useSettings.getState();
  return !!(s.subsonicUrl && s.subsonicUser && s.subsonicPass);
};

const base = () => useSettings.getState().subsonicUrl.replace(/\/+$/, "");

/** Build the Subsonic auth query (token = md5(password + salt)). */
async function auth(): Promise<string | null> {
  const { subsonicUser, subsonicPass } = useSettings.getState();
  if (!hasSubsonic()) return null;
  if (!tokenCache || tokenCache.pass !== subsonicPass) {
    const token = await md5Hex(subsonicPass + SALT);
    if (!token) return null;
    tokenCache = { pass: subsonicPass, token };
  }
  return `u=${encodeURIComponent(subsonicUser)}&t=${tokenCache.token}&s=${SALT}&v=1.16.1&c=WovePlay&f=json`;
}

const streamUrl = (id: string, a: string) => `${base()}/rest/stream?id=${encodeURIComponent(id)}&${a}`;
const coverUrl = (id: string | undefined, a: string) =>
  id ? `${base()}/rest/getCoverArt?id=${encodeURIComponent(id)}&size=500&${a}` : undefined;

interface RawSong { id: string; title: string; artist?: string; album?: string; duration?: number; coverArt?: string; }

const toTrack = (s: RawSong, a: string): Track => ({
  id: streamUrl(s.id, a), path: streamUrl(s.id, a),
  title: s.title || "Track", artist: s.artist || "Unknown", album: s.album || "Subsonic",
  duration: s.duration || 0, streaming: true, source: "Subsonic", artUrl: coverUrl(s.coverArt, a),
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function apiJson(path: string, a: string): Promise<any> {
  const url = `${base()}/rest/${path}${path.includes("?") ? "&" : "?"}${a}`;
  const got = await httpGetBytes(url);
  const text = got ? new TextDecoder().decode(got.data) : await fetch(url).then((r) => r.text()).catch(() => "");
  try { return JSON.parse(text)["subsonic-response"]; } catch { return null; }
}

/** Search the server (or a random selection for an empty query). */
export async function subsonicSearch(q: string, limit = 60): Promise<Track[]> {
  const a = await auth();
  if (!a) return [];
  if (q.trim()) {
    const r = await apiJson(`search3?query=${encodeURIComponent(q.trim())}&songCount=${limit}&albumCount=0&artistCount=0`, a);
    return ((r?.searchResult3?.song ?? []) as RawSong[]).map((s) => toTrack(s, a));
  }
  const r = await apiJson(`getRandomSongs?size=${limit}`, a);
  return ((r?.randomSongs?.song ?? []) as RawSong[]).map((s) => toTrack(s, a));
}

/** Verify the credentials (ping). Returns true if the server accepts them. */
export async function subsonicPing(): Promise<boolean> {
  const a = await auth();
  if (!a) return false;
  const r = await apiJson("ping", a);
  return r?.status === "ok";
}

export function playSubsonic(tracks: Track[], index: number) {
  usePlayer.getState().playFrom(tracks, index, "Subsonic");
}
