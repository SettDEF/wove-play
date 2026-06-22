import { useMemo } from "react";
import { usePlayer } from "@/store/player";
import { useRatings } from "@/store/ratings";
import type { Track } from "@/lib/types";
import { Cover } from "./Cover";
import { Icon } from "./Icons";

/** Human listening time: "12h 34m" / "34m" / "12s". */
function fmtSpan(sec: number): string {
  const s = Math.round(sec);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}
function ago(epochSec: number): string {
  const d = Math.floor(Date.now() / 1000) - epochSec;
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
}

/** Listening insights derived from play counts + ratings + library durations (all local). */
export function Stats() {
  const library = usePlayer((s) => s.library);
  const stats = useRatings((s) => s.stats);
  const playFrom = usePlayer((s) => s.playFrom);

  const d = useMemo(() => {
    const byId = new Map(library.map((t) => [t.id, t]));
    let totalPlays = 0, listenSec = 0, played = 0, favs = 0;
    const artistPlays = new Map<string, number>();
    const albumPlays = new Map<string, { plays: number; cover: string; artist: string; album: string }>();
    const playedTracks: { t: Track; plays: number; last: number }[] = [];
    for (const [id, s] of Object.entries(stats)) {
      if (s.rating >= 4) favs++;
      if (s.plays > 0) {
        totalPlays += s.plays;
        const t = byId.get(id);
        if (!t) continue;
        played++;
        listenSec += (t.duration || 0) * s.plays;
        artistPlays.set(t.artist, (artistPlays.get(t.artist) ?? 0) + s.plays);
        const ak = `${t.artist}|||${t.album}`;
        const a = albumPlays.get(ak) ?? { plays: 0, cover: t.path, artist: t.artist, album: t.album };
        a.plays += s.plays; albumPlays.set(ak, a);
        playedTracks.push({ t, plays: s.plays, last: s.lastPlayed });
      }
    }
    return {
      totalPlays, listenSec, played, favs,
      topArtists: [...artistPlays].sort((a, b) => b[1] - a[1]).slice(0, 5),
      topAlbums: [...albumPlays.values()].sort((a, b) => b.plays - a.plays).slice(0, 6),
      mostPlayed: [...playedTracks].sort((a, b) => b.plays - a.plays).slice(0, 8),
      recent: playedTracks.filter((p) => p.last > 0).sort((a, b) => b.last - a.last).slice(0, 8),
    };
  }, [library, stats]);

  if (d.totalPlays === 0) {
    return (
      <section className="wp-set-sec">
        <h3 className="md-title-s wp-set-head">Listening stats</h3>
        <div className="wp-empty"><Icon name="graphicEq" size={40} color="var(--md-on-surface-variant)" />
          <div className="md-body-m wp-muted">Play some music — your stats build up here.</div></div>
      </section>
    );
  }

  const cards = [
    { label: "Plays", value: String(d.totalPlays), icon: "play" },
    { label: "Listening time", value: fmtSpan(d.listenSec), icon: "timer" },
    { label: "Songs played", value: String(d.played), icon: "music" },
    { label: "Favorites", value: String(d.favs), icon: "favorite" },
  ];

  return (
    <section className="wp-set-sec wp-stats">
      <h3 className="md-title-s wp-set-head">Listening stats</h3>
      <div className="wp-stat-cards">
        {cards.map((c) => (
          <div key={c.label} className="wp-stat-card">
            <Icon name={c.icon} size={18} color="var(--md-primary)" />
            <div className="md-headline-s wp-stat-num">{c.value}</div>
            <div className="md-body-s wp-muted">{c.label}</div>
          </div>
        ))}
      </div>

      {d.topArtists.length > 0 && (
        <div className="wp-stat-block">
          <div className="md-label-m wp-muted wp-stat-h">TOP ARTISTS</div>
          {d.topArtists.map(([name, plays], i) => (
            <div key={name} className="wp-stat-row">
              <span className="wp-stat-rank md-title-s">{i + 1}</span>
              <div className="wp-row-text"><div className="md-body-l ellipsis">{name}</div></div>
              <span className="md-body-s wp-muted">{plays} play{plays === 1 ? "" : "s"}</span>
            </div>
          ))}
        </div>
      )}

      {d.mostPlayed.length > 0 && (
        <div className="wp-stat-block">
          <div className="md-label-m wp-muted wp-stat-h">MOST PLAYED</div>
          {d.mostPlayed.map(({ t, plays }, i) => (
            <button key={t.id} className="wp-stat-row wp-stat-row-btn" onClick={() => playFrom(d.mostPlayed.map((x) => x.t), i)}>
              <Cover path={t.path} size={38} />
              <div className="wp-row-text"><div className="md-body-l ellipsis">{t.title}</div><div className="md-body-s wp-muted ellipsis">{t.artist}</div></div>
              <span className="md-body-s wp-muted">{plays}×</span>
            </button>
          ))}
        </div>
      )}

      {d.recent.length > 0 && (
        <div className="wp-stat-block">
          <div className="md-label-m wp-muted wp-stat-h">RECENTLY PLAYED</div>
          {d.recent.map(({ t, last }, i) => (
            <button key={t.id} className="wp-stat-row wp-stat-row-btn" onClick={() => playFrom(d.recent.map((x) => x.t), i)}>
              <Cover path={t.path} size={38} />
              <div className="wp-row-text"><div className="md-body-l ellipsis">{t.title}</div><div className="md-body-s wp-muted ellipsis">{t.artist}</div></div>
              <span className="md-body-s wp-muted">{ago(last)}</span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
