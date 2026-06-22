import { useState } from "react";
import { createPortal } from "react-dom";
import { useSettings } from "@/store/settings";
import { buzz } from "@/lib/touch";
import { Icon } from "./Icons";
import { Sheet } from "./Sheet";

/** Reference tempo used to translate bars ↔ seconds in the custom editor. */
const REF_BPM = 120;
const BEATS_PER_BAR = 4;

type Unit = "sec" | "ms" | "bars" | "hz";
type Curve = "linear" | "equal" | "smooth";

/** Convert a value expressed in `unit` to canonical seconds. */
function toSeconds(unit: Unit, v: number): number {
  switch (unit) {
    case "sec": return v;
    case "ms": return v / 1000;
    case "bars": return (v * BEATS_PER_BAR * 60) / REF_BPM;
    case "hz": return v > 0 ? 1 / v : 0;
  }
}
/** Convert canonical seconds back into `unit`. */
function fromSeconds(unit: Unit, s: number): number {
  switch (unit) {
    case "sec": return s;
    case "ms": return s * 1000;
    case "bars": return (s * REF_BPM) / (BEATS_PER_BAR * 60);
    case "hz": return s > 0 ? 1 / s : 0;
  }
}

const UNITS: { id: Unit; label: string; max: number; step: number; fmt: (v: number) => string }[] = [
  { id: "sec", label: "Seconds", max: 20, step: 0.5, fmt: (v) => `${v.toFixed(1)} s` },
  { id: "ms", label: "Millisec", max: 20000, step: 100, fmt: (v) => `${Math.round(v)} ms` },
  { id: "bars", label: "Bars", max: 8, step: 0.25, fmt: (v) => `${v.toFixed(2)} bars` },
  { id: "hz", label: "Hertz", max: 5, step: 0.05, fmt: (v) => `${v.toFixed(2)} Hz` },
];

const CURVES: { id: Curve; label: string }[] = [
  { id: "linear", label: "Linear" },
  { id: "equal", label: "Equal power" },
  { id: "smooth", label: "Smooth" },
];

/** Two stacked crossfade gain curves (outgoing falls, incoming rises) for the given shape. */
function curvePath(curve: Curve, rising: boolean): string {
  const pts: string[] = [];
  for (let i = 0; i <= 24; i++) {
    const x = i / 24;
    const t = rising ? x : 1 - x;
    let g: number;
    if (curve === "linear") g = t;
    else if (curve === "equal") g = Math.sin((t * Math.PI) / 2); // equal-power
    else g = t * t * (3 - 2 * t); // smoothstep
    pts.push(`${(x * 100).toFixed(1)},${(34 - g * 30).toFixed(1)}`);
  }
  return "M" + pts.join(" L");
}

interface Preset { name: string; sub: string; secs: number; curve: Curve; gapless: boolean; icon: string }
const PRESETS: Preset[] = [
  { name: "Off", sub: "Hard cut", secs: 0, curve: "linear", gapless: false, icon: "close" },
  { name: "Gapless", sub: "Butt-joined, no fade", secs: 0, curve: "linear", gapless: true, icon: "bolt" },
  { name: "Quick", sub: "0.5s equal-power", secs: 0.5, curve: "equal", gapless: true, icon: "next" },
  { name: "Smooth", sub: "2s equal-power", secs: 2, curve: "equal", gapless: true, icon: "graphicEq" },
  { name: "Long blend", sub: "6s smooth", secs: 6, curve: "smooth", gapless: true, icon: "shape" },
  { name: "DJ mix", sub: "12s smooth blend", secs: 12, curve: "smooth", gapless: true, icon: "allInclusive" },
];

/** Full-screen transition studio: presets + a unit-flexible custom crossfade editor. */
export function TransitionStudio({ onClose }: { onClose: () => void }) {
  const s = useSettings();
  const [tab, setTab] = useState<"presets" | "custom">("presets");

  const unit = (UNITS.find((u) => u.id === s.crossfadeUnit) ?? UNITS[0]);
  const value = fromSeconds(unit.id, s.crossfade);

  const setValue = (v: number) => {
    const clamped = Math.max(0, Math.min(unit.max, v));
    useSettings.getState().setCrossfade(toSeconds(unit.id, clamped));
  };
  const applyPreset = (p: Preset) => {
    const st = useSettings.getState();
    st.setCrossfade(p.secs); st.setCrossfadeCurve(p.curve); st.setGapless(p.gapless);
    buzz(8);
  };
  const presetActive = (p: Preset) =>
    Math.abs(p.secs - s.crossfade) < 0.01 && p.curve === s.crossfadeCurve && p.gapless === s.gapless;

  return createPortal(
    <Sheet onClose={onClose} className="wp-trans" tall>
      <header className="wp-trans-head">
        <div className="md-title-m">Transitions</div>
        <div className="md-body-s wp-muted">How one track flows into the next</div>
      </header>

      <div className="wp-trans-tabs" onClick={(e) => e.stopPropagation()}>
        <button className={`wp-trans-tab ${tab === "presets" ? "on" : ""}`} onClick={() => setTab("presets")}>Presets</button>
        <button className={`wp-trans-tab ${tab === "custom" ? "on" : ""}`} onClick={() => setTab("custom")}>Custom</button>
        <div className="wp-trans-tab-ink" style={{ transform: `translateX(${tab === "custom" ? 100 : 0}%)` }} />
      </div>

      {tab === "presets" ? (
        <div className="wp-trans-presets">
          {PRESETS.map((p) => (
            <button key={p.name} className={`wp-trans-card ${presetActive(p) ? "on" : ""}`} onClick={() => applyPreset(p)}>
              <span className="wp-trans-card-ico"><Icon name={p.icon} size={20} /></span>
              <span className="wp-trans-card-name md-title-s">{p.name}</span>
              <span className="wp-trans-card-sub md-body-s">{p.sub}</span>
              {presetActive(p) && <span className="wp-trans-card-check"><Icon name="check" size={16} /></span>}
            </button>
          ))}
        </div>
      ) : (
        <div className="wp-trans-custom" onClick={(e) => e.stopPropagation()}>
          {/* live crossfade-curve preview */}
          <div className="wp-trans-preview">
            <svg viewBox="0 0 100 36" preserveAspectRatio="none" className="wp-trans-svg">
              <path d={curvePath(s.crossfadeCurve, false)} className="wp-trans-curve out" />
              <path d={curvePath(s.crossfadeCurve, true)} className="wp-trans-curve in" />
            </svg>
            <div className="wp-trans-readout">
              <span className="wp-trans-big">{s.crossfade <= 0 ? (s.gapless ? "Gapless" : "Off") : unit.fmt(value)}</span>
              <span className="md-body-s wp-muted">
                {s.crossfade > 0 ? `${s.crossfade.toFixed(2)}s · ${CURVES.find((c) => c.id === s.crossfadeCurve)?.label}` : "no overlap"}
              </span>
            </div>
          </div>

          {/* unit picker */}
          <div className="wp-trans-units">
            {UNITS.map((u) => (
              <button key={u.id} className={`wp-trans-unit ${u.id === unit.id ? "on" : ""}`}
                onClick={() => useSettings.getState().setCrossfadeUnit(u.id)}>{u.label}</button>
            ))}
            {unit.id === "bars" && <span className="wp-trans-bpmhint md-body-s">@ {REF_BPM} BPM</span>}
          </div>

          {/* stepper + slider in the chosen unit */}
          <div className="wp-trans-setrow">
            <button className="wp-trans-step" onClick={() => setValue(value - unit.step)}><Icon name="remove" size={20} /></button>
            <input className="wp-trans-slider" type="range" min={0} max={unit.max} step={unit.step}
              value={value} onChange={(e) => setValue(parseFloat(e.target.value))} />
            <button className="wp-trans-step" onClick={() => setValue(value + unit.step)}><Icon name="add" size={20} /></button>
          </div>

          {/* curve shape */}
          <div className="wp-trans-field">
            <span className="md-label-l wp-muted">Fade shape</span>
            <div className="wp-trans-curves">
              {CURVES.map((c) => (
                <button key={c.id} className={`wp-trans-curvebtn ${c.id === s.crossfadeCurve ? "on" : ""}`}
                  onClick={() => useSettings.getState().setCrossfadeCurve(c.id)}>
                  <svg viewBox="0 0 100 36" preserveAspectRatio="none"><path d={curvePath(c.id, true)} /></svg>
                  <span className="md-body-s">{c.label}</span>
                </button>
              ))}
            </div>
          </div>

          {/* gapless */}
          <button className="wp-trans-gapless" onClick={() => useSettings.getState().setGapless(!s.gapless)}>
            <div className="wp-row-text">
              <div className="md-body-l">Gapless</div>
              <div className="md-body-s wp-muted">Butt-join tracks with no silence when there's no fade</div>
            </div>
            <span className={`wp-switch ${s.gapless ? "wp-switch-on" : ""}`}><span className="wp-switch-knob" /></span>
          </button>
        </div>
      )}
    </Sheet>,
    document.body,
  );
}
