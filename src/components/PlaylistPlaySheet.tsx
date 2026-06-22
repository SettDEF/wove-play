import { usePlayer } from "@/store/player";
import { useRatings } from "@/store/ratings";
import { Sheet } from "./Sheet";
import { Icon } from "./Icons";
import { hasTauri } from "@/lib/backend";
import { toast } from "@/store/toasts";
import * as taste from "@/lib/taste";
import type { Track } from "@/lib/types";

function shuffle<T>(a: T[]): T[] {
  const r = [...a];
  for (let i = r.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [r[i], r[j]] = [r[j], r[i]]; }
  return r;
}

/** "10 ways to play" a playlist. Each maps to existing player/taste capabilities; the taste-driven
 *  ones (Auto-DJ, Radio, Smart shuffle) fall back gracefully when nothing's analysed. */
export function PlaylistPlaySheet({ tracks, onClose }: { tracks: Track[]; onClose: () => void }) {
  const play = (q: Track[]) => { if (q.length) void usePlayer.getState().playFrom(q, 0); onClose(); };
  const stat = (id: string) => useRatings.getState().stats[id] ?? { rating: 0, plays: 0, lastPlayed: 0 };

  const autoDj = () => {
    if (hasTauri) { void usePlayer.getState().startEndlessSet(tracks[0], tracks); onClose(); }
    else play(shuffle(tracks)); // no native engine → plain shuffle
  };
  const smartShuffle = async () => {
    onClose();
    if (!hasTauri || !tracks[0]) { void usePlayer.getState().playFrom(shuffle(tracks), 0); return; }
    // taste-aware: start from a seed, then order the rest by similarity to it (smooth flow, not jarring).
    const seed = tracks[Math.floor(Math.random() * tracks.length)];
    const sim = await taste.similar(seed.id, tracks.length);
    if (!sim.length) { void usePlayer.getState().playFrom(shuffle(tracks), 0); return; }
    const rank = new Map(sim.map(([id], i) => [id, i] as const));
    const ordered = [seed, ...tracks.filter((t) => t.id !== seed.id).sort((a, b) => (rank.get(a.id) ?? 1e9) - (rank.get(b.id) ?? 1e9))];
    void usePlayer.getState().playFrom(ordered, 0);
  };
  const radio = async () => {
    onClose();
    if (!hasTauri || !tracks[0]) { toast.info("Song radio needs the app build."); return; }
    const sim = await taste.similar(tracks[0].id, 60);
    if (!sim.length) { toast.info("Analyze your library in Settings → For You to use Radio."); return; }
    const byId = new Map(usePlayer.getState().library.map((t) => [t.id, t] as const));
    const q = [tracks[0], ...sim.map(([id]) => byId.get(id)).filter((t): t is Track => !!t && t.id !== tracks[0].id)];
    void usePlayer.getState().playFrom(q, 0);
    toast.success(`Radio · ${q.length} songs`);
  };

  const items: { icon: string; label: string; sub?: string; on: () => void; hero?: boolean }[] = [
    { icon: "play", label: "Play in order", on: () => play(tracks), hero: true },
    { icon: "shuffle", label: "Shuffle", on: () => play(shuffle(tracks)) },
    { icon: "favorite", label: "Smart shuffle", sub: "Taste-aware flow", on: () => void smartShuffle() },
    { icon: "allInclusive", label: "Auto-DJ mix", sub: "Beatmatched, gapless", on: autoDj },
    { icon: "graphicEq", label: "Song radio", sub: "Keeps going with similar songs", on: () => void radio() },
    { icon: "playNextIcon", label: "Play next", on: () => { usePlayer.getState().playNext(tracks); onClose(); } },
    { icon: "queue", label: "Add to queue", on: () => { usePlayer.getState().addToQueue(tracks); onClose(); } },
    { icon: "prev", label: "Reverse order", on: () => play([...tracks].reverse()) },
    { icon: "star", label: "Most-played first", on: () => play([...tracks].sort((a, b) => stat(b.id).plays - stat(a.id).plays)) },
    { icon: "bolt", label: "Newest first", on: () => play([...tracks].sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0))) },
  ];

  return (
    <Sheet onClose={onClose} tall>
      <header className="wp-sheet-head">
        <Icon name="playlist" size={22} color="var(--md-primary)" />
        <div className="wp-row-text"><div className="md-title-s">Play</div><div className="md-body-s wp-muted">{tracks.length} songs · pick a way</div></div>
      </header>
      <div className="wp-sheet-actions">
        {items.map((it) => (
          <button key={it.label} className={`wp-sheet-item ${it.hero ? "wp-sheet-hero" : ""}`} onClick={it.on}>
            <Icon name={it.icon} size={22} color={it.hero ? "var(--md-primary)" : undefined} />
            <span className="md-body-l">{it.label}</span>
            {it.sub && <span className="md-body-s wp-muted">{it.sub}</span>}
          </button>
        ))}
      </div>
    </Sheet>
  );
}
