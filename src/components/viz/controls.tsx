/** Reusable Material-3 controls for the visualizer editor. */
import { useState, type ReactNode } from "react";
import { useViz, type BandSource } from "@/store/viz";
import { Icon } from "../Icons";

export function Slider({ label, value, min, max, step, fmt, onChange }: {
  label: string; value: number; min: number; max: number; step: number;
  fmt?: (v: number) => string; onChange: (v: number) => void;
}) {
  return (
    <label className="wp-ctl">
      <span className="wp-ctl-label md-body-m">{label}</span>
      <input className="wp-range" type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))} />
      <span className="wp-ctl-val md-body-s wp-muted">{fmt ? fmt(value) : value}</span>
    </label>
  );
}

export function Toggle({ label, on, onClick }: { label: string; on: boolean; onClick: () => void }) {
  return (
    <button className={`wp-toggle ${on ? "wp-toggle-on" : ""}`} onClick={onClick}>
      <span className="wp-toggle-dot" /> <span className="md-body-m">{label}</span>
    </button>
  );
}

export function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="wp-color">
      <input type="color" value={value} onChange={(e) => onChange(e.target.value)} />
      <span className="md-body-s wp-muted">{label}</span>
    </label>
  );
}

export function Segmented<T extends string | number>({ options, value, onChange }: {
  options: { id: T; label: string }[]; value: T; onChange: (v: T) => void;
}) {
  return (
    <div className="wp-seg">
      {options.map((o) => (
        <button key={String(o.id)} className={`wp-seg-item ${value === o.id ? "wp-seg-on" : ""}`}
          onClick={() => onChange(o.id)}>{o.label}</button>
      ))}
    </div>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="wp-field">
      <span className="wp-field-label md-label-m wp-muted">{label}</span>
      {children}
    </div>
  );
}

/** A collapsible, icon-labelled property group (Avee-style). */
export function Section({ title, icon, defaultOpen = true, children }: {
  title: string; icon?: string; defaultOpen?: boolean; children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="wp-section">
      <button className="wp-section-head" onClick={() => setOpen((o) => !o)}>
        {icon && <Icon name={icon} size={16} color="var(--md-primary)" />}
        <span className="md-title-s wp-section-title">{title}</span>
        <Icon name={open ? "down" : "up"} size={18} color="var(--md-on-surface-variant)" />
      </button>
      {open && <div className="wp-section-body">{children}</div>}
    </div>
  );
}

const SOURCES: { id: BandSource | "off"; label: string }[] = [
  { id: "off", label: "Off" }, { id: "bass", label: "Bass" }, { id: "mid", label: "Mid" }, { id: "treble", label: "Treble" }, { id: "level", label: "Level" },
];

/** Quick Hz windows for the per-binding custom range (P1). */
const FREQ_PRESETS = [
  { lo: 20, hi: 150, label: "Sub" }, { lo: 60, hi: 250, label: "Bass" }, { lo: 250, hi: 800, label: "Low-mid" },
  { lo: 400, hi: 2000, label: "Mid" }, { lo: 2000, hi: 6000, label: "Presence" }, { lo: 4000, hi: 12000, label: "Air" },
];

/** A slider with an inline "react to audio" (⚡) link — any property can be bound to a band,
 *  exactly like Avee. amount range is derived from the slider's own span. */
export function BindableSlider({ layerId, prop, label, value, min, max, step, fmt, onChange }: {
  layerId: string; prop: string; label: string; value: number; min: number; max: number; step: number;
  fmt?: (v: number) => string; onChange: (v: number) => void;
}) {
  const bind = useViz((s) => { const l = s.scene.layers.find((x) => x.id === layerId); return l?.bind[prop]; });
  const setBind = useViz((s) => s.setBind);
  const [open, setOpen] = useState(false);
  const span = max - min || 1;
  return (
    <div className="wp-bslider">
      <div className="wp-bslider-row">
        <div className="wp-bslider-main"><Slider label={label} value={value} min={min} max={max} step={step} fmt={fmt} onChange={onChange} /></div>
        <button className={`wp-bindbtn ${bind ? "on" : ""}`} title="React to audio" onClick={() => setOpen((o) => !o)}>
          <Icon name="bolt" size={16} />
        </button>
      </div>
      {(open || bind) && (
        <div className="wp-bind-pop">
          <div className="wp-bind-label md-label-m wp-muted">Source</div>
          <Segmented options={SOURCES} value={bind ? bind.source : "off"}
            onChange={(v) => setBind(layerId, prop, v === "off" ? null : { ...(bind ?? {}), source: v as BandSource, amount: bind?.amount ?? span * 0.4 })} />
          {bind && <>
            <div className="wp-bind-label md-label-m wp-muted">Frequency</div>
            <Segmented options={[{ id: "band", label: "Named band" }, { id: "hz", label: "Custom Hz" }]}
              value={bind.freqLo !== undefined && bind.freqHi !== undefined ? "hz" : "band"}
              onChange={(v) => setBind(layerId, prop, v === "hz"
                ? { ...bind, freqLo: bind.freqLo ?? 20, freqHi: bind.freqHi ?? 200 }
                : { ...bind, freqLo: undefined, freqHi: undefined })} />
            {bind.freqLo !== undefined && bind.freqHi !== undefined && <>
              <div className="wp-bind-freq">
                <input className="wp-num" type="number" min={20} max={20000} value={bind.freqLo}
                  onChange={(e) => setBind(layerId, prop, { ...bind, freqLo: Math.max(20, Math.min(parseInt(e.target.value) || 20, (bind.freqHi ?? 20000) - 1)) })} />
                <span className="md-body-s wp-muted">to</span>
                <input className="wp-num" type="number" min={21} max={22000} value={bind.freqHi}
                  onChange={(e) => setBind(layerId, prop, { ...bind, freqHi: Math.max((bind.freqLo ?? 20) + 1, Math.min(parseInt(e.target.value) || 200, 22000)) })} />
                <span className="md-body-s wp-muted">Hz</span>
              </div>
              <div className="wp-bind-presets">
                {FREQ_PRESETS.map((p) => (
                  <button key={p.label} className="wp-chip-sm" onClick={() => setBind(layerId, prop, { ...bind, freqLo: p.lo, freqHi: p.hi })}>{p.label}</button>
                ))}
              </div>
            </>}
            <div className="wp-bind-label md-label-m wp-muted">Response</div>
            <Segmented options={[{ id: "continuous", label: "Continuous" }, { id: "beat", label: "Beat" }]}
              value={bind.mode ?? "continuous"} onChange={(m) => setBind(layerId, prop, { ...bind, mode: m as "continuous" | "beat" })} />
            <Slider label="Amount" value={bind.amount} min={-span} max={span} step={step} fmt={(n) => n.toFixed(2)}
              onChange={(a) => setBind(layerId, prop, { ...bind, amount: a })} />
            <Slider label="Attack" value={bind.attack ?? 0} min={0} max={0.95} step={0.01} fmt={(n) => n.toFixed(2)}
              onChange={(v) => setBind(layerId, prop, { ...bind, attack: v })} />
            <Slider label="Release" value={bind.release ?? bind.smoothing ?? 0} min={0} max={0.97} step={0.01} fmt={(n) => n.toFixed(2)}
              onChange={(v) => setBind(layerId, prop, { ...bind, release: v, smoothing: undefined })} />
            {bind.mode !== "beat" && <Slider label="Curve" value={bind.curve ?? 1} min={0.3} max={4} step={0.1} fmt={(n) => n.toFixed(1)}
              onChange={(c) => setBind(layerId, prop, { ...bind, curve: c })} />}
            <div className="wp-bind-clamp">
              <Slider label="Min out" value={bind.min ?? -span} min={-span} max={span} step={step} fmt={(n) => n.toFixed(2)}
                onChange={(v) => setBind(layerId, prop, { ...bind, min: v })} />
              <Slider label="Max out" value={bind.max ?? span} min={-span} max={span} step={step} fmt={(n) => n.toFixed(2)}
                onChange={(v) => setBind(layerId, prop, { ...bind, max: v })} />
            </div>
          </>}
        </div>
      )}
    </div>
  );
}
