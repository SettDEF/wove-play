import { useState } from "react";
import { createPortal } from "react-dom";
import type { SmartField, SmartOp, SmartRule } from "@/store/playlists";
import { Icon } from "./Icons";
import { Sheet } from "./Sheet";

const FIELDS: SmartField[] = ["title", "artist", "album", "genre", "recent", "rating", "plays"];
const FIELD_LABEL: Record<SmartField, string> = { title: "Title", artist: "Artist", album: "Album", genre: "Genre", recent: "Added (days)", rating: "Rating", plays: "Play count" };
const NUMERIC: SmartField[] = ["recent", "rating", "plays"];
const opsFor = (f: SmartField): SmartOp[] => (f === "recent" ? ["within"] : NUMERIC.includes(f) ? ["within", "is"] : ["contains", "is"]);
const OP_LABEL: Record<SmartOp, string> = { contains: "contains", is: "is", within: "at least" };

/** Create / edit a smart playlist: name + match-all/any + cycling field/op rules. */
export function SmartEditor({ initial, onClose, onSave }: {
  initial?: { name: string; rules?: SmartRule[]; match?: "all" | "any" };
  onClose: () => void;
  onSave: (name: string, rules: SmartRule[], match: "all" | "any") => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [match, setMatch] = useState<"all" | "any">(initial?.match ?? "all");
  const [rules, setRules] = useState<SmartRule[]>(initial?.rules?.length ? initial.rules : [{ field: "artist", op: "contains", value: "" }]);

  const upd = (i: number, patch: Partial<SmartRule>) => setRules((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const cycleField = (i: number) => {
    const r = rules[i]; const nf = FIELDS[(FIELDS.indexOf(r.field) + 1) % FIELDS.length];
    upd(i, { field: nf, op: opsFor(nf)[0], value: nf === "recent" ? "30" : nf === "rating" ? "4" : nf === "plays" ? "5" : "" });
  };
  const cycleOp = (i: number) => { const r = rules[i]; const ops = opsFor(r.field); upd(i, { op: ops[(ops.indexOf(r.op) + 1) % ops.length] }); };
  const addRule = () => setRules((rs) => [...rs, { field: "artist", op: "contains", value: "" }]);
  const save = () => { onSave(name || "Smart playlist", rules.filter((r) => r.field === "recent" || r.value.trim()), match); onClose(); };

  return createPortal(
    <Sheet onClose={onClose} tall={false}>
        <header className="wp-sheet-head"><Icon name="bolt" size={22} color="var(--md-primary)" /><div className="md-title-s">{initial ? "Edit smart playlist" : "New smart playlist"}</div></header>
        <div className="wp-sheet-actions">
          <div className="wp-newpl"><input className="wp-search-input md-body-l" placeholder="Playlist name" value={name} onChange={(e) => setName(e.target.value)} /></div>
          <div className="wp-set-row"><div className="wp-row-text"><div className="md-body-l">Match</div></div>
            <div className="wp-seg wp-seg-sm">
              <button className={`wp-seg-item ${match === "all" ? "wp-seg-on" : ""}`} onClick={() => setMatch("all")}>All</button>
              <button className={`wp-seg-item ${match === "any" ? "wp-seg-on" : ""}`} onClick={() => setMatch("any")}>Any</button>
            </div>
          </div>
          {rules.map((r, i) => (
            <div className="wp-rule" key={i}>
              <button className="wp-chip wp-chip-on" onClick={() => cycleField(i)} title="Tap to change field">{FIELD_LABEL[r.field]}</button>
              <button className="wp-chip" onClick={() => cycleOp(i)} title="Tap to change">{OP_LABEL[r.op]}</button>
              <input className="wp-search-input md-body-m wp-rule-val" placeholder={r.field === "recent" ? "days" : "value"}
                inputMode={r.field === "recent" ? "numeric" : "text"} value={r.value} onChange={(e) => upd(i, { value: e.target.value })} />
              {rules.length > 1 && <button className="md-icon-btn wp-icon-sm" onClick={() => setRules((rs) => rs.filter((_, j) => j !== i))}><Icon name="close" size={16} /></button>}
            </div>
          ))}
          <button className="wp-text-btn md-label-l" onClick={addRule}><Icon name="add" size={16} /> Add rule</button>
          <button className="wp-filled-btn" onClick={save} style={{ marginTop: 6 }}><Icon name="bolt" size={18} /> Save smart playlist</button>
        </div>
    </Sheet>,
    document.body,
  );
}
