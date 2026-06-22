import { useState } from "react";
import { createPortal } from "react-dom";
import { usePlayer } from "@/store/player";
import { usePlaylists } from "@/store/playlists";
import { useRatings } from "@/store/ratings";
import { hasTauri, isAndroid } from "@/lib/backend";
import * as taste from "@/lib/taste";
import { toast } from "@/store/toasts";
import type { Track } from "@/lib/types";
import { useBackGuard } from "@/lib/backStack";
import { Icon } from "./Icons";
import { Cover } from "./Cover";
import { TagEditor } from "./TagEditor";
import { Sheet } from "./Sheet";

/** Optional Now-Playing controls folded into the same sheet (view switch + customize). */
export interface PlayerExtras {
  view: "art" | "viz" | "lyrics";
  setView: (v: "art" | "viz" | "lyrics") => void;
  showViz: boolean;
  onCustomize: () => void;
}

/** Bottom-sheet of contextual actions for one or more tracks. */
/** Where the menu was opened from (Songs / a playlist / Recently Played / an album…). */
export interface MenuSource { label: string; icon?: string; open: () => void }

export function TrackActions({ tracks, onClose, player, onSelect, onDelete, source }: { tracks: Track[]; onClose: () => void; player?: PlayerExtras; onSelect?: (ids: string[]) => void; onDelete?: () => void; source?: MenuSource }) {
  useBackGuard(true, onClose); // self-guard: mounted only while open → Android back / Esc closes the menu
  const playNext = usePlayer((s) => s.playNext);
  const addToQueue = usePlayer((s) => s.addToQueue);
  const lists = usePlaylists((s) => s.lists);
  const { create, addTracks } = usePlaylists.getState();
  const [picking, setPicking] = useState(false);
  const [newName, setNewName] = useState("");
  const [editTags, setEditTags] = useState(false);
  const canEditTags = hasTauri && !isAndroid && tracks.length === 1;

  const ids = tracks.map((t) => t.id);
  const head = tracks[0];
  const ratings = useRatings((s) => s.stats);
  if (editTags && head) return <TagEditor track={head} onClose={onClose} />;
  const label = tracks.length === 1 ? head?.title : `${tracks.length} tracks`;
  const sub = tracks.length === 1 ? head?.artist : "";
  const loved = !!head && (ratings[head.id]?.rating ?? 0) >= 4; // "liked" = rating ≥ 4

  const addToList = (id: string) => { addTracks(id, ids); onClose(); };
  const createAndAdd = () => { const id = create(newName || (head?.album ?? "Playlist"), []); addTracks(id, ids); onClose(); };

  /** Start mix → an Endless Set (beatmatched auto-DJ) seeded by this track. */
  const startMix = () => { if (head) { onClose(); void usePlayer.getState().startEndlessSet(head); } };

  /** Add to / remove from liked songs (rating 5 ↔ 0) for every selected track. */
  const toggleLiked = () => {
    const set = useRatings.getState().setRating;
    const next = loved ? 0 : 5;
    ids.forEach((id) => set(id, next));
    toast.success(next ? (ids.length > 1 ? `Liked ${ids.length} songs` : "Added to liked songs") : "Removed from liked songs");
    onClose();
  };

  /** "Not for me" — a strong negative signal: the recommender shows less like this. Skips it if playing. */
  const notForMe = () => {
    ids.forEach((id) => void taste.recordEvent(id, "Dislike"));
    ids.forEach((id) => useRatings.getState().bumpSkip(id));
    const cur = usePlayer.getState().current();
    if (cur && ids.includes(cur.id)) void usePlayer.getState().next();
    toast.success(ids.length > 1 ? `We'll show less like those ${ids.length}` : "We'll show less like this");
    onClose();
  };

  /** The containing folder (for the "Folder" quick-nav tab). */
  const folder = head ? (head.folder || (() => { const p = head.path; const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\")); return i > 0 ? p.slice(0, i) : ""; })()) : "";

  /** Share the track via the system share sheet (falls back to copying the text). */
  const share = async () => {
    const text = tracks.length === 1 && head ? `${head.title} — ${head.artist}` : `${tracks.length} tracks`;
    try {
      if (navigator.share) await navigator.share({ title: head?.title ?? "Wove", text });
      else if (navigator.clipboard) { await navigator.clipboard.writeText(text); toast.success("Copied to clipboard"); }
    } catch { /* user cancelled */ }
    onClose();
  };

  /** Fingerprint the selected tracks for the taste engine (bulk-friendly). */
  const analyzeThese = async () => {
    onClose();
    const { analyzeTrackSet, tasteOpts, libraryTokens } = await import("@/lib/tasteIngest");
    const { useSettings } = await import("@/store/settings");
    const opts = tasteOpts(useSettings.getState().tastePerf);
    const prog = toast.progress(`Analyzing ${tracks.length} song${tracks.length === 1 ? "" : "s"}…`, "taste");
    try {
      const added = await analyzeTrackSet(tracks, opts, (p) => prog.update(`Analyzing… ${p.done}/${p.total}`, p.done / Math.max(1, p.total)));
      await taste.recluster(libraryTokens(usePlayer.getState().library));
      prog.done(`Analyzed ${added} new song${added === 1 ? "" : "s"}`);
    } catch { prog.fail("Couldn't analyze those songs."); }
  };

  /** "More like this" — an instant on-device radio of similar tracks via the taste engine. */
  const startRadio = async () => {
    if (!head) return;
    const sim = await taste.similar(head.id, 60);
    const byId = new Map(usePlayer.getState().library.map((t) => [t.id, t]));
    const queue: Track[] = [head, ...sim.map(([id]) => byId.get(id)).filter((t): t is Track => !!t && t.id !== head.id)];
    if (queue.length < 2) { toast.info("Analyze your library in Settings → For You to use Radio."); return; }
    usePlayer.getState().playFrom(queue, 0);
    toast.success(`Radio · ${queue.length} tracks like “${head.title}”`);
    onClose();
  };

  return createPortal(
    <Sheet onClose={onClose} tall={false}>
        <header className="wp-sheet-head">
          {head && <Cover path={head.path} size={44} />}
          <div className="wp-row-text">
            <div className="md-title-s ellipsis">{label}</div>
            {sub && <div className="md-body-s wp-muted ellipsis">{sub}</div>}
          </div>
        </header>

        {/* Quick-nav tabs: jump to this track's artist / album / year / folder in the library. */}
        {tracks.length === 1 && head && !picking && (() => {
          const tabs: { key: string; icon: string; label: string; go: () => void }[] = [];
          if (head.artist && head.artist !== "Unknown artist")
            tabs.push({ key: "ar", icon: "artist", label: "Artist", go: () => { onClose(); usePlayer.getState().goToArtist(head.artist); } });
          if (head.album && head.album !== "Unknown album" && head.album !== "Folder")
            tabs.push({ key: "al", icon: "library", label: "Album", go: () => { onClose(); usePlayer.getState().goToAlbum(head.album, head.albumArtist || head.artist); } });
          if (head.year)
            tabs.push({ key: "yr", icon: "timer", label: String(head.year), go: () => { onClose(); usePlayer.getState().goToYear(head.year!); } });
          if (folder)
            tabs.push({ key: "fo", icon: "folder", label: "Folder", go: () => { onClose(); usePlayer.getState().goToFolder(folder); } });
          return tabs.length ? (
            <div className="wp-ta-navtabs" onClick={(e) => e.stopPropagation()}>
              {tabs.map((tb) => (
                <button key={tb.key} className="wp-ta-navtab" onClick={tb.go} title={`Open ${tb.label}`}>
                  <Icon name={tb.icon} size={16} /> <span className="ellipsis">{tb.label}</span>
                </button>
              ))}
            </div>
          ) : null;
        })()}

        {player && !picking && (
          <div className="wp-np-viewseg" onClick={(e) => e.stopPropagation()}>
            {(["art", "viz", "lyrics"] as const).filter((v) => v !== "viz" || player.showViz).map((v) => (
              <button key={v} className={`wp-np-viewseg-btn ${player.view === v ? "on" : ""}`}
                onClick={() => { player.setView(v); onClose(); }}>
                <Icon name={v === "art" ? "music" : v === "viz" ? "graphicEq" : "lyrics"} size={18} />
                {v === "art" ? "Cover" : v === "viz" ? "Visualizer" : "Lyrics"}
              </button>
            ))}
          </div>
        )}

        {!picking ? (
          <div className="wp-sheet-actions">
            {tracks.length === 1 && hasTauri && (
              <button className="wp-sheet-item wp-sheet-hero" onClick={startRadio}>
                <Icon name="graphicEq" size={22} color="var(--md-primary)" /><span className="md-body-l">More like this</span>
                <span className="md-body-s wp-muted">Radio</span>
              </button>
            )}
            {tracks.length === 1 && hasTauri && (
              <button className="wp-sheet-item" onClick={startMix}>
                <Icon name="allInclusive" size={22} /><span className="md-body-l">Start mix</span>
              </button>
            )}
            <button className="wp-sheet-item" onClick={() => { playNext(tracks); onClose(); }}>
              <Icon name="playNextIcon" size={22} /><span className="md-body-l">Play next</span>
            </button>
            <button className="wp-sheet-item" onClick={() => { addToQueue(tracks); onClose(); }}>
              <Icon name="queue" size={22} /><span className="md-body-l">Add to queue</span>
            </button>
            <button className="wp-sheet-item" onClick={toggleLiked}>
              <Icon name="favorite" size={22} color={loved ? "var(--md-primary)" : undefined} />
              <span className="md-body-l">{loved ? "Remove from liked songs" : "Add to liked songs"}</span>
            </button>
            {hasTauri && (
              <button className="wp-sheet-item" onClick={notForMe}>
                <Icon name="close" size={22} /><span className="md-body-l">Not for me</span>
                <span className="md-body-s wp-muted">show less</span>
              </button>
            )}
            <button className="wp-sheet-item" onClick={() => setPicking(true)}>
              <Icon name="playlistAdd" size={22} /><span className="md-body-l">Save to playlist</span>
              <Icon name="next" size={18} color="var(--md-on-surface-variant)" />
            </button>
            {onSelect && (
              <button className="wp-sheet-item" onClick={() => { onSelect(ids); onClose(); }}>
                <Icon name="checkCircle" size={22} /><span className="md-body-l">Select</span>
                <span className="md-body-s wp-muted">multi-select</span>
              </button>
            )}
            {hasTauri && (
              <button className="wp-sheet-item" onClick={analyzeThese}>
                <Icon name="favorite" size={22} /><span className="md-body-l">Analyze for taste</span>
                {tracks.length > 1 && <span className="md-body-s wp-muted">{tracks.length}</span>}
              </button>
            )}
            {source && (
              <button className="wp-sheet-item" onClick={() => { onClose(); source.open(); }}>
                <Icon name={source.icon ?? "library"} size={22} /><span className="md-body-l">Open {source.label}</span>
              </button>
            )}
            <button className="wp-sheet-item" onClick={share}>
              <Icon name="share" size={22} /><span className="md-body-l">Share</span>
            </button>
            {player && (
              <>
                <div className="wp-sheet-divider" />
                <button className="wp-sheet-item" onClick={() => { onClose(); player.onCustomize(); }}>
                  <Icon name="tune" size={22} /><span className="md-body-l">Customize player</span>
                </button>
                <button className="wp-sheet-item" onClick={() => { onClose(); usePlayer.getState().setTab("eq"); }}>
                  <Icon name="eq" size={22} /><span className="md-body-l">Equalizer</span>
                </button>
                {player.showViz && (
                  <button className="wp-sheet-item" onClick={() => { onClose(); usePlayer.getState().setTab("visualizer"); }}>
                    <Icon name="graphicEq" size={22} /><span className="md-body-l">Visualizer studio</span>
                  </button>
                )}
              </>
            )}
            {canEditTags && (
              <button className="wp-sheet-item" onClick={() => setEditTags(true)}>
                <Icon name="edit" size={22} /><span className="md-body-l">Edit tags</span>
              </button>
            )}
            {onDelete && (
              <>
                <div className="wp-sheet-divider" />
                <button className="wp-sheet-item wp-sheet-danger" onClick={() => { onClose(); onDelete(); }}>
                  <Icon name="trash" size={22} /><span className="md-body-l">{tracks.length > 1 ? `Remove ${tracks.length} songs` : "Remove from library"}</span>
                </button>
              </>
            )}
          </div>
        ) : (
          <div className="wp-sheet-actions">
            <div className="wp-newpl">
              <input className="wp-search-input md-body-l" placeholder="New playlist name" value={newName}
                onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && createAndAdd()} />
              <button className="wp-filled-btn" onClick={createAndAdd}><Icon name="add" size={18} /> Create</button>
            </div>
            {lists.length === 0 && <div className="wp-muted md-body-s" style={{ padding: "6px 12px" }}>No playlists yet — create one above.</div>}
            {lists.map((p) => (
              <button key={p.id} className="wp-sheet-item" onClick={() => addToList(p.id)}>
                <Icon name="playlist" size={22} /><span className="md-body-l ellipsis">{p.name}</span>
                <span className="md-body-s wp-muted">{p.trackIds.length}</span>
              </button>
            ))}
          </div>
        )}
    </Sheet>,
    document.body,
  );
}
