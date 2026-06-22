import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Sheet } from "./Sheet";
import { Icon } from "./Icons";
import { searchStations, playStation, type Station } from "@/lib/radio";

/** Browse + search internet radio (Radio-Browser), tap a station to play it. */
export function RadioBrowser({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState("");
  const [stations, setStations] = useState<Station[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    const id = setTimeout(async () => {
      const list = await searchStations(q);
      if (alive) { setStations(list); setLoading(false); }
    }, q ? 350 : 0); // debounce typing
    return () => { alive = false; clearTimeout(id); };
  }, [q]);

  return createPortal(
    <Sheet onClose={onClose} tall>
      <header className="wp-sheet-head"><Icon name="cast" size={20} /><div className="md-title-s">Internet radio</div></header>
      <input className="wp-search-input md-body-l" style={{ margin: "4px 6px" }} placeholder="Search stations…"
        value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
      {loading && <div className="md-body-s wp-muted" style={{ padding: "8px" }}>Loading…</div>}
      <div className="wp-radio-list">
        {stations.map((s) => (
          <button key={s.id} className="wp-radio-row" onClick={() => { playStation(s); onClose(); }}>
            <div className="wp-radio-ico">
              {s.favicon
                ? <img src={s.favicon} alt="" loading="lazy" onError={(e) => { e.currentTarget.style.visibility = "hidden"; }} />
                : <Icon name="cast" size={18} />}
            </div>
            <div className="wp-radio-meta">
              <div className="md-body-m ellipsis">{s.name}</div>
              <div className="md-body-s wp-muted ellipsis">
                {[s.country, s.tags?.split(",").slice(0, 2).join(", "), s.bitrate ? `${s.bitrate} kbps` : ""].filter(Boolean).join(" · ")}
              </div>
            </div>
            <Icon name="play" size={18} />
          </button>
        ))}
      </div>
      {!loading && !stations.length && <div className="md-body-s wp-muted" style={{ padding: "8px" }}>No stations found.</div>}
    </Sheet>,
    document.body,
  );
}
