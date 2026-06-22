import { useEffect, useRef } from "react";
import { drawDna } from "@/lib/soundDna";

/** A track's deterministic Sound-DNA fingerprint glyph (cover fallback + library "gallery of shapes").
 *  Renders at a capped resolution and fills its parent via CSS — so callers can pass a "fill the box"
 *  size (e.g. a grid tile) without blowing past the browser's max canvas size and rendering blank. */
export function SoundDna({ id, size }: { id: string; size: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const draw = () => {
      const dpr = Math.min(typeof devicePixelRatio !== "undefined" ? devicePixelRatio : 1, 3);
      // Match the canvas backing to the element's REAL box (w may ≠ h in a non-square collage cell), so the
      // square glyph is never stretched into an oval. Draw it as a CENTERED SQUARE sized to the LARGER edge
      // (object-fit:cover) → it always stays circular + fills the cell, just cropped if the cell isn't square.
      const w = Math.min(Math.max(Math.round(cv.clientWidth || size), 1), 1100);
      const h = Math.min(Math.max(Math.round(cv.clientHeight || size), 1), 1100);
      const pxw = Math.round(w * dpr), pxh = Math.round(h * dpr);
      if (cv.width !== pxw || cv.height !== pxh) { cv.width = pxw; cv.height = pxh; }
      const ctx = cv.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const s = Math.max(w, h);
      ctx.save();
      ctx.translate((w - s) / 2, (h - s) / 2);
      drawDna(ctx, s, s, id);
      ctx.restore();
    };
    draw();
    // Redraw crisply when the element resizes (player stage vs a tiny list thumbnail).
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") { ro = new ResizeObserver(draw); ro.observe(cv); }
    return () => ro?.disconnect();
  }, [id, size]);
  return <canvas ref={ref} className="wp-dna" aria-hidden />;
}
