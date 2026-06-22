import { useMemo, useState } from "react";
import { usePlayer, EQ_PRESETS, EQ_FREQS } from "@/store/player";
import { useEqPresets } from "@/store/eqPresets";
import { useEqAssign } from "@/store/eqAssign";
import { useSettings } from "@/store/settings";
import { listOutputProfiles, applyEq } from "@/store/outputs";
import { toast } from "@/store/toasts";
import { Sheet } from "./Sheet";
import { EqThumb } from "./EqThumb";
import { Icon } from "./Icons";

type Cat = "all" | "graphic" | "parametric" | "user" | "assigned" | "device";
const CATS: { id: Cat; label: string }[] = [
  { id: "all", label: "All" },
  { id: "graphic", label: "Graphic" },
  { id: "parametric", label: "Parametric" },
  { id: "user", label: "User" },
  { id: "assigned", label: "Assigned" },
  { id: "device", label: "Device" },
];

type Source = "built" | "user" | "assigned" | "device";
interface Item {
  key: string; name: string; sub: string; source: Source; graphic: boolean;
  thumb: { gains: number[]; freqs?: number[]; qs?: number[]; preamp?: number };
  apply: () => void; remove?: () => void;
}

const DEFAULT_Q = 1.1;
/** A curve is "graphic" if it only changes gains (default band centres + Q), else "parametric". */
function isGraphic(freqs?: number[], qs?: number[]): boolean {
  const fOk = !freqs || freqs.every((f, i) => Math.abs(f - EQ_FREQS[i]) < 0.5);
  const qOk = !qs || qs.every((q) => Math.abs(q - DEFAULT_Q) < 0.01);
  return fOk && qOk;
}

/** Poweramp-style preset browser: search + category chips (All / Graphic / Parametric / User /
 *  Assigned / Device), each preset shown with its curve thumbnail. Tap to apply; user + per-song
 *  presets can be deleted. */
export function PresetBrowser({ onClose }: { onClose: () => void }) {
  const presetName = usePlayer((s) => s.presetName);
  const userPresets = useEqPresets((s) => s.presets);
  const songs = useEqAssign((s) => s.songs);
  const btEqMap = useSettings((s) => s.btEqMap);
  const btDevices = useSettings((s) => s.btDevices);
  const [cat, setCat] = useState<Cat>("all");
  const [q, setQ] = useState("");

  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];
    // built-in (always graphic — gains only)
    for (const p of EQ_PRESETS) out.push({
      key: `b:${p.name}`, name: p.name, sub: "Built-in", source: "built", graphic: true,
      thumb: { gains: p.gains, preamp: p.preamp },
      apply: () => usePlayer.getState().applyPreset(p),
    });
    // user presets (full curves)
    for (const s of userPresets) out.push({
      key: `u:${s.name}`, name: s.name, sub: "User preset", source: "user", graphic: isGraphic(s.freqs, s.qs),
      thumb: { gains: s.gains, freqs: s.freqs, qs: s.qs, preamp: s.preamp },
      apply: () => usePlayer.getState().applyEqSnapshot(s, true),
      remove: () => { useEqPresets.getState().remove(s.name); toast.info(`Deleted “${s.name}”.`); },
    });
    // assigned (per-song pins) — resolve titles from the library snapshot
    const songIds = Object.keys(songs);
    if (songIds.length) {
      const lib = usePlayer.getState().library;
      const byId = new Map(lib.map((t) => [t.id, t]));
      for (const id of songIds) {
        const snap = songs[id]; const tr = byId.get(id);
        out.push({
          key: `a:${id}`, name: tr ? tr.title : snap.name || "Song", sub: tr ? `Song · ${tr.artist}` : "Song preset",
          source: "assigned", graphic: isGraphic(snap.freqs, snap.qs),
          thumb: { gains: snap.gains, freqs: snap.freqs, qs: snap.qs, preamp: snap.preamp },
          apply: () => usePlayer.getState().applyEqSnapshot(snap, true),
          remove: () => { useEqAssign.getState().unpin(id); toast.info("EQ unpinned from song."); },
        });
      }
    }
    // device — saved per-output profiles
    for (const { id, snap } of listOutputProfiles()) out.push({
      key: `d:${id}`, name: "Output EQ", sub: `Output · ${id.slice(0, 6)}`, source: "device", graphic: isGraphic(snap.freqs, snap.qs),
      thumb: { gains: snap.bands, freqs: snap.freqs, qs: snap.qs, preamp: snap.preamp },
      apply: () => applyEq(snap),
    });
    // device — Bluetooth device → preset mappings (resolve the named preset's curve)
    for (const [mac, pname] of Object.entries(btEqMap)) {
      if (!pname) continue;
      const built = EQ_PRESETS.find((p) => p.name === pname);
      const usr = userPresets.find((p) => p.name === pname);
      if (!built && !usr) continue;
      const devName = btDevices.find((d) => d.address === mac)?.name || mac;
      out.push({
        key: `bt:${mac}`, name: devName, sub: `Bluetooth → ${pname}`, source: "device",
        graphic: usr ? isGraphic(usr.freqs, usr.qs) : true,
        thumb: usr ? { gains: usr.gains, freqs: usr.freqs, qs: usr.qs, preamp: usr.preamp } : { gains: built!.gains, preamp: built!.preamp },
        apply: () => { if (usr) usePlayer.getState().applyEqSnapshot(usr, true); else usePlayer.getState().applyPreset(built!); },
      });
    }
    return out;
  }, [userPresets, songs, btEqMap, btDevices]);

  const shown = useMemo(() => {
    let list = items;
    if (cat === "graphic") list = list.filter((i) => (i.source === "built" || i.source === "user") && i.graphic);
    else if (cat === "parametric") list = list.filter((i) => (i.source === "built" || i.source === "user") && !i.graphic);
    else if (cat === "user") list = list.filter((i) => i.source === "user");
    else if (cat === "assigned") list = list.filter((i) => i.source === "assigned");
    else if (cat === "device") list = list.filter((i) => i.source === "device");
    const needle = q.trim().toLowerCase();
    if (needle) list = list.filter((i) => i.name.toLowerCase().includes(needle) || i.sub.toLowerCase().includes(needle));
    return list;
  }, [items, cat, q]);

  const pick = (it: Item) => { it.apply(); toast.success(`Applied “${it.name}”.`); onClose(); };

  return (
    <Sheet onClose={onClose} className="wp-presetbrowser">
      <div className="wp-pb-search">
        <Icon name="search" size={18} color="var(--md-on-surface-variant)" />
        <input className="wp-pb-input" placeholder="Search presets…" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
        {q && <button className="md-icon-btn" onClick={() => setQ("")}><Icon name="close" size={16} /></button>}
      </div>
      <div className="wp-pb-chips">
        {CATS.map((c) => (
          <button key={c.id} className={`wp-chip ${cat === c.id ? "wp-chip-on" : ""}`} onClick={() => setCat(c.id)}>{c.label}</button>
        ))}
      </div>
      <div className="wp-pb-list">
        {shown.length === 0 && <div className="wp-pb-empty md-body-m wp-muted">No presets{q ? " match your search" : " here yet"}.</div>}
        {shown.map((it) => (
          <div key={it.key} className={`wp-pb-item ${presetName === it.name ? "wp-pb-on" : ""}`}>
            <button className="wp-pb-pick" onClick={() => pick(it)}>
              <span className="wp-pb-thumb"><EqThumb gains={it.thumb.gains} freqs={it.thumb.freqs} qs={it.thumb.qs} preamp={it.thumb.preamp} /></span>
              <span className="wp-pb-text">
                <span className="md-body-l ellipsis">{it.name}</span>
                <span className="md-body-s wp-muted ellipsis">{it.sub}</span>
              </span>
              {presetName === it.name && <Icon name="check" size={18} color="var(--md-primary)" />}
            </button>
            {it.remove && <button className="wp-pb-del md-icon-btn" title="Delete" onClick={it.remove}><Icon name="trash" size={17} /></button>}
          </div>
        ))}
      </div>
    </Sheet>
  );
}
