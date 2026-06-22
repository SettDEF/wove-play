import { useEffect, useState } from "react";
import { useSettings } from "@/store/settings";

/** Artist info from Last.fm (`artist.getInfo`): a short plain-text bio, top tags, and listener count.
 *  NOTE: Last.fm artist *images* are deprecated (placeholder star), so we don't use them — the Explore
 *  card keeps the artist's own album art as the visual and overlays this text. */
export interface ArtistInfo { bio: string; tags: string[]; listeners: number }

const cache = new Map<string, ArtistInfo | null>(); // null = looked up, nothing useful
const pending = new Map<string, Promise<ArtistInfo | null>>();

const stripHtml = (s: string) => s.replace(/<[^>]*>/g, "").replace(/\s*Read more on Last\.fm.*$/s, "").trim();

async function fetchInfo(name: string, key: string): Promise<ArtistInfo | null> {
  const url = `https://ws.audioscrobbler.com/2.0/?method=artist.getinfo&artist=${encodeURIComponent(name)}&api_key=${key}&format=json&autocorrect=1`;
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const j = await r.json();
    const a = j?.artist;
    if (!a) return null;
    const bioRaw = a.bio?.summary || a.bio?.content || "";
    const tags = (a.tags?.tag ?? []).map((t: { name: string }) => t.name).filter(Boolean).slice(0, 4);
    const listeners = Number(a.stats?.listeners ?? 0) || 0;
    const bio = stripHtml(typeof bioRaw === "string" ? bioRaw : "");
    if (!bio && !tags.length) return null;
    return { bio, tags, listeners };
  } catch { return null; } // network / CORS / parse → degrade silently (card still shows album art)
}

/** Get cached artist info, fetching once per name when a Last.fm key is set. Returns null until ready
 *  / if unavailable. Safe to call for many cards — dedup'd + cached, and only fires when a key exists. */
export function useArtistInfo(name: string | undefined): ArtistInfo | null {
  const key = useSettings((s) => s.lastfmKey);
  const [info, setInfo] = useState<ArtistInfo | null>(() => (name ? cache.get(name) ?? null : null));
  useEffect(() => {
    if (!name || !key) { setInfo(null); return; }
    if (cache.has(name)) { setInfo(cache.get(name) ?? null); return; }
    let alive = true;
    const p = pending.get(name) ?? fetchInfo(name, key).then((v) => { cache.set(name, v); pending.delete(name); return v; });
    pending.set(name, p);
    void p.then((v) => { if (alive) setInfo(v); });
    return () => { alive = false; };
  }, [name, key]);
  return info;
}
