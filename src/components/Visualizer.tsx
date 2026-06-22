import { useEffect, useRef, useState } from "react";
import { engine } from "@/audio/engine";
import { makeBuffers } from "@/audio/vizRender";
import { makeSceneRenderer } from "@/audio/sceneRenderer";
import { useViz } from "@/store/viz";
import { usePlayer } from "@/store/player";
import { useSettings } from "@/store/settings";
import { useLyrics } from "@/store/lyrics";
import { parseLrc, activeLine, type LrcLine } from "@/lib/lrc";
import { perfEco, perfEcoFpsCap } from "@/lib/perfRuntime";

/** Live on-screen surface: renders the current scene (read live each frame) into a canvas that
 *  fills its host, via the GPU (WebGL2) renderer or the Canvas2D fallback. */
export function Visualizer({ showText = true, paused = false }: { showText?: boolean; paused?: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const raf = useRef<number>(0);
  const pausedRef = useRef(paused); pausedRef.current = paused;
  // bumped to force a fresh canvas/context if WebGL loses its context (recovery)
  const [gen, setGen] = useState(0);

  useEffect(() => {
    const host = hostRef.current, cv = canvasRef.current;
    if (!host || !cv) return;
    const r = makeSceneRenderer(cv, true); // GPU only (Canvas2D used only if WebGL2 is unavailable)
    let w = 0, h = 0;
    const resize = () => {
      w = host.clientWidth; h = host.clientHeight;
      // cap backing resolution to bound GPU memory (bloom uses 3 framebuffers): dpr ≤ 1.5, longest side ≤ 1920.
      // The dynamic governor (eco) drops to the low-power resolution too, so a struggling device recovers.
      const low = useSettings.getState().lowPower || perfEco();
      let dpr = Math.min(window.devicePixelRatio || 1, low ? 1 : 1.5);
      const longest = Math.max(w, h) * dpr;
      const maxLong = low ? 1280 : 1920;
      if (longest > maxLong) dpr *= maxLong / longest;
      cv.width = Math.max(1, Math.round(w * dpr)); cv.height = Math.max(1, Math.round(h * dpr));
    };
    const ro = new ResizeObserver(resize); ro.observe(host); resize();

    // recover gracefully if the browser drops the GL context (memory pressure / GPU reset)
    const onLost = (e: Event) => { e.preventDefault(); cancelAnimationFrame(raf.current); setGen((g) => g + 1); };
    cv.addEventListener("webglcontextlost", onLost);

    const buf = makeBuffers();
    let last = 0;
    // cache the parsed .lrc by raw string so we don't re-parse 60×/sec
    let lrcRaw = "", lrcLines: LrcLine[] = [];
    const loop = (now: number) => {
      raf.current = requestAnimationFrame(loop);
      if (document.hidden || pausedRef.current) return; // skip when hidden or covered (e.g. fullscreen over the tab preview)
      const st = useSettings.getState();
      // eco (dynamic/battery governor) caps to 30; else low-power → ≤30fps; else the user's cap.
      const cap = perfEcoFpsCap() ?? (st.lowPower ? Math.min(st.fpsCap || 60, 30) : st.fpsCap);
      if (cap > 0) { const minDt = 1000 / cap - 1; if (now - last < minDt) return; last = now; }
      const scene = useViz.getState().scene;
      r.setBloom?.(useViz.getState().bloom);
      const t = showText ? usePlayer.getState().current() : null;
      let lyric: string | undefined;
      if (t) {
        const raw = useLyrics.getState().map[t.id] || "";
        if (raw !== lrcRaw) { lrcRaw = raw; lrcLines = raw ? parseLrc(raw) : []; }
        if (lrcLines.length) {
          const idx = activeLine(lrcLines, usePlayer.getState().position);
          if (idx >= 0) lyric = lrcLines[idx].text;
        }
      }
      const text = t ? { title: t.title, artist: t.artist, lyric } : undefined;
      r.render(cv.width, cv.height, scene, engine.analyser, buf, text);
    };
    raf.current = requestAnimationFrame(loop);
    return () => { cancelAnimationFrame(raf.current); ro.disconnect(); cv.removeEventListener("webglcontextlost", onLost); r.dispose(); };
  }, [showText, gen]);

  const vignette = useViz((s) => s.vignette);
  return (
    <div ref={hostRef} className="wp-viz">
      <canvas key={gen} ref={canvasRef} />
      {vignette > 0 && <div className="wp-viz-vignette" style={{ opacity: vignette }} />}
    </div>
  );
}
