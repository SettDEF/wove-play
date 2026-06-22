import { useState } from "react";
import { Sheet } from "./Sheet";
import { Icon } from "./Icons";
import type { DjCurve, DjSetOpts } from "@/lib/backend";

/** Energy-journey presets, in DJ language. */
const CURVES: { id: DjCurve; label: string; desc: string }[] = [
  { id: "rise", label: "Warm-up", desc: "Chilled → peak" },
  { id: "plateau", label: "Main set", desc: "Ramp up, hold high, ease out" },
  { id: "peak", label: "Peak time", desc: "Climb to a peak, then down" },
  { id: "wave", label: "Waves", desc: "Peaks and valleys" },
  { id: "descend", label: "Cool-down", desc: "High → low wind-down" },
];
const GENRES = ["Any", "Electronic", "Hip-Hop", "Pop", "Rock"];

/** Auto-mix options sheet — folds the DJ set planner into the Playlists UI. The parent runs the
 *  backend `djSet` over the library + turns the ordered result into a normal playlist. */
export function DjSetSheet({ onClose, onGenerate, busy }: {
  onClose: () => void;
  onGenerate: (opts: DjSetOpts) => void;
  busy?: boolean;
}) {
  const [curve, setCurve] = useState<DjCurve>("plateau");
  const [genre, setGenre] = useState("Any");
  const [harmonic, setHarmonic] = useState(true);
  const [len, setLen] = useState(20);

  const go = () => onGenerate({ curve, harmonic, max_len: len, genre: genre === "Any" ? undefined : genre });

  return (
    <Sheet onClose={onClose} tall={false} className="wp-djset">
      <div className="wp-sheet-head">
        <Icon name="allInclusive" size={20} color="var(--md-primary)" />
        <div className="wp-row-text">
          <div className="md-title-s">Auto-mix a DJ set</div>
          <div className="md-body-s wp-muted">Harmonic key + BPM ramp + energy curve, from your analyzed tracks</div>
        </div>
      </div>
      <div className="wp-djset-body">
        <div className="md-label-l wp-muted">Energy curve</div>
        <div className="wp-djset-curves">
          {CURVES.map((c) => (
            <button key={c.id} className={`wp-djset-curve ${curve === c.id ? "on" : ""}`} onClick={() => setCurve(c.id)}>
              <span className="md-body-l">{c.label}</span>
              <span className="md-body-s wp-muted">{c.desc}</span>
            </button>
          ))}
        </div>
        <div className="md-label-l wp-muted" style={{ marginTop: 4 }}>Genre</div>
        <div className="wp-seg wp-seg-sm">
          {GENRES.map((g) => (
            <button key={g} className={`wp-seg-item ${genre === g ? "wp-seg-on" : ""}`} onClick={() => setGenre(g)}>{g}</button>
          ))}
        </div>
        <div className="wp-djset-row">
          <span className="md-body-l">Harmonic mixing</span>
          <button className={`wp-switch ${harmonic ? "wp-switch-on" : ""}`} onClick={() => setHarmonic(!harmonic)} aria-pressed={harmonic}><span className="wp-switch-knob" /></button>
        </div>
        <div className="wp-djset-row">
          <span className="md-body-l">Length</span>
          <div className="wp-seg wp-seg-sm">
            {[10, 20, 30, 50].map((n) => (
              <button key={n} className={`wp-seg-item ${len === n ? "wp-seg-on" : ""}`} onClick={() => setLen(n)}>{n}</button>
            ))}
          </div>
        </div>
        <button className="wp-filled-btn wp-djset-go" onClick={go} disabled={busy}>
          <Icon name="allInclusive" size={18} /> {busy ? "Building…" : "Generate set"}
        </button>
      </div>
    </Sheet>
  );
}
