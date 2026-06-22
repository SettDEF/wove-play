import { useState } from "react";
import { useSettings } from "@/store/settings";
import { Icon } from "./Icons";
import { Slider } from "./Slider";
import { useBackGuard } from "@/lib/backStack";
import {
  PLUGINS, DEVICES, BUFFERS, DEFAULT_OUTPUT, pluginName,
  type OutputPlugin, type OutputDeviceId, type DeviceCfg,
} from "@/lib/outputConfig";

function Switch({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return <button className={`wp-switch ${on ? "wp-switch-on" : ""}`} onClick={onToggle} aria-pressed={on}><span className="wp-switch-knob" /></button>;
}
function Seg<T extends string | number>({ value, options, onChange }: { value: T; options: { id: T; label: string }[]; onChange: (v: T) => void }) {
  return <div className="wp-seg wp-seg-sm">{options.map((o) => <button key={String(o.id)} className={`wp-seg-item ${value === o.id ? "wp-seg-on" : ""}`} onClick={() => onChange(o.id)}>{o.label}</button>)}</div>;
}
function Row({ title, sub, children }: { title: string; sub?: string; children?: React.ReactNode }) {
  return (
    <div className="wp-set-row">
      <div className="wp-row-text"><span className="md-body-l">{title}</span>{sub && <div className="md-body-s wp-muted">{sub}</div>}</div>
      <div className="wp-set-control">{children}</div>
    </div>
  );
}

/** Poweramp-style Output settings, three levels: plugin list → the devices THAT PLUGIN drives (toggle
 *  per device) → that device's options. Each device is handled by exactly one plugin; toggling a
 *  device on under a plugin assigns it there. The native output plugins aren't built yet, so this is
 *  the (persisted) config surface — a banner is honest about what's live today. */
export function OutputSettings({ onClose }: { onClose: () => void }) {
  const output = useSettings((s) => s.output);
  const setOutput = useSettings((s) => s.setOutput);
  const [plugin, setPlugin] = useState<OutputPlugin | null>(null);
  const [device, setDevice] = useState<OutputDeviceId | null>(null);
  // ONE guard per nav level → the back button steps device → plugin → close. (A single multi-level
  // guard registered only ONE history entry, so after the first back the rest fell through to the
  // parent guards and the app jumped out of Settings while still 2 levels deep in here.) [back-nav]
  useBackGuard(true, onClose);
  useBackGuard(plugin != null, () => setPlugin(null));
  useBackGuard(device != null, () => setDevice(null));

  const patch = (id: OutputDeviceId, p: Partial<DeviceCfg>) =>
    setOutput({ ...output, devices: { ...output.devices, [id]: { ...output.devices[id], ...p } } });
  const back = () => (device ? setDevice(null) : plugin ? setPlugin(null) : onClose());
  const title = device ? DEVICES.find((d) => d.id === device)?.name : plugin ? pluginName(plugin) : "Output";

  return (
    <div className="wp-screen wp-settings">
      <div className="wp-set-back">
        <button className="md-icon-btn" onClick={back} title="Back"><Icon name="prev" size={22} /></button>
        <span className="md-title-m">{title}</span>
      </div>

      <div className="wp-foryou-banner" style={{ cursor: "default" }}>
        <Icon name="bolt" size={20} color="var(--md-primary)" />
        <span className="wp-row-text">
          <span className="md-body-l">Output engine</span>
          <span className="md-body-s wp-muted">Hi-Res / OpenSL / AAudio / DVC are native paths — saved here and applied once the native output engine ships. Visualization delay &amp; ducking apply now.</span>
        </span>
      </div>

      {/* ── Level 0: plugin list ───────────────────────────────────────────── */}
      {plugin === null && device === null && (
        <section className="wp-set-sec">
          <h3 className="md-title-s wp-set-head">Output plugins</h3>
          {PLUGINS.map((p) => {
            const used = DEVICES.filter((d) => output.devices[d.id].plugin === p.id && output.devices[d.id].enabled);
            return (
              <button key={p.id} className="wp-set-menu-row" onClick={() => setPlugin(p.id)}>
                <div className="wp-row-text">
                  <div className="md-body-l">{p.name}</div>
                  <div className="md-body-s wp-muted ellipsis">{used.length ? used.map((d) => d.name).join(" · ") : p.desc}</div>
                </div>
                {used.length > 0 && <span className="md-label-m" style={{ color: "var(--md-primary)" }}>Active</span>}
                <Icon name="next" size={18} color="var(--md-on-surface-variant)" />
              </button>
            );
          })}
          <h3 className="md-title-s wp-set-head" style={{ marginTop: 8 }}>Default plugin</h3>
          <Row title="Unassigned devices" sub="Plugin used for any other output">
            <Seg value={output.defaultPlugin} options={PLUGINS.map((p) => ({ id: p.id, label: p.name.replace(" Output", "") }))} onChange={(defaultPlugin: OutputPlugin) => setOutput({ ...output, defaultPlugin })} />
          </Row>
          <button className="wp-text-btn md-label-l" style={{ margin: "8px 6px" }} onClick={() => setOutput(DEFAULT_OUTPUT)}>Restore defaults</button>
        </section>
      )}

      {/* ── Level 1: the devices THIS plugin drives ────────────────────────── */}
      {plugin !== null && device === null && (
        <section className="wp-set-sec">
          <div className="md-body-s wp-muted" style={{ padding: "2px 6px 8px" }}>{PLUGINS.find((p) => p.id === plugin)?.desc}</div>
          <h3 className="md-title-s wp-set-head">Use for output devices</h3>
          {DEVICES.map((d) => {
            const c = output.devices[d.id];
            const on = c.plugin === plugin && c.enabled;
            return (
              <div key={d.id} className="wp-set-row">
                <div className="wp-row-text">
                  <span className="md-body-l">{d.name}</span>
                  {on && d.id === "speaker" && <div className="md-body-s wp-muted">Active · 16 bit 48 kHz</div>}
                </div>
                <div className="wp-set-control" style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  {/* toggling on assigns this device to THIS plugin */}
                  <Switch on={on} onToggle={() => patch(d.id, on ? { enabled: false } : { plugin, enabled: true })} />
                  <button className="md-icon-btn" title="Configure" onClick={() => setDevice(d.id)}><Icon name="tune" size={20} /></button>
                </div>
              </div>
            );
          })}
        </section>
      )}

      {/* ── Level 2: per-device options ────────────────────────────────────── */}
      {device !== null && (() => {
        const cfg = output.devices[device];
        return (
          <section className="wp-set-sec">
            <Row title={`${pluginName(cfg.plugin)} for this device`}>
              <Switch on={cfg.enabled} onToggle={() => patch(device, { enabled: !cfg.enabled })} />
            </Row>
            <Row title="Sample rate" sub={cfg.sampleRate === 0 ? "Defined by the device" : `${cfg.sampleRate / 1000} kHz`}>
              <Seg value={cfg.sampleRate} options={[{ id: 0, label: "Device" }, { id: 44100, label: "44.1" }, { id: 48000, label: "48" }, { id: 96000, label: "96" }, { id: 192000, label: "192" }]} onChange={(sampleRate: number) => patch(device, { sampleRate })} />
            </Row>
            <Row title="Float32 sample format" sub="Hi-Res float; disables dithering, usually 24-bit out">
              <Switch on={cfg.float32} onToggle={() => patch(device, { float32: !cfg.float32 })} />
            </Row>
            <Row title="No DVC" sub="Disable Direct Volume Control for this device">
              <Switch on={cfg.noDvc} onToggle={() => patch(device, { noDvc: !cfg.noDvc })} />
            </Row>
            <Row title="No headroom gain" sub="Don't reduce gain when DVC is off (may distort on high EQ)">
              <Switch on={cfg.noHeadroom} onToggle={() => patch(device, { noHeadroom: !cfg.noHeadroom })} />
            </Row>
            <Row title="Buffer size" sub={BUFFERS.find((b) => b.id === cfg.buffer)?.detail}>
              <Seg value={cfg.buffer} options={BUFFERS.map((b) => ({ id: b.id, label: b.label }))} onChange={(buffer) => patch(device, { buffer })} />
            </Row>
            <Row title="Visualization / lyrics delay" sub={`Sync offset: ${cfg.vizDelayMs} ms`}>
              <div className="wp-set-slider"><Slider value={cfg.vizDelayMs} min={0} max={500} step={10} onChange={(vizDelayMs) => patch(device, { vizDelayMs })} /></div>
            </Row>
            <Row title="No Equ/Tone" sub="Bypass the equalizer / tone DSP for this device">
              <Switch on={cfg.noEqTone} onToggle={() => patch(device, { noEqTone: !cfg.noEqTone })} />
            </Row>
            <Row title="No Duck" sub="Don't lower volume on notifications — pause instead">
              <Switch on={cfg.noDuck} onToggle={() => patch(device, { noDuck: !cfg.noDuck })} />
            </Row>
          </section>
        );
      })()}
    </div>
  );
}
