import { useRef, useState } from "react";
import { useViz } from "@/store/viz";
import { usePlayer } from "@/store/player";
import { useSettings } from "@/store/settings";
import { engine } from "@/audio/engine";
import { makeBuffers } from "@/audio/vizRender";
import { makeSceneRenderer, type SceneRenderer } from "@/audio/sceneRenderer";
import { startRecording, downloadBlob, exportSupported, type Recording } from "@/audio/recorder";
import { hasTauri, isAndroid, pickSavePath, saveFile } from "@/lib/backend";
import { Icon } from "../Icons";

const FPS_OPTS = [24, 30, 60];
const QUALITY = [{ label: "720p", base: 720 }, { label: "1080p", base: 1080 }, { label: "4K", base: 2160 }];

/** Dimensions for the scene aspect at a given short-side base. */
function dims(aspect: string, base: number): { w: number; h: number } {
  if (aspect === "9:16") return { w: base, h: Math.round(base * 16 / 9) };
  if (aspect === "1:1") return { w: base, h: base };
  return { w: Math.round(base * 16 / 9), h: base }; // 16:9 / fit
}

/** Record the current scene (GPU or Canvas2D) + live audio to a webm. */
export function ExportPanel() {
  const aspect = useViz((s) => s.scene.aspect);
  const rec = useRef<Recording | null>(null);
  const sr = useRef<SceneRenderer | null>(null);
  const raf = useRef<number>(0);
  const [recording, setRecording] = useState(false);
  const [q, setQ] = useState(() => (useSettings.getState().exportRes === "720p" ? 0 : 1));
  const [fps, setFps] = useState(() => useSettings.getState().exportFps as number);
  const [status, setStatus] = useState("");

  const start = () => {
    if (!exportSupported()) { setStatus("Export not supported here"); return; }
    const { w, h } = dims(aspect, QUALITY[q].base);
    const cv = document.createElement("canvas"); cv.width = w; cv.height = h;
    const r = makeSceneRenderer(cv, true); // GPU render for export (Canvas2D only if WebGL2 unavailable)
    sr.current = r;
    if (!usePlayer.getState().playing) usePlayer.getState().toggle();
    const buf = makeBuffers();
    const loop = () => {
      raf.current = requestAnimationFrame(loop);
      r.setBloom?.(useViz.getState().bloom);
      const t = usePlayer.getState().current();
      r.render(w, h, useViz.getState().scene, engine.analyser, buf, t ? { title: t.title, artist: t.artist } : undefined);
    };
    raf.current = requestAnimationFrame(loop);
    rec.current = startRecording(cv, fps);
    setRecording(true);
    setStatus("Recording — play through the part you want, then Stop.");
  };

  const stop = async () => {
    cancelAnimationFrame(raf.current);
    const r = rec.current; rec.current = null; setRecording(false);
    if (!r) { sr.current?.dispose(); sr.current = null; return; }
    setStatus("Encoding…");
    const blob = await r.stop();
    sr.current?.dispose(); sr.current = null;
    const t = usePlayer.getState().current();
    const name = `${(t?.title || "visualizer").replace(/[^\w.-]+/g, "_")}.webm`;
    // desktop → native save dialog; browser/Android → download
    if (hasTauri && !isAndroid) {
      const path = await pickSavePath(name, ["webm"]);
      if (path) { await saveFile(path, new Uint8Array(await blob.arrayBuffer())); setStatus(`Saved · ${(blob.size / 1e6).toFixed(1)} MB`); }
      else setStatus("Save cancelled");
    } else {
      downloadBlob(blob, name);
      setStatus(`Saved ${name} · ${(blob.size / 1e6).toFixed(1)} MB`);
    }
  };

  return (
    <div className="wp-export">
      <div className="wp-export-head md-title-s"><Icon name="graphicEq" size={18} color="var(--md-primary)" /> Export video</div>
      <div className="wp-export-row">
        <div className="wp-seg wp-seg-sm">
          {QUALITY.map((r, i) => <button key={r.label} className={`wp-seg-item ${q === i ? "wp-seg-on" : ""}`} onClick={() => setQ(i)}>{r.label}</button>)}
        </div>
        <div className="wp-seg wp-seg-sm">
          {FPS_OPTS.map((fr) => <button key={fr} className={`wp-seg-item ${fps === fr ? "wp-seg-on" : ""}`} onClick={() => setFps(fr)}>{fr}fps</button>)}
        </div>
      </div>
      <button className={`wp-filled-btn ${recording ? "wp-rec" : ""}`} onClick={recording ? stop : start}>
        <Icon name={recording ? "pause" : "play"} size={18} />
        {recording ? "Stop & save" : "Record"}
      </button>
      {status && <div className="md-body-s wp-muted">{status}</div>}
    </div>
  );
}
