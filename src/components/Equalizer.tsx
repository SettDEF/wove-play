import { useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { usePlayer, EQ_PRESETS, EQ_FREQS } from "@/store/player";
import { useDsp } from "@/store/dsp";
import { useSettings } from "@/store/settings";
import { useEqAssign } from "@/store/eqAssign";
import { useEqPresets } from "@/store/eqPresets";
import { toast } from "@/store/toasts";
import { parseAutoEq, headphoneName } from "@/lib/autoeq";
import { Icon } from "./Icons";
import { Knob } from "./Knob";
import { Spectrum } from "./Spectrum";
import { EqCurve } from "./EqCurve";
import { AudioInfo } from "./AudioInfo";
import { PresetBrowser } from "./PresetBrowser";
import { SavePresetDialog } from "./SavePresetDialog";

const GMIN = -12, GMAX = 12;
const BOOST = "#ff5a52", CUT = "#37d67a"; // Poweramp-style: red boost, green cut
const freqLabel = (f: number) => (f >= 1000 ? `${(f / 1000).toFixed(f % 1000 ? 1 : 0)}k` : `${Math.round(f)}`);
/** Poweramp-style gain label: a dB value, a percentage of full scale, or hidden. */
const fmtGain = (g: number, mode: "hidden" | "db" | "pct") =>
  mode === "hidden" ? "" : mode === "pct" ? `${Math.round((g / GMAX) * 100)}%` : `${g > 0 ? "+" : ""}${g}`;
const sliderToFreq = (v: number) => Math.round(20 * Math.pow(1000, v));
const freqToSlider = (f: number) => Math.log(Math.max(20, f) / 20) / Math.log(1000);

type Mode = "equ" | "tone";

/** Vertical gain fader for one band (drag, double-tap to zero). */
function Fader({ value, accent, onChange }: { value: number; accent: string; onChange: (v: number) => void }) {
  const pct = (value - GMIN) / (GMAX - GMIN);
  const onDown = (e: React.PointerEvent) => {
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const apply = (clientY: number) => {
      const r = el.getBoundingClientRect();
      const f = 1 - Math.max(0, Math.min(1, (clientY - r.top) / r.height));
      onChange(Math.round((GMIN + f * (GMAX - GMIN)) * 2) / 2);
    };
    apply(e.clientY);
    const move = (ev: PointerEvent) => apply(ev.clientY);
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  return (
    <div className="wp-eqf-track" onPointerDown={onDown} onDoubleClick={() => onChange(0)}>
      <div className="wp-eqf-fill" style={{ height: `${pct * 100}%`, background: accent }} />
      <div className="wp-eqf-thumb" style={{ bottom: `calc(${pct * 100}% - 8px)` }} />
    </div>
  );
}

export function Equalizer() {
  // Selector + shallow-compare so the EQ screen only re-renders when an EQ value changes — NOT on every
  // 10Hz position tick (a no-selector `usePlayer()` subscribed to the whole store, re-rendering all 10
  // faders + the live spectrum several times a second during playback). [perf]
  const { bands, bandFreqs, bandQs, preamp, eqEnabled, presetName } = usePlayer(
    useShallow((s) => ({ bands: s.bands, bandFreqs: s.bandFreqs, bandQs: s.bandQs, preamp: s.preamp, eqEnabled: s.eqEnabled, presetName: s.presetName })),
  );
  const { setBand, setEqFreq, setEqQ, resetEqBand, setPreamp, setEqEnabled, applyPreset } = usePlayer.getState();
  const dsp = useDsp();
  const eqValues = useSettings((s) => s.eqValues);
  const toneValues = useSettings((s) => s.toneValues);
  const cur = usePlayer((s) => s.current());
  const pinned = useEqAssign((s) => (cur ? !!s.songs[cur.id] : false));
  // count of custom curves (user presets + per-song pins) → badge on the Presets chip
  const customCount = useEqPresets((s) => s.presets.length) + useEqAssign((s) => Object.keys(s.songs).length);
  const [mode, setMode] = useState<Mode>("equ");
  const [sel, setSel] = useState(2);
  const [info, setInfo] = useState(false);
  const [autoing, setAutoing] = useState(false);
  const [browse, setBrowse] = useState(false);  // preset browser sheet
  const [saving, setSaving] = useState(false);   // save-preset naming dialog
  const [morphing, setMorphing] = useState(false); // brief CSS-eased fader morph after a preset/AutoEq jump
  const aeqRef = useRef<HTMLInputElement>(null);
  const morphTimer = useRef<number | null>(null);
  /** Ease the faders to their new values (call after any change that JUMPS the curve, not on drag). */
  const morph = () => { setMorphing(true); if (morphTimer.current) clearTimeout(morphTimer.current); morphTimer.current = window.setTimeout(() => setMorphing(false), 320); };
  // A/B compare: hold to hear the track WITHOUT the EQ (momentary bypass), release to restore.
  const cmpPrev = useRef<boolean | null>(null);
  const cmpDown = () => { cmpPrev.current = eqEnabled; if (eqEnabled) setEqEnabled(false); };
  const cmpUp = () => { if (cmpPrev.current != null) { if (cmpPrev.current) setEqEnabled(true); cmpPrev.current = null; } };

  // Per-track AutoEq: analyse the current song's spectral balance → corrective curve.
  const autoEq = async () => {
    if (!cur) { toast.info("Play a track first to AutoEq it."); return; }
    setAutoing(true);
    const ok = await usePlayer.getState().autoEqCurrent();
    setAutoing(false);
    if (ok) { morph(); toast.success(`AutoEq tuned for “${cur.title}”.`); }
    else toast.error("Couldn't analyse this track.");
  };
  // Pin the current EQ to this song (Poweramp "Apply to songs"); auto-applies whenever it plays.
  const togglePin = () => {
    if (!cur) { toast.info("Play a track first."); return; }
    if (pinned) { usePlayer.getState().unpinEqFromSong(cur.id); toast.info(`EQ unpinned from “${cur.title}”.`); }
    else { usePlayer.getState().pinEqToSong(cur.id); toast.success(`EQ pinned to “${cur.title}”.`); }
  };

  // AutoEq: import a headphone's "ParametricEQ.txt" correction curve straight into the 10 bands.
  const importAutoEq = async (file?: File) => {
    if (!file) return;
    try {
      const { preamp, filters, hasShelf } = parseAutoEq(await file.text());
      const name = headphoneName(file.name);
      usePlayer.getState().applyParametric(name, filters, preamp);
      morph();
      const extra = [filters.length > 10 ? `first 10 of ${filters.length} bands` : "", hasShelf ? "shelves approximated" : ""].filter(Boolean).join(" · ");
      toast.success(`Applied ${name}${extra ? ` (${extra})` : ""}`);
    } catch (e) { toast.error(e instanceof Error ? e.message : "Couldn't read that AutoEq file."); }
  };

  const applyPresetMorph = (p: typeof EQ_PRESETS[number]) => { applyPreset(p); morph(); }; // chip tap → eased
  // Save the current curve as a named user preset (shows up in the browser). Optionally pin to song.
  const doSave = (name: string, pinSong: boolean) => {
    useEqPresets.getState().save({ name, gains: [...bands], freqs: [...bandFreqs], qs: [...bandQs], preamp, enabled: eqEnabled });
    usePlayer.setState({ presetName: name });
    if (pinSong && cur) usePlayer.getState().pinEqToSong(cur.id);
    toast.success(`Saved “${name}”${pinSong && cur ? " · pinned to song" : ""}.`);
    setSaving(false);
  };
  const accentOf = (g: number) => (g > 0.05 ? BOOST : g < -0.05 ? CUT : "var(--md-primary)");
  const MODES: [Mode, string, string][] = [["equ", "Bands", "graphicEq"], ["tone", "Tone", "tune"]];

  return (
    <div className="wp-screen wp-eqp">
      {/* ── top bar: mode switch · audio info · power ───────────── */}
      <div className="wp-eq-top">
        <div className="wp-seg wp-eq-modes">
          {MODES.map(([id, label, icon]) => (
            <button key={id} className={`wp-seg-item ${mode === id ? "wp-seg-on" : ""}`} onClick={() => setMode(id)}>
              <Icon name={icon} size={15} /> {label}
            </button>
          ))}
        </div>
        <button className="wp-eq-iconbtn" onClick={() => setInfo(true)} title="Audio Info"><Icon name="hub" size={18} /></button>
        <button className="wp-eq-iconbtn wp-eq-ab" title="Hold to hear without EQ (A/B)"
          onPointerDown={cmpDown} onPointerUp={cmpUp} onPointerLeave={cmpUp} onPointerCancel={cmpUp}>A/B</button>
        <button className={`wp-eq-power ${eqEnabled ? "wp-eq-power-on" : ""}`} onClick={() => setEqEnabled(!eqEnabled)} title={eqEnabled ? "EQ on" : "EQ off"}>
          <Icon name="power" size={16} /> {eqEnabled ? "On" : "Off"}
        </button>
      </div>

      {/* ── live spectrum + EQ curve ───────────────────────────── */}
      <div className="wp-eq-scope">
        <Spectrum color="var(--md-primary)" height={84} />
        <div className="wp-eq-curve-over">
          <EqCurve bands={bands} freqs={bandFreqs} qs={bandQs} preamp={preamp} enabled={eqEnabled}
            color="var(--md-primary)" selected={sel} gMin={GMIN} gMax={GMAX}
            onPick={(i) => { setSel(i); setMode("equ"); }}
            onDrag={(i, gain, freq) => { setSel(i); setBand(i, gain); setEqFreq(i, freq); }} />
        </div>
        {mode === "equ" && (
          <div className="wp-eq-legend md-label-m">
            <span><i style={{ background: BOOST }} /> Boost</span>
            <span><i style={{ background: CUT }} /> Cut</span>
          </div>
        )}
      </div>

      {/* ── mode stage ─────────────────────────────────────────── */}
      <div className={`wp-eq-stage ${eqEnabled ? "" : "wp-dim"}`}>
        {mode === "equ" && (() => {
          // Defensive: older saved EQs can have bandFreqs/bandQs shorter than bands → fall back.
          const fr = bandFreqs[sel] ?? EQ_FREQS[sel] ?? 1000;
          const q = bandQs[sel] ?? 1.1;
          const sg = bands[sel] ?? 0;
          return (
          <div className="wp-eq-equ">
            {/* selected-band editor — Freq/Q for the picked band only (tap a fader or curve node) */}
            <div className="wp-eq-selbar">
              <div className="wp-eq-selinfo">
                <span className="md-title-s" style={{ color: accentOf(sg) }}>{freqLabel(fr)} Hz</span>
                <span className="md-body-s wp-muted">{sg > 0 ? "+" : ""}{sg} dB · Q {q.toFixed(2)}</span>
              </div>
              <Knob value={freqToSlider(fr)} min={0} max={1} label="Freq" sub={freqLabel(fr)} color={accentOf(sg)} size={46}
                onChange={(v) => setEqFreq(sel, sliderToFreq(v))} onReset={() => setEqFreq(sel, EQ_FREQS[sel])} />
              <Knob value={q} min={0.3} max={6} label="Q" sub={q.toFixed(2)} color={accentOf(sg)} size={46}
                onChange={(v) => setEqQ(sel, v)} onReset={() => setEqQ(sel, 1.1)} />
              <button className="wp-eq-iconbtn" title="Reset this band" onClick={() => { resetEqBand(sel); setEqFreq(sel, EQ_FREQS[sel]); setEqQ(sel, 1.1); }}><Icon name="refresh" size={16} /></button>
            </div>
            {/* all faders fitted to width (no scroll) + a dB scale */}
            <div className={`wp-eq-bands ${morphing ? "wp-eq-morph" : ""}`}>
              <div className="wp-eq-scale md-label-m"><span>+12</span><span>0</span><span>−12</span></div>
              <div className="wp-eq-band wp-eq-pre">
                <Fader value={preamp} accent="var(--md-primary)" onChange={setPreamp} />
                {eqValues !== "hidden" && <div className="wp-eq-bval md-body-s">{fmtGain(preamp, eqValues)}</div>}
                <div className="wp-eq-bname md-label-m">Pre</div>
              </div>
              {bands.map((g, i) => (
                <div key={i} className={`wp-eq-band ${sel === i ? "wp-eq-sel" : ""}`} onPointerDown={() => setSel(i)}>
                  <Fader value={g} accent={accentOf(g)} onChange={(v) => setBand(i, v)} />
                  {eqValues !== "hidden" && <div className="wp-eq-bval md-body-s" style={{ color: g !== 0 ? accentOf(g) : undefined }}>{fmtGain(g, eqValues)}</div>}
                  <div className="wp-eq-bname md-label-m">{freqLabel(bandFreqs[i] ?? EQ_FREQS[i])}</div>
                </div>
              ))}
            </div>
          </div>
          );
        })()}

        {mode === "tone" && (
          <div className="wp-eq-tone">
            <Knob value={dsp.bass} min={-12} max={12} label="Bass" sub={toneValues === "hidden" ? "" : `${fmtGain(dsp.bass, toneValues)}${toneValues === "db" ? " dB" : ""}`} color={BOOST} size={84} onChange={(v) => dsp.set("bass", Math.round(v))} onReset={() => dsp.set("bass", 0)} />
            <Knob value={dsp.treble} min={-12} max={12} label="Treble" sub={toneValues === "hidden" ? "" : `${fmtGain(dsp.treble, toneValues)}${toneValues === "db" ? " dB" : ""}`} color={CUT} size={84} onChange={(v) => dsp.set("treble", Math.round(v))} onReset={() => dsp.set("treble", 0)} />
            <Knob value={dsp.reverb} min={0} max={1} label="Reverb" sub={`${Math.round(dsp.reverb * 100)}%`} size={72} onChange={(v) => dsp.set("reverb", +v.toFixed(2))} onReset={() => dsp.set("reverb", 0)} />
            <Knob value={dsp.echo} min={0} max={1} label="Echo" sub={`${Math.round(dsp.echo * 100)}%`} size={72} onChange={(v) => dsp.set("echo", +v.toFixed(2))} onReset={() => dsp.set("echo", 0)} />
            <Knob value={dsp.vocal} min={0} max={1} label="Vocal fade" sub={dsp.vocal === 0 ? "Off" : `−${Math.round(dsp.vocal * 100)}%`} color={CUT} size={72} onChange={(v) => dsp.set("vocal", +v.toFixed(2))} onReset={() => dsp.set("vocal", 0)} />
          </div>
        )}

      </div>

      {/* ── presets (Flat = reset) + a slim quick-action row — no section labels, no bulky cards ── */}
      <div className="wp-eq-preset-row">
        <button className="wp-chip wp-chip-lead" onClick={() => setBrowse(true)} title="Browse all presets">
          <Icon name="playlist" size={15} /> Browse{customCount > 0 && <span className="wp-chip-count">{customCount}</span>}
        </button>
        {EQ_PRESETS.map((p) => (
          <button key={p.name} className={`wp-chip ${presetName === p.name ? "wp-chip-on" : ""}`} onClick={() => applyPresetMorph(p)}>{p.name}</button>
        ))}
      </div>
      <input ref={aeqRef} type="file" accept=".txt,text/plain" style={{ display: "none" }}
        onChange={(e) => { importAutoEq(e.target.files?.[0]); e.target.value = ""; }} />
      <div className="wp-eq-actions">
        <button className="wp-eq-act wp-eq-act-primary" onClick={autoEq} disabled={autoing} title="Analyse this track and tune the EQ to it">
          <Icon name="bolt" size={18} /> {autoing ? "Tuning…" : "Auto"}
        </button>
        <button className={`wp-eq-act ${pinned ? "wp-eq-act-on" : ""}`} onClick={togglePin} title={pinned ? "EQ pinned to this song — tap to unpin" : "Pin this EQ to the current song"}>
          <Icon name={pinned ? "star" : "starOutline"} size={18} /> {pinned ? "Pinned" : "Pin"}
        </button>
        <button className="wp-eq-act" onClick={() => setSaving(true)} title="Save this curve as a preset">
          <Icon name="check" size={18} /> Save
        </button>
        <button className="wp-eq-act wp-eq-act-icon" onClick={() => aeqRef.current?.click()} title="Import a headphone's AutoEq (ParametricEQ.txt)">
          <Icon name="tune" size={18} />
        </button>
      </div>

      {info && <AudioInfo onClose={() => setInfo(false)} />}
      {browse && <PresetBrowser onClose={() => setBrowse(false)} />}
      {saving && <SavePresetDialog defaultName={presetName && presetName !== "Custom" ? presetName : "My preset"} songTitle={cur?.title} onSave={doSave} onClose={() => setSaving(false)} />}
    </div>
  );
}
