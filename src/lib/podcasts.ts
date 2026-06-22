import { httpGetBytes } from "./backend";
import { usePlayer } from "@/store/player";
import { useSettings } from "@/store/settings";
import type { Track } from "./types";

export interface Episode { id: string; title: string; url: string; date?: string; image?: string; duration: number; podcast: string; }
export interface Feed { url: string; title: string; image?: string; episodes: Episode[]; }

const txt = (el: Element | null | undefined, tag: string) => el?.getElementsByTagName(tag)[0]?.textContent?.trim() || "";

function parseDuration(s: string): number {
  if (!s) return 0;
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  return s.split(":").map(Number).reduce((a, n) => a * 60 + (n || 0), 0); // hh:mm:ss / mm:ss
}

/** Fetch + parse a podcast RSS feed into a channel + its episodes. */
export async function fetchFeed(url: string): Promise<Feed | null> {
  const got = await httpGetBytes(url);
  const text = got ? new TextDecoder().decode(got.data) : await fetch(url).then((r) => r.text()).catch(() => "");
  if (!text) return null;
  let doc: Document;
  try { doc = new DOMParser().parseFromString(text, "application/xml"); } catch { return null; }
  const channel = doc.getElementsByTagName("channel")[0];
  if (!channel) return null;
  const title = txt(channel, "title") || "Podcast";
  const chImg = channel.getElementsByTagName("itunes:image")[0]?.getAttribute("href")
    || txt(channel.getElementsByTagName("image")[0], "url") || undefined;
  const episodes: Episode[] = [];
  Array.from(channel.getElementsByTagName("item")).forEach((it) => {
    const audio = it.getElementsByTagName("enclosure")[0]?.getAttribute("url");
    if (!audio) return;
    episodes.push({
      id: audio, title: txt(it, "title") || "Episode", url: audio, date: txt(it, "pubDate"),
      image: it.getElementsByTagName("itunes:image")[0]?.getAttribute("href") || chImg,
      duration: parseDuration(it.getElementsByTagName("itunes:duration")[0]?.textContent?.trim() || ""),
      podcast: title,
    });
  });
  return { url, title, image: chImg, episodes };
}

export const episodeTrack = (ep: Episode): Track => ({
  id: ep.url, path: ep.url, title: ep.title, artist: ep.podcast, album: "Podcast",
  duration: ep.duration, streaming: true, source: "Podcast", artUrl: ep.image,
});

export function playEpisodes(eps: Episode[], index: number) {
  usePlayer.getState().playFrom(eps.map(episodeTrack), index, "Podcast");
}

// ── subscriptions (persisted in settings) ──
export const podcastSubs = () => useSettings.getState().podcasts;
export function subscribe(url: string) {
  const s = useSettings.getState();
  if (url && !s.podcasts.includes(url)) s.setPodcasts([...s.podcasts, url]);
}
export function unsubscribe(url: string) {
  const s = useSettings.getState();
  s.setPodcasts(s.podcasts.filter((u) => u !== url));
}
