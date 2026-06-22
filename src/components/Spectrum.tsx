import { useEffect, useRef } from "react";
import { engine } from "@/audio/engine";

/** Live frequency-spectrum bars from the engine analyser — drawn behind the EQ curve. */
export function Spectrum({ color = "var(--md-primary)", height = 72 }: { color?: string; height?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    let raf = 0;
    // getComputedStyle forces a style/layout flush — doing it 60×/sec just to read the themed colour is
    // pure waste, and the colour only changes on a theme switch. Re-read it ~twice a second instead.
    let fillCol = "#888";
    let colFrame = 0;
    const n0 = engine.analyser?.frequencyBinCount ?? 1024;
    const data = new Uint8Array(n0); // reused every frame — no per-frame allocation
    const draw = () => {
      // Don't draw while backgrounded (keepAlive keeps rAF firing for audio). [perf/heat]
      if (document.hidden) { raf = requestAnimationFrame(draw); return; }
      const an = engine.analyser;
      const w = cv.clientWidth || 300, h = cv.clientHeight || height;
      if (cv.width !== w) cv.width = w;
      if (cv.height !== h) cv.height = h;
      ctx.clearRect(0, 0, w, h);
      if (an) {
        const n = Math.min(an.frequencyBinCount, data.length);
        an.getByteFrequencyData(data);
        const bars = 56;
        const step = Math.max(1, Math.floor((n * 0.72) / bars)); // skip the near-empty top octave
        if (colFrame++ % 30 === 0) fillCol = getComputedStyle(cv).color || "#888";
        ctx.fillStyle = fillCol;
        const bw = w / bars;
        for (let i = 0; i < bars; i++) {
          let m = 0;
          for (let j = 0; j < step; j++) m = Math.max(m, data[i * step + j] || 0);
          const bh = (m / 255) * h;
          ctx.globalAlpha = 0.3 + 0.55 * (m / 255);
          ctx.fillRect(i * bw + 1, h - bh, bw - 2, bh);
        }
        ctx.globalAlpha = 1;
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [height]);
  return <canvas ref={ref} className="wp-spectrum" style={{ height, color }} />;
}
