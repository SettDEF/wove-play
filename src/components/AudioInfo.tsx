import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useShallow } from "zustand/react/shallow";
import { usePlayer } from "@/store/player";
import { useDsp } from "@/store/dsp";
import { useSettings } from "@/store/settings";
import { useUi } from "@/store/ui";
import { engine } from "@/audio/engine";
import { saveOutputProfile, loadOutputProfile } from "@/store/outputs";
import { toast } from "@/store/toasts";
import { fmtTime } from "@/lib/format";
import { useBackGuard } from "@/lib/backStack";
import { useCover } from "./Cover";
import { Icon } from "./Icons";
import { PathCrumbs } from "./PathCrumbs";

/** One labelled metric line inside a tier. `to` makes the value a tappable link (jumps to a screen). */
function Line({ label, v, k, to }: { label?: string; v?: string; k?: string; to?: () => void }) {
  if (k) return <div className="wp-ai-k md-body-m">{k}</div>;
  return (
    <div className="wp-ai-line">
      <span className="wp-ai-label md-body-s wp-muted">{label}</span>
      {to ? <button className="wp-ai-v wp-ai-link md-body-m" onClick={to}>{v}</button> : <span className="wp-ai-v md-body-m">{v}</span>}
    </div>
  );
}

/** A signal-chain tier (Track → Decoder → DSP → Output …) with an icon + connector. */
function Tier({ icon, title, children }: { icon: string; title: string; children: React.ReactNode }) {
  return (
    <div className="wp-ai-tier">
      <div className="wp-ai-tier-icon"><Icon name={icon} size={18} /></div>
      <div className="wp-ai-tier-body">
        <div className="md-title-s wp-ai-tier-title">{title}</div>
        {children}
      </div>
    </div>
  );
}

/** Poweramp-style "Audio Info": the real signal chain + per-output EQ profiles. */
export function AudioInfo({ onClose }: { onClose: () => void }) {
  useBackGuard(true, onClose); // self-guard: mounted only while open → Android back / Esc closes it
  const track = usePlayer((s) => s.current());
  // Shallow-selected so this panel doesn't re-render on every 10Hz position tick (whole-store subscription). [perf]
  const { bandQs, preamp, presetName, eqEnabled } = usePlayer(
    useShallow((s) => ({ bandQs: s.bandQs, preamp: s.preamp, presetName: s.presetName, eqEnabled: s.eqEnabled })),
  );
  const crossfade = useSettings((s) => s.crossfade);
  const gapless = useSettings((s) => s.gapless);
  const dsp = useDsp();
  const [outputs, setOutputs] = useState<{ id: string; label: string }[]>([]);
  const [sink, setSink] = useState(engine.sinkId);
  const cover = useCover(track?.path);
  useEffect(() => { void engine.listOutputs().then(setOutputs); }, []);

  // Real audio formats only — a content:// URI (e.g. .../media/1000036556) has no extension, so the naive
  // "last path segment after a dot" yielded the MediaStore id. Show the format only when it's a genuine
  // audio extension, else "Audio".
  const AUDIO_EXTS = new Set(["MP3", "FLAC", "WAV", "OGG", "OGA", "M4A", "AAC", "OPUS", "WMA", "AIFF", "AIF", "ALAC", "MP4", "MKA", "WV", "APE"]);
  const rawExt = (track?.path.split(/[\\/]/).pop()?.split(".").pop() || "").toUpperCase();
  const ext = AUDIO_EXTS.has(rawExt) ? rawExt : "";
  const avgQ = bandQs.length ? bandQs.reduce((a, b) => a + b, 0) / bandQs.length : 1.1;
  const latency = engine.outputLatency || engine.baseLatency;
  const sr = engine.sampleRate;
  const ch = engine.contextState === "uninitialised" ? "—" : "Stereo";
  // Active DSP effects → a compact summary line so you can see what's coloured the sound.
  const fx = [
    dsp.bass !== 0 && `Bass ${dsp.bass > 0 ? "+" : ""}${dsp.bass}`,
    dsp.treble !== 0 && `Treble ${dsp.treble > 0 ? "+" : ""}${dsp.treble}`,
    dsp.vocal > 0 && "Vocal cut",
    dsp.reverb > 0 && "Reverb",
    dsp.echo > 0 && "Echo",
  ].filter(Boolean).join(" · ");

  // Navigate FIRST, then close — closing unmounts this portal, so doing it last avoids tearing down
  // mid-handler. Deep-link straight to the exact Settings sub-page (not the root menu).
  const goEq = () => { usePlayer.getState().setTab("eq"); onClose(); };
  const goSetting = (sub: string) => { useUi.getState().openSettings(sub); usePlayer.getState().setTab("settings"); onClose(); };
  const pickOutput = async (id: string) => {
    const ok = await engine.setOutput(id);
    if (ok) { setSink(id); if (loadOutputProfile(id)) toast.info("Applied this output's EQ."); }
    else toast.info("This webview manages output devices itself.");
  };

  // Portal to <body>: rendered inline it gets trapped by the player's transform (pull-down / screen
  // anim), which re-anchors position:fixed and drops it to the bottom instead of centering.
  return createPortal(
    <div className="wp-ai" onClick={onClose}>
      <div className="wp-ai-card" onClick={(e) => e.stopPropagation()}>
        <div className="wp-ai-head">
          <span className="wp-ai-headmark"><Icon name="hub" size={18} /></span>
          <span className="md-title-m">Audio Info</span>
          <button className="md-icon-btn" onClick={onClose} title="Close"><Icon name="close" size={20} /></button>
        </div>

        {/* Now-playing header: cover + title so the panel reads as "info about THIS track", not abstract specs. */}
        {track && (
          <div className="wp-ai-now">
            <div className="wp-ai-cover">
              {cover ? <img src={cover} alt="" /> : <Icon name="music" size={22} color="var(--md-on-surface-variant)" />}
            </div>
            <div className="wp-ai-nowtext">
              <div className="md-title-s ellipsis">{track.title}</div>
              <div className="md-body-s wp-muted ellipsis">{track.artist}</div>
            </div>
            <div className="wp-ai-badges">
              {ext && <span className="wp-ai-badge">{ext}</span>}
              {sr > 0 && <span className="wp-ai-badge">{(sr / 1000).toFixed(sr % 1000 ? 1 : 0)}kHz</span>}
              {eqEnabled && <span className="wp-ai-badge wp-ai-badge-on">EQ</span>}
            </div>
          </div>
        )}

        <div className="wp-ai-chain">
          <Tier icon="music" title="Source">
            {track ? <>
              <Line label="Format" v={`${ext || "Audio"} · ${fmtTime(track.duration)}`} />
              <Line label="Channels" v={ch} />
              <Line label="Gapless" v={gapless ? "On" : "Off"} to={() => goSetting("playback")} />
              <div className="wp-ai-path-row">
                <span className="wp-ai-label md-body-s wp-muted">Folder</span>
                <PathCrumbs className="wp-ai-path md-body-s" path={track.path}
                  onPick={(f) => { usePlayer.getState().goToFolder(f); onClose(); }} />
              </div>
            </> : <Line k="Nothing playing" />}
          </Tier>

          <Tier icon="bolt" title="Decoder">
            <Line label="Engine" v={engine.isNative() ? "Native (hi-res)" : "Web Audio"} />
            <Line label="Codec" v={ext ? `${ext} · system` : "System codec"} />
          </Tier>

          <Tier icon="graphicEq" title="DSP">
            <Line label="Sample Rate" v={sr ? `${(sr / 1000).toFixed(1)} kHz` : "—"} to={() => goSetting("audio")} />
            <Line label="Block Size" v={engine.blockSize ? String(engine.blockSize) : "—"} to={() => goSetting("audio")} />
            <Line label="Equalizer" v={`${eqEnabled ? "On" : "Off"} · graphic`} to={goEq} />
            <Line label="Bands" v={`10 (31–16k · Q ${avgQ.toFixed(2)})`} to={goEq} />
            <Line label="Tone" v={`Bass ${dsp.bass > 0 ? "+" : ""}${dsp.bass} dB · Treble ${dsp.treble > 0 ? "+" : ""}${dsp.treble} dB`} to={goEq} />
            {dsp.vocal > 0 && <Line label="Vocal fader" v={`−${Math.round(dsp.vocal * 100)}%`} to={goEq} />}
            <Line label="Effects" v={fx || "None"} to={goEq} />
            <Line label="Preamp" v={`${preamp > 0 ? "+" : ""}${preamp.toFixed(1)} dB`} to={goEq} />
            <Line label="Preset" v={presetName} to={goEq} />
          </Tier>

          <Tier icon="volume" title="Output">
            <Line label="Volume" v="DVC (digital)" />
            <Line label="Crossfade" v={crossfade ? `${crossfade}s` : "No fading"} to={() => goSetting("playback")} />
            <Line label="Latency" v={latency ? `${Math.round(latency * 1000)} ms` : "—"} />
            <Line label="Engine" v={engine.contextState} />
          </Tier>

          <Tier icon="hub" title="Output Device">
            {outputs.length ? (
              <select className="wp-ai-select md-body-m" value={sink} onChange={(e) => void pickOutput(e.target.value)}>
                {outputs.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
              </select>
            ) : <Line k="Managed by system" />}
            <div className="wp-ai-actions">
              <button className="wp-tonal-btn wp-btn-sm" onClick={() => { saveOutputProfile(sink); toast.success("EQ saved for this output."); }}>Save EQ for output</button>
              <button className="wp-tonal-btn wp-btn-sm" onClick={() => { if (loadOutputProfile(sink)) toast.success("Loaded output EQ."); else toast.info("No saved EQ for this output yet."); }}>Load</button>
            </div>
          </Tier>
        </div>
      </div>
    </div>,
    document.body,
  );
}
