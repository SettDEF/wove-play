import { useEffect, useRef, useState } from "react";
import { coverArtStrict, isAndroid } from "@/lib/backend";
import { engine } from "@/audio/engine";
import { useSettings } from "@/store/settings";
import { Icon } from "./Icons";
import { SoundDna } from "./SoundDna";
import { CrossArt } from "./CrossArt";

// LRU-bounded in-memory cache (path → data URL or null = no art). Unbounded, this grows one base64
// thumbnail per cover ever viewed → hundreds of MB / OOM on a 40k library. The persistent DISK cache
// (native) makes a re-fetch after eviction cheap, so a few hundred resident entries is plenty.
let cacheMax = 800; // adjustable via Settings → Performance (setCoverCacheLimit)
const cache = new Map<string, string | null>();
// In-flight fetches keyed by path → a SHARED promise. Concurrent requesters of the same cover (e.g. the
// player's foreground art AND the blurred backdrop) all await this one result, instead of the first
// requester "winning" the fetch and the others getting stuck on null. [cover race fix]
const inflight = new Map<string, Promise<string | null>>();
const cacheGet = (path: string): string | null | undefined => {
  if (!cache.has(path)) return undefined;
  const v = cache.get(path)!;
  cache.delete(path); cache.set(path, v); // bump to most-recently-used
  return v;
};
const cacheSet = (path: string, v: string | null) => {
  cache.set(path, v);
  while (cache.size > cacheMax) { const oldest = cache.keys().next().value; if (oldest === undefined) break; cache.delete(oldest); }
};
/** Resize the in-memory cover LRU (Settings → Performance). Bigger = smoother grid scroll, more RAM. */
export function setCoverCacheLimit(n: number) {
  cacheMax = Math.max(100, Math.min(5000, Math.round(n)));
  while (cache.size > cacheMax) { const oldest = cache.keys().next().value; if (oldest === undefined) break; cache.delete(oldest); }
}

// Cover fetches are native IPC (Android: MediaMetadataRetriever / thumbnails) — firing one per tile
// when a grid mounts (Albums/Artists/Explore) floods the bridge and stalls the UI. So we cap how many
// run at once and queue the rest. Two efficiency wins: (1) the queue is LIFO — the MOST-recently
// requested covers (the ones currently on screen) load FIRST, ahead of stale scrolled-past ones;
// (2) jobs whose tile scrolled away before their turn are skipped, so fast scrolling never backs up.
// Desktop cover_art is a fast local file read → run more in parallel so on-screen art fills quickly.
// Android goes through MediaMetadataRetriever + the JS bridge, which floods if pushed → keep it capped.
// SD-card / bridge contention: Android reads the playing track off the SAME (often slow) storage as
// the covers, so a burst of cover reads on a tab switch starves the audio read → playback hitches +
// UI stalls. So cap cover concurrency LOW while music is playing, higher when paused. Desktop (SSD)
// has no such contention. [perf]
// Perf-driven concurrency multiplier (Settings → Performance). The strongest modes (Ultra/High) load
// album art AGGRESSIVELY so a grid fills instantly; battery/smooth keep it gentle. Set by applyPerf().
let coverMult = 1;
/** Scale how many cover fetches run at once (1 = default). Higher = art fills faster, more I/O. */
export function setCoverConcurrency(mult: number) {
  coverMult = Math.max(0.4, Math.min(3, mult));
  pump();
}
function cap(): number {
  if (!isAndroid) return Math.round(16 * coverMult);
  return Math.max(1, Math.round((engine.paused ? 6 : 3) * coverMult));
}
let active = 0;
let coverPaused = false; // briefly suspended right after a track starts (its file is buffering off disk)
let resumeTimer = 0;
const queue: (() => void)[] = [];
function pump() {
  if (coverPaused) return;
  while (active < cap() && queue.length) { const job = queue.pop()!; job(); } // pop = newest first
}
function schedule(job: () => Promise<void>) {
  queue.push(() => { active++; job().finally(() => { active--; pump(); }); });
  pump();
}

/**
 * Pause cover fetching for `ms` so a just-started track's file can buffer off (slow) storage without
 * cover reads competing for I/O. Called from playTrack on every track change; resumes + pumps itself.
 */
export function deprioritizeCovers(ms = 700) {
  coverPaused = true;
  if (resumeTimer) clearTimeout(resumeTimer);
  resumeTimer = window.setTimeout(() => { coverPaused = false; pump(); }, ms);
}

/** Drop the in-memory cover cache so art is re-fetched (used after a library rebuild). */
export function clearCoverCache() { cache.clear(); inflight.clear(); }

/**
 * Fetch a track's embedded album-art thumbnail (cached across the app, concurrency-capped).
 * Pass `gate` (a ref to the tile element) to enable LAZY mode: the fetch is deferred via an
 * IntersectionObserver until the tile nears the viewport — so a huge library only ever fetches the
 * art you actually scroll to. Without `gate`, it fetches eagerly on mount (snappiest).
 */
export function useCover(path?: string, gate?: React.RefObject<HTMLElement | null>): string | null {
  const [url, setUrl] = useState<string | null>(() => (path ? cacheGet(path) ?? null : null));
  useEffect(() => {
    if (!path) { setUrl(null); return; }
    const hit = cacheGet(path);
    if (hit !== undefined) { setUrl(hit); return; }
    let alive = true;
    const startFetch = () => {
      if (!alive) return;
      // Reuse the in-flight fetch for this path if one exists, else start one. Either way THIS component
      // attaches to the shared promise, so every requester (foreground cover + backdrop) gets the result.
      let p = inflight.get(path);
      if (!p) {
        p = new Promise<string | null>((resolve) => {
          schedule(async () => {
            try {
              let u: string | null;
              try { u = await coverArtStrict(path); }
              // A just-started track can briefly lock its art off slow storage (the very reason covers are
              // deprioritized at track start). Retry ONCE after a beat before giving up.
              catch { await new Promise((r) => setTimeout(r, 600)); u = await coverArtStrict(path); }
              cacheSet(path, u); resolve(u);          // a real result (art OR genuine no-art) → safe to cache
            } catch {
              resolve(null);                          // transient failure even after the retry → DON'T cache,
            } finally {                               // so re-viewing the track refetches instead of staying blank
              inflight.delete(path);
            }
          });
        });
        inflight.set(path, p);
      }
      void p.then((u) => { if (alive) setUrl(u); });
    };
    const el = gate?.current;
    if (el && typeof IntersectionObserver !== "undefined") {
      // start a touch before it's on screen so the art is usually ready by the time you reach it
      const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { io.disconnect(); startFetch(); } }, { rootMargin: "250px" });
      io.observe(el);
      return () => { alive = false; io.disconnect(); };
    }
    startFetch();
    return () => { alive = false; };
  }, [path, gate]);
  return url;
}

/** Square album-art tile; falls back to a Sound-DNA glyph (or a music icon) when there's no art.
 *  `fade` cross-dissolves when the art changes (for the always-visible player/mini covers) — leave it
 *  OFF in big lists, where a plain swap keeps scrolling cheap. */
export function Cover({ path, size = 48, radius = "sm", fade = false }: { path?: string; size?: number; radius?: "sm" | "md" | "lg"; fade?: boolean }) {
  const lazy = useSettings((s) => s.lazyCovers);
  const dna = useSettings((s) => s.soundDna);
  const ref = useRef<HTMLDivElement>(null);
  const url = useCover(path, lazy ? ref : undefined);
  return (
    <div ref={ref} className="wp-cover" style={{ width: size, height: size, borderRadius: `var(--md-shape-${radius})` }}>
      {url
        ? (fade ? <CrossArt src={url} /> : <img src={url} alt="" decoding="async" loading={lazy ? "lazy" : undefined} />)
        : path && dna ? <SoundDna id={path} size={size} /> : <Icon name="music" size={Math.round(size * 0.42)} />}
    </div>
  );
}
