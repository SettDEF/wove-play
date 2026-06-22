import { usePlayer } from "@/store/player";
import { usePlaylists, resolveSmart } from "@/store/playlists";
import { useRatings } from "@/store/ratings";
import { nativeMediaActive, nativeSetBrowseTree, type BrowseNode } from "./nativeMedia";
import type { Track } from "./types";

/** Android Auto / Automotive browse catalog. We build a flat `{ parentId: BrowseNode[] }` map from
 *  the player's stores and push it to the native MediaBrowserService; when the car picks a track we
 *  reconstruct its list as the play queue (so next/prev work in the list the user was browsing).
 *
 *  Off Android this is inert (the native push + bind are no-ops). */

const SEP = ""; // delimiter inside a playable mediaId: `track␁<listKey>␁<trackId>` (a control char paths can't contain)
const ROOT = "__root__";
const RECENT_CAP = 100;
const LOVED_CAP = 200;
const LIST_CAP = 300; // per-playlist cap (Auto lists shouldn't be unbounded)

// Each browsable list's resolved tracks, kept so a play selection can rebuild the right queue.
let listCache: Record<string, Track[]> = {};

const trackNode = (listKey: string, t: Track): BrowseNode => ({
  id: `track${SEP}${listKey}${SEP}${t.id}`,
  title: t.title || t.id,
  subtitle: [t.artist, t.album].filter(Boolean).join(" · "),
  playable: true,
});

/** Build the catalog (and the queue-reconstruction cache) from the current stores. */
function buildCatalog(): Record<string, BrowseNode[]> {
  const { library } = usePlayer.getState();
  const byId = new Map(library.map((t) => [t.id, t] as const));
  const { stats } = useRatings.getState();
  const { lists } = usePlaylists.getState();

  const tree: Record<string, BrowseNode[]> = {};
  listCache = {};
  const root: BrowseNode[] = [];

  // Recently played — by lastPlayed desc.
  const recent = Object.entries(stats)
    .filter(([, s]) => s.lastPlayed > 0)
    .sort((a, b) => b[1].lastPlayed - a[1].lastPlayed)
    .map(([id]) => byId.get(id))
    .filter((t): t is Track => !!t)
    .slice(0, RECENT_CAP);
  if (recent.length) {
    root.push({ id: "cat:recent", title: "Recently played" });
    listCache["recent"] = recent;
    tree["cat:recent"] = recent.map((t) => trackNode("recent", t));
  }

  // Loved — rating ≥ 4.
  const loved = library.filter((t) => (stats[t.id]?.rating ?? 0) >= 4).slice(0, LOVED_CAP);
  if (loved.length) {
    root.push({ id: "cat:loved", title: "Loved" });
    listCache["loved"] = loved;
    tree["cat:loved"] = loved.map((t) => trackNode("loved", t));
  }

  // Playlists — each becomes a browsable folder of its tracks.
  if (lists.length) {
    root.push({ id: "cat:playlists", title: "Playlists" });
    tree["cat:playlists"] = lists.map((pl) => ({ id: `pl:${pl.id}`, title: pl.name }));
    for (const pl of lists) {
      const tracks = (pl.kind === "smart"
        ? resolveSmart(pl, library, (id) => stats[id] ?? { rating: 0, plays: 0, lastPlayed: 0 })
        : pl.trackIds.map((id) => byId.get(id)).filter((t): t is Track => !!t)
      ).slice(0, LIST_CAP);
      const key = `pl:${pl.id}`;
      listCache[key] = tracks;
      tree[key] = tracks.map((t) => trackNode(key, t));
    }
  }

  tree[ROOT] = root;
  return tree;
}

/** A car picked a browse item — play that track inside the list it came from. */
export function handleAutoPlay(mediaId: string): void {
  if (!mediaId.startsWith(`track${SEP}`)) return;
  const parts = mediaId.split(SEP);
  if (parts.length < 3) return;
  const listKey = parts[1];
  const trackId = parts.slice(2).join(SEP); // (defensive — trackIds never contain SEP)
  const list = listCache[listKey];
  const player = usePlayer.getState();
  if (list && list.length) {
    const idx = list.findIndex((t) => t.id === trackId);
    if (idx >= 0) { void player.playFrom(list, idx); return; }
  }
  // Fallback: play the single track out of the library.
  const t = player.library.find((x) => x.id === trackId);
  if (t) void player.playTrack(t, { instant: true });
}

let scheduled = 0;
function pushSoon(): void {
  if (!nativeMediaActive) return;
  if (scheduled) return;
  scheduled = window.setTimeout(() => { scheduled = 0; void nativeSetBrowseTree(buildCatalog()); }, 400);
}

/** Subscribe to the stores that feed the catalog and keep the car browser in sync. */
export function initAutoBrowse(): void {
  if (!nativeMediaActive) return;
  pushSoon();
  usePlayer.subscribe((s, p) => { if (s.library !== p.library) pushSoon(); });
  usePlaylists.subscribe((s, p) => { if (s.lists !== p.lists) pushSoon(); });
  useRatings.subscribe((s, p) => { if (s.stats !== p.stats) pushSoon(); });
}
