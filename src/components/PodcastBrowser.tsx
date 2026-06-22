import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Sheet } from "./Sheet";
import { Icon } from "./Icons";
import { fmtTime } from "@/lib/format";
import { useSettings } from "@/store/settings";
import { fetchFeed, playEpisodes, subscribe, unsubscribe, type Feed } from "@/lib/podcasts";

/** Subscribe to podcast RSS feeds, browse episodes, play them (via the Phase-1 stream pipeline). */
export function PodcastBrowser({ onClose }: { onClose: () => void }) {
  const subs = useSettings((s) => s.podcasts);
  const [add, setAdd] = useState("");
  const [feed, setFeed] = useState<Feed | null>(null); // open feed → episodes view
  const [loading, setLoading] = useState(false);
  const [cache, setCache] = useState<Record<string, Feed>>({});

  useEffect(() => { // lazily fetch each subscription's title/art for the list
    let alive = true;
    subs.forEach(async (u) => {
      if (cache[u]) return;
      const f = await fetchFeed(u);
      if (alive && f) setCache((p) => ({ ...p, [u]: f }));
    });
    return () => { alive = false; };
  }, [subs]); // eslint-disable-line react-hooks/exhaustive-deps

  const openFeed = async (u: string) => { setLoading(true); const f = cache[u] ?? await fetchFeed(u); setFeed(f); setLoading(false); };
  const addFeed = async () => {
    const u = add.trim(); if (!u) return;
    setLoading(true); const f = await fetchFeed(u); setLoading(false);
    if (f) { subscribe(u); setCache((p) => ({ ...p, [u]: f })); setAdd(""); }
  };

  return createPortal(
    <Sheet onClose={feed ? () => setFeed(null) : onClose} tall>
      <header className="wp-sheet-head">
        {feed && <button className="md-icon-btn" onClick={() => setFeed(null)} title="Back"><Icon name="prev" size={20} /></button>}
        <Icon name="music" size={20} /><div className="md-title-s">{feed ? feed.title : "Podcasts"}</div>
      </header>
      {!feed ? (<>
        <div style={{ display: "flex", gap: 6, margin: "4px 6px" }}>
          <input className="wp-search-input md-body-l" style={{ flex: 1 }} placeholder="Add podcast RSS feed URL…" value={add}
            onChange={(e) => setAdd(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") addFeed(); }} />
          <button className="wp-filled-btn" onClick={addFeed}><Icon name="add" size={18} /></button>
        </div>
        {loading && <div className="md-body-s wp-muted" style={{ padding: "8px" }}>Loading…</div>}
        <div className="wp-radio-list">
          {subs.map((u) => {
            const f = cache[u];
            return (
              <div key={u} className="wp-radio-row" style={{ cursor: "pointer" }} onClick={() => openFeed(u)}>
                <div className="wp-radio-ico">{f?.image ? <img src={f.image} alt="" loading="lazy" /> : <Icon name="music" size={18} />}</div>
                <div className="wp-radio-meta">
                  <div className="md-body-m ellipsis">{f?.title ?? u}</div>
                  <div className="md-body-s wp-muted ellipsis">{f ? `${f.episodes.length} episodes` : "Loading…"}</div>
                </div>
                <button className="md-icon-btn" title="Unsubscribe" onClick={(e) => { e.stopPropagation(); unsubscribe(u); }}><Icon name="close" size={18} /></button>
              </div>
            );
          })}
        </div>
        {!subs.length && <div className="md-body-s wp-muted" style={{ padding: "8px" }}>No subscriptions yet — paste a podcast RSS URL above.</div>}
      </>) : (
        <div className="wp-radio-list">
          {feed.episodes.map((ep, i) => (
            <button key={ep.id} className="wp-radio-row" onClick={() => { playEpisodes(feed.episodes, i); onClose(); }}>
              <div className="wp-radio-ico">{ep.image ? <img src={ep.image} alt="" loading="lazy" /> : <Icon name="music" size={18} />}</div>
              <div className="wp-radio-meta">
                <div className="md-body-m ellipsis">{ep.title}</div>
                <div className="md-body-s wp-muted ellipsis">{[ep.date?.replace(/ \d{2}:.*$/, ""), ep.duration ? fmtTime(ep.duration) : ""].filter(Boolean).join(" · ")}</div>
              </div>
              <Icon name="play" size={18} />
            </button>
          ))}
        </div>
      )}
    </Sheet>,
    document.body,
  );
}
