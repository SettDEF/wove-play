import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { usePlayer } from "@/store/player";
import { usePlaylists } from "@/store/playlists";
import { toast } from "@/store/toasts";
import { Icon } from "./Icons";
import { Cover } from "./Cover";
import { VirtualList } from "./VirtualList";
import { Sheet } from "./Sheet";
import { SwipeRow } from "./SwipeRow";
import { makeSwipeAct } from "@/lib/swipeActions";

const QROW_H = 52;

/** Up-Next sheet: the live queue with reorder / remove / jump. */
export function QueueSheet({ onClose }: { onClose: () => void }) {
  const queue = usePlayer((s) => s.queue);
  const index = usePlayer((s) => s.index);
  const { jumpTo, removeFromQueue, moveInQueue, clearQueue, shuffleQueue, clearUpcoming, dedupeQueue } = usePlayer.getState();
  const saveAsPlaylist = () => {
    const q = usePlayer.getState().queue;
    if (!q.length) return;
    const id = usePlaylists.getState().create(`Queue · ${new Date().toLocaleDateString()}`, q.map((t) => t.id));
    void id; toast.success(`Saved ${q.length} song${q.length === 1 ? "" : "s"} as a playlist`);
  };
  // Mount the (potentially big) list only AFTER the sheet's slide-up has painted, so the open
  // animation can't stutter on the list-render long task. Two rAFs = "after the first painted frame".
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let r2 = 0;
    const r1 = requestAnimationFrame(() => { r2 = requestAnimationFrame(() => setReady(true)); });
    return () => { cancelAnimationFrame(r1); cancelAnimationFrame(r2); };
  }, []);

  // Windowed: only the visible queue rows mount, so a 40k-track queue stays smooth.
  const row = (i: number) => {
    const t = queue[i];
    // Queue-specific swipes: drag right → Play next (jump it up), drag left → Remove from queue.
    return (
      <SwipeRow left={makeSwipeAct("playNext", t)} right={makeSwipeAct("removeQueue", t, { onRemove: () => removeFromQueue(i) })}>
      <div className={`wp-qrow ${i === index ? "wp-row-active" : ""}`} style={{ height: QROW_H }}>
        <button className="wp-qrow-main" onClick={() => { jumpTo(i); }}>
          {i === index ? <span className="wp-qrow-now"><Icon name="graphicEq" size={16} /></span> : <Cover path={t.path} size={38} />}
          <div className="wp-row-text">
            <div className="md-body-l ellipsis">{t.title}</div>
            <div className="md-body-s wp-muted ellipsis">{t.artist}</div>
          </div>
        </button>
        <div className="wp-qrow-actions">
          <button className="md-icon-btn wp-icon-sm" title="Move up" disabled={i === 0} onClick={() => moveInQueue(i, i - 1)}><Icon name="up" size={18} /></button>
          <button className="md-icon-btn wp-icon-sm" title="Move down" disabled={i === queue.length - 1} onClick={() => moveInQueue(i, i + 1)}><Icon name="down" size={18} /></button>
          <button className="md-icon-btn wp-icon-sm" title="Remove" onClick={() => removeFromQueue(i)}><Icon name="close" size={18} /></button>
        </div>
      </div>
      </SwipeRow>
    );
  };

  return createPortal(
    <Sheet onClose={onClose}>
        <header className="wp-sheet-head wp-queue-head">
          <Icon name="queue" size={22} />
          <div className="wp-row-text"><div className="md-title-s">Up Next</div>
            <div className="md-body-s wp-muted">{queue.length} track{queue.length === 1 ? "" : "s"}</div></div>
          <button className="md-icon-btn" title="Clear queue" onClick={() => { clearQueue(); onClose(); }}><Icon name="trash" size={20} /></button>
          <button className="md-icon-btn" title="Close" onClick={onClose}><Icon name="close" size={20} /></button>
        </header>

        {queue.length > 1 && (
          <div className="wp-queue-tools">
            <button className="wp-chip" onClick={shuffleQueue}><Icon name="shuffle" size={16} /> Shuffle upcoming</button>
            <button className="wp-chip" onClick={saveAsPlaylist}><Icon name="playlistAdd" size={16} /> Save as playlist</button>
            <button className="wp-chip" onClick={dedupeQueue}><Icon name="copy" size={16} /> Remove duplicates</button>
            <button className="wp-chip" onClick={clearUpcoming}><Icon name="next" size={16} /> Clear upcoming</button>
          </div>
        )}

        {queue.length === 0
          ? <div className="wp-queue-list"><div className="wp-empty"><Icon name="queue" size={40} color="var(--md-on-surface-variant)" /><div className="md-body-m wp-muted">The queue is empty.</div></div></div>
          : ready
            ? <VirtualList className="wp-queue-list" count={queue.length} rowH={QROW_H} render={row} />
            : <div className="wp-queue-list" />}
    </Sheet>,
    document.body,
  );
}
