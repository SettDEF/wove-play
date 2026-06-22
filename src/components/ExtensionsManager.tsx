import { useState } from "react";
import { createPortal } from "react-dom";
import { Sheet } from "./Sheet";
import { Icon } from "./Icons";
import { useSettings } from "@/store/settings";
import { searchExtensions, playExtensionResults } from "@/lib/extensions";
import type { Track } from "@/lib/types";

/** Install + manage source extensions (sandboxed Workers) and search across the enabled ones. */
export function ExtensionsManager({ onClose }: { onClose: () => void }) {
  const exts = useSettings((s) => s.extensions);
  const setExtensions = useSettings((s) => s.setExtensions);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<{ name: string; tracks: Track[]; error?: string }[]>([]);
  const [searching, setSearching] = useState(false);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [code, setCode] = useState("");

  const enabledCount = exts.filter((e) => e.enabled).length;
  const flat = results.flatMap((r) => r.tracks);

  const search = async () => {
    if (!q.trim()) return;
    setSearching(true);
    const r = await searchExtensions(q.trim());
    setResults(r.map((x) => ({ name: x.ext.name, tracks: x.tracks, error: x.error })));
    setSearching(false);
  };
  const add = () => {
    if (!name.trim() || !code.trim()) return;
    setExtensions([...exts, { id: `${Date.now()}`, name: name.trim(), code, enabled: true }]);
    setName(""); setCode(""); setAdding(false);
  };
  const toggle = (id: string) => setExtensions(exts.map((e) => (e.id === id ? { ...e, enabled: !e.enabled } : e)));
  const remove = (id: string) => setExtensions(exts.filter((e) => e.id !== id));

  return createPortal(
    <Sheet onClose={onClose} tall>
      <header className="wp-sheet-head"><Icon name="allInclusive" size={20} /><div className="md-title-s">Extensions</div></header>

      {enabledCount > 0 && (<>
        <div style={{ display: "flex", gap: 6, margin: "4px 6px" }}>
          <input className="wp-search-input md-body-l" style={{ flex: 1 }} placeholder="Search installed sources…" value={q}
            onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") search(); }} />
          <button className="wp-filled-btn" onClick={search}><Icon name="search" size={18} /></button>
        </div>
        {searching && <div className="md-body-s wp-muted" style={{ padding: "8px" }}>Searching…</div>}
        <div className="wp-radio-list">
          {results.map((g) => g.error
            ? <div key={g.name} className="md-body-s wp-muted" style={{ padding: "4px 8px" }}>{g.name}: {g.error}</div>
            : g.tracks.map((t) => (
              <button key={t.id} className="wp-radio-row" onClick={() => { playExtensionResults(flat, flat.indexOf(t), g.name); onClose(); }}>
                <div className="wp-radio-ico">{t.artUrl ? <img src={t.artUrl} alt="" loading="lazy" /> : <Icon name="music" size={18} />}</div>
                <div className="wp-radio-meta"><div className="md-body-m ellipsis">{t.title}</div><div className="md-body-s wp-muted ellipsis">{t.artist} · {g.name}</div></div>
                <Icon name="play" size={18} />
              </button>
            )))}
        </div>
      </>)}

      <h3 className="md-title-s wp-set-head" style={{ marginTop: 8 }}>Installed</h3>
      <div className="md-body-s wp-muted" style={{ padding: "0 8px 6px" }}>
        Extensions run sandboxed (no access to your files or the app) but can use the network. Only install code you trust.
      </div>
      <div className="wp-radio-list">
        {exts.map((e) => (
          <div key={e.id} className="wp-radio-row">
            <div className="wp-radio-meta"><div className="md-body-m ellipsis">{e.name}</div><div className="md-body-s wp-muted">{e.enabled ? "Enabled" : "Disabled"}</div></div>
            <button className="md-icon-btn" onClick={() => toggle(e.id)} title={e.enabled ? "Disable" : "Enable"}><Icon name={e.enabled ? "close" : "play"} size={18} /></button>
            <button className="md-icon-btn" onClick={() => remove(e.id)} title="Remove"><Icon name="close" size={18} /></button>
          </div>
        ))}
      </div>
      {!exts.length && <div className="md-body-s wp-muted" style={{ padding: "4px 8px" }}>No extensions installed.</div>}

      {adding ? (
        <div style={{ padding: 6, display: "flex", flexDirection: "column", gap: 6 }}>
          <input className="wp-search-input md-body-l" placeholder="Extension name" value={name} onChange={(e) => setName(e.target.value)} />
          <textarea className="wp-search-input md-body-s"
            placeholder={"// self.search = async (q) => [{ title, artist, url, art, duration }]\n// fetch the network with: await woveFetch(url)"}
            value={code} onChange={(e) => setCode(e.target.value)} rows={8} style={{ resize: "vertical", fontFamily: "monospace" }} />
          <div style={{ display: "flex", gap: 6 }}>
            <button className="wp-filled-btn" onClick={add} style={{ flex: 1 }}><Icon name="add" size={18} /> Install</button>
            <button className="wp-tonal-btn" onClick={() => setAdding(false)}>Cancel</button>
          </div>
        </div>
      ) : (
        <button className="wp-tonal-btn" onClick={() => setAdding(true)} style={{ margin: 6 }}><Icon name="add" size={18} /> Add extension</button>
      )}
    </Sheet>,
    document.body,
  );
}
