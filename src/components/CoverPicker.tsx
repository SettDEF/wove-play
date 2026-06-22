import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { setCover, coverCacheClear, coverArt, httpGetBytes } from "@/lib/backend";
import type { Track } from "@/lib/types";
import { Icon } from "./Icons";
import { Sheet } from "./Sheet";

type Cand = { url: string; source: string; w?: number; h?: number };

/** Search the iTunes catalogue (no key, CORS-ok) using the track's EXISTING metadata; request hi-res art. */
async function itunesCovers(track: Track): Promise<Cand[]> {
  const artist = /unknown/i.test(track.artist || "") ? "" : (track.artist || "");
  const subject = track.album || track.title || "";
  const term = [artist, subject].filter(Boolean).join(" ").trim();
  if (!term) return [];
  try {
    const r = await fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=album&limit=18`);
    if (!r.ok) return [];
    const j = await r.json();
    const seen = new Set<string>();
    const out: Cand[] = [];
    for (const it of j.results ?? []) {
      const a: string | undefined = it.artworkUrl100;
      if (!a) continue;
      const hi = a.replace(/\/\d+x\d+bb\./, "/1200x1200bb."); // ask for a big version
      if (seen.has(hi)) continue;
      seen.add(hi);
      out.push({ url: hi, source: it.collectionName || "iTunes" });
    }
    return out;
  } catch {
    return [];
  }
}

/** Pick a new cover from a grid of candidates (current embedded + online), labelled with each one's real
 *  pixel size, and embed the chosen one into the file. */
export function CoverPicker({ track, onClose, onApplied }: { track: Track; onClose: () => void; onApplied?: () => void }) {
  const [cands, setCands] = useState<Cand[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      const list: Cand[] = [];
      const cur = await coverArt(track.path);
      if (cur) list.push({ url: cur, source: "Current" });
      const it = await itunesCovers(track);
      if (alive) { setCands([...list, ...it]); setLoading(false); }
    })();
    return () => { alive = false; };
  }, [track.path]);

  const pick = async (c: Cand) => {
    if (busy) return;
    setBusy(true); setStatus("Saving cover…");
    try {
      // fetch the image bytes via the Rust proxy (no CORS); fall back to a webview fetch
      let buf: Uint8Array | null = null, mime = "image/jpeg";
      const got = await httpGetBytes(c.url);
      if (got && got.data.length) { buf = got.data; mime = got.mime || mime; }
      else { const b = await (await fetch(c.url)).blob(); buf = new Uint8Array(await b.arrayBuffer()); mime = b.type || mime; }
      const ok = buf.length > 0 && (await setCover(track.path, buf, mime));
      if (ok) { await coverCacheClear(); onApplied?.(); onClose(); }
      else setStatus("Couldn't write the cover to this file.");
    } catch {
      setStatus("Couldn't fetch that image.");
    } finally { setBusy(false); }
  };

  return createPortal(
    <Sheet onClose={onClose} tall>
      <header className="wp-sheet-head"><Icon name="image" size={20} /><div className="md-title-s">Choose cover</div></header>
      {loading && <div className="md-body-s wp-muted" style={{ padding: "8px" }}>Searching…</div>}
      <div className="wp-cover-grid">
        {cands.map((c, i) => (
          <button key={i} className="wp-cover-cand" onClick={() => pick(c)} disabled={busy} title={c.source}>
            <img src={c.url} alt="" loading="lazy" onLoad={(e) => {
              const im = e.currentTarget, w = im.naturalWidth, h = im.naturalHeight;
              setCands((p) => p.map((x, xi) => (xi === i ? { ...x, w, h } : x)));
            }} />
            <span className="wp-cover-q md-label-s">{c.w ? `${c.w}×${c.h}` : c.source}</span>
          </button>
        ))}
      </div>
      {!loading && cands.length === 0 && <div className="md-body-s wp-muted" style={{ padding: "8px" }}>No covers found.</div>}
      {status && <div className="md-body-s wp-muted" style={{ padding: "4px 8px" }}>{status}</div>}
    </Sheet>,
    document.body,
  );
}
