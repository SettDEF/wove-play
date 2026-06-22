import { useEffect, useMemo, useRef } from "react";
import { useLyrics } from "@/store/lyrics";
import { usePlayer } from "@/store/player";
import { useSettings } from "@/store/settings";
import { parseLrc, activeLine } from "@/lib/lrc";
import { lyricsSearchUrl, LYRICS_PROVIDERS, type LyricsProvider } from "@/lib/lyricsProviders";
import { openUrl, loadLyrics } from "@/lib/backend";
import { Icon } from "./Icons";

/** Synced/plain lyrics for the current track. Highlights & auto-scrolls the active line. */
export function LyricsView({ id, position }: { id: string; position: number }) {
  const text = useLyrics((s) => s.map[id] ?? "");
  const setLyrics = useLyrics((s) => s.set);
  const provider = useSettings((s) => s.lyricsProvider);
  const fileRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lines = useMemo(() => parseLrc(text), [text]);
  const synced = lines.some((l) => l.t >= 0);
  const active = synced ? activeLine(lines, position) : -1;

  useEffect(() => {
    if (active < 0 || !scrollRef.current) return;
    const el = scrollRef.current.querySelector<HTMLElement>(`[data-i="${active}"]`);
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [active]);

  // Auto-load a sidecar `.lrc`/`.txt` next to the track (once per id) so synced lyrics just work.
  const tried = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (text || tried.current.has(id)) return;
    tried.current.add(id);
    const tr = usePlayer.getState().library.find((t) => t.id === id) ?? usePlayer.getState().current();
    const path = tr?.path;
    if (!path) return;
    let alive = true;
    loadLyrics(path).then((lrc) => { if (alive && lrc) setLyrics(id, lrc); });
    return () => { alive = false; };
  }, [id, text, setLyrics]);

  const onFile = (f: File | undefined) => { if (f) f.text().then((t) => setLyrics(id, t)); };

  /** Open the current track's lyrics in an external app/site. On Android the OS shows its native
   *  "Open with… (Just once / Always)" dialog so you can launch (or default to) e.g. the Genius app. */
  const openIn = (p: LyricsProvider) => {
    const tr = usePlayer.getState().library.find((t) => t.id === id) ?? usePlayer.getState().current();
    if (tr) void openUrl(lyricsSearchUrl(p, tr.artist, tr.title));
  };
  const findOnline = () => openIn(provider);

  if (!text) {
    return (
      <div className="wp-lyrics wp-lyrics-empty">
        <input ref={fileRef} type="file" accept=".lrc,.txt,text/plain" style={{ display: "none" }}
          onChange={(e) => { onFile(e.target.files?.[0]); e.target.value = ""; }} />
        <Icon name="lyrics" size={40} color="var(--md-on-surface-variant)" />
        <div className="md-body-m wp-muted">No lyrics for this track.</div>
        <div className="wp-lyrics-actions">
          <button className="wp-filled-btn wp-btn-sm" onClick={findOnline}><Icon name="search" size={16} /> Find lyrics online</button>
          <button className="wp-text-btn md-label-l" onClick={() => fileRef.current?.click()}><Icon name="add" size={16} /> Add .lrc / .txt</button>
        </div>
        <div className="wp-lyrics-apps">
          <span className="md-label-s wp-muted">Open in app</span>
          {LYRICS_PROVIDERS.map((p) => <button key={p.id} className="wp-chip wp-chip-sm" onClick={() => openIn(p.id)} title={`Open in ${p.label}`}>{p.label}</button>)}
        </div>
      </div>
    );
  }

  return (
    <div className="wp-lyrics" ref={scrollRef}>
      <div className="wp-lyrics-tools">
        <button className="wp-text-btn md-label-m" onClick={findOnline} title="Open lyrics in an external app"><Icon name="search" size={14} /> Find lyrics online</button>
        <span className="wp-lyrics-apps-inline">
          {LYRICS_PROVIDERS.map((p) => <button key={p.id} className="wp-chip wp-chip-sm" onClick={() => openIn(p.id)} title={`Open in ${p.label}`}>{p.label}</button>)}
        </span>
      </div>
      {lines.map((l, i) => (
        <div key={i} data-i={i} className={`wp-lyric-line ${i === active ? "wp-lyric-on" : ""} ${synced && l.t < 0 ? "wp-muted" : ""}`}>
          {l.text || " "}
        </div>
      ))}
    </div>
  );
}
