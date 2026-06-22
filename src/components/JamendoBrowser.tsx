import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Sheet } from "./Sheet";
import { Icon } from "./Icons";
import { jamendoSearch, playJamendo, hasJamendoKey } from "@/lib/jamendo";
import { fmtTime } from "@/lib/format";
import type { Track } from "@/lib/types";

/** Browse + search Jamendo's Creative-Commons catalogue; tap a track to play the result list from there. */
export function JamendoBrowser({ onClose, onNeedKey }: { onClose: () => void; onNeedKey: () => void }) {
  const [q, setQ] = useState("");
  const [tracks, setTracks] = useState<Track[]>([]);
  const [loading, setLoading] = useState(true);
  const keyed = hasJamendoKey();

  useEffect(() => {
    if (!keyed) { setLoading(false); return; }
    let alive = true;
    setLoading(true);
    const id = setTimeout(async () => {
      const list = await jamendoSearch(q);
      if (alive) { setTracks(list); setLoading(false); }
    }, q ? 350 : 0);
    return () => { alive = false; clearTimeout(id); };
  }, [q, keyed]);

  return createPortal(
    <Sheet onClose={onClose} tall>
      <header className="wp-sheet-head"><Icon name="allInclusive" size={20} /><div className="md-title-s">Free music · Jamendo</div></header>
      {!keyed ? (
        <div style={{ padding: "12px 8px" }}>
          <div className="md-body-m">Add a free Jamendo client ID to browse Creative-Commons music.</div>
          <div className="md-body-s wp-muted" style={{ margin: "6px 0 10px" }}>Get one at developer.jamendo.com → paste it in Settings.</div>
          <button className="wp-filled-btn" onClick={onNeedKey}><Icon name="edit" size={18} /> Add client ID</button>
        </div>
      ) : (<>
        <input className="wp-search-input md-body-l" style={{ margin: "4px 6px" }} placeholder="Search tracks…"
          value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
        {loading && <div className="md-body-s wp-muted" style={{ padding: "8px" }}>Loading…</div>}
        <div className="wp-radio-list">
          {tracks.map((t, i) => (
            <button key={t.id} className="wp-radio-row" onClick={() => { playJamendo(tracks, i); onClose(); }}>
              <div className="wp-radio-ico">{t.artUrl ? <img src={t.artUrl} alt="" loading="lazy" /> : <Icon name="music" size={18} />}</div>
              <div className="wp-radio-meta">
                <div className="md-body-m ellipsis">{t.title}</div>
                <div className="md-body-s wp-muted ellipsis">{t.artist}{t.duration ? ` · ${fmtTime(t.duration)}` : ""}</div>
              </div>
              <Icon name="play" size={18} />
            </button>
          ))}
        </div>
        {!loading && !tracks.length && <div className="md-body-s wp-muted" style={{ padding: "8px" }}>No tracks found.</div>}
      </>)}
    </Sheet>,
    document.body,
  );
}
