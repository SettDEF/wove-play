import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Sheet } from "./Sheet";
import { Icon } from "./Icons";
import { subsonicSearch, playSubsonic, hasSubsonic, subsonicPing } from "@/lib/subsonic";
import { fmtTime } from "@/lib/format";
import type { Track } from "@/lib/types";

/** Browse + search a Subsonic/Navidrome server; tap a track to play the result list from there. */
export function SubsonicBrowser({ onClose, onNeedKey }: { onClose: () => void; onNeedKey: () => void }) {
  const [q, setQ] = useState("");
  const [tracks, setTracks] = useState<Track[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const keyed = hasSubsonic();

  useEffect(() => {
    if (!keyed) { setLoading(false); return; }
    let alive = true;
    setLoading(true); setErr("");
    const id = setTimeout(async () => {
      if (!q && !(await subsonicPing())) { if (alive) { setErr("Couldn't reach the server (check URL / credentials)."); setLoading(false); } return; }
      const list = await subsonicSearch(q);
      if (alive) { setTracks(list); setLoading(false); }
    }, q ? 350 : 0);
    return () => { alive = false; clearTimeout(id); };
  }, [q, keyed]);

  return createPortal(
    <Sheet onClose={onClose} tall>
      <header className="wp-sheet-head"><Icon name="cast" size={20} /><div className="md-title-s">My server · Subsonic</div></header>
      {!keyed ? (
        <div style={{ padding: "12px 8px" }}>
          <div className="md-body-m">Add your Subsonic/Navidrome server URL + login to stream your own library.</div>
          <button className="wp-filled-btn" onClick={onNeedKey} style={{ marginTop: 10 }}><Icon name="edit" size={18} /> Add server</button>
        </div>
      ) : (<>
        <input className="wp-search-input md-body-l" style={{ margin: "4px 6px" }} placeholder="Search your library…"
          value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
        {loading && <div className="md-body-s wp-muted" style={{ padding: "8px" }}>Loading…</div>}
        {err && <div className="md-body-s wp-muted" style={{ padding: "8px" }}>{err}</div>}
        <div className="wp-radio-list">
          {tracks.map((t, i) => (
            <button key={t.id} className="wp-radio-row" onClick={() => { playSubsonic(tracks, i); onClose(); }}>
              <div className="wp-radio-ico">{t.artUrl ? <img src={t.artUrl} alt="" loading="lazy" /> : <Icon name="music" size={18} />}</div>
              <div className="wp-radio-meta">
                <div className="md-body-m ellipsis">{t.title}</div>
                <div className="md-body-s wp-muted ellipsis">{t.artist}{t.duration ? ` · ${fmtTime(t.duration)}` : ""}</div>
              </div>
              <Icon name="play" size={18} />
            </button>
          ))}
        </div>
        {!loading && !err && !tracks.length && <div className="md-body-s wp-muted" style={{ padding: "8px" }}>No tracks found.</div>}
      </>)}
    </Sheet>,
    document.body,
  );
}
