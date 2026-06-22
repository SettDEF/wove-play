import { useEffect, useRef, useState } from "react";
import type { Section, WaveEnvelope } from "@/lib/trackAnalysis";
import { scratchMove, scratchEnd } from "@/audio/scratch";

/** The seekbar IS the song: a real waveform painted with energy sections (low/mid/high = dim → bright),
 *  played portion lit, rest muted. Tap/drag to seek; double-tap → skip to drop; PRESS-AND-HOLD → a
 *  beat-quantized loop-roll of that bar (release = walk on). Themed off --md-primary. */
export function SongSeek({
  value, max = 1, peaks, wave, sections, onChange, onCommit, height = 56, sectionTint = true,
  bpm, firstBeat, loop, onLoop, zoom = 1, offset = 0, onExpand, liveZoom = false, onToggleZoom,
}: {
  value: number; max?: number; peaks: number[]; wave?: WaveEnvelope; sections: Section[];
  onChange: (v: number) => void; onCommit?: (v: number) => void; height?: number; sectionTint?: boolean;
  bpm?: number; firstBeat?: number;
  loop?: { start: number; end: number } | null;
  onLoop?: (r: { start: number; end: number } | null) => void;
  /** Optional zoom (≥1) + start offset (0..1) so a host (the fullscreen editor) can zoom into the window. */
  zoom?: number; offset?: number;
  /** When set, a press-and-hold opens the fullscreen sections editor instead of the loop-roll. */
  onExpand?: () => void;
  /** Inline timeline: double-tap toggles a deep zoom that auto-scrolls to follow playback. */
  liveZoom?: boolean;
  /** When the host controls the zoom, the double-tap calls this instead of the internal autoZoom. */
  onToggleZoom?: () => void;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const cv = useRef<HTMLCanvasElement>(null);
  const lastTap = useRef(0);
  const ptrs = useRef<Set<number>>(new Set()); // active pointers — 2+ = a pinch, suppress seeking
  const multi = useRef(false);
  const holdTimer = useRef<number | null>(null);
  const looping = useRef(false);
  const held = useRef(false); // a hold fired (opened the editor) → release must NOT seek
  const [w, setW] = useState(320);
  const [scrub, setScrub] = useState<number | null>(null); // fraction being scrubbed → show section label
  const [autoZoom, setAutoZoom] = useState(1); // double-tap live-zoom (only when liveZoom + uncontrolled)
  const span = max || 1;
  const pct = Math.max(0, Math.min(1, value / span));
  const barLen = bpm && bpm > 0 ? (4 * 60) / bpm : 0; // one bar = 4 beats, seconds
  // effective window: controlled zoom/offset wins; else the double-tap autoZoom, which auto-follows
  // the playhead so the waveform scrolls LIVE while playing.
  const effZoom = zoom > 1 ? zoom : autoZoom;
  const effOffset = zoom > 1 ? offset
    : autoZoom > 1 ? Math.max(0, Math.min(1 - 1 / autoZoom, pct - 0.5 / autoZoom)) : 0;

  const labelAt = (f: number) => { for (const s of sections) if (f >= s.start && f < s.end) return s.label; return ""; };

  useEffect(() => {
    const el = wrap.current; if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth || 320));
    ro.observe(el); setW(el.clientWidth || 320);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const canvas = cv.current; if (!canvas || !peaks.length) return;
    const dpr = Math.min(typeof devicePixelRatio !== "undefined" ? devicePixelRatio : 1, 2);
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext("2d"); if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, height);
    const css = getComputedStyle(document.documentElement);
    const primary = css.getPropertyValue("--md-primary").trim() || "#7ce2b0";
    const muted = css.getPropertyValue("--md-outline-variant").trim() || "#666";
    const tierFrac = (f: number) => { for (const s of sections) if (f >= s.start && f < s.end) return s.tier; return 1; };
    // visible window of the track in fractions [win0, win1] (zoom/offset or the live double-tap zoom)
    const z = Math.max(1, effZoom);
    const win0 = Math.max(0, Math.min(1 - 1 / z, effOffset));
    const winSpan = 1 / z;
    const fracAtX = (x: number) => win0 + (x / w) * winSpan;

    if (wave && wave.max.length) {
      // REAL filled min/max waveform (Bitwig-style): trace the top (max) then back along the bottom
      // (min) into one closed path and fill it — a smooth solid body, not a barcode of bars.
      const WRn = wave.max.length, mid = height / 2, amp = (height - 3) / 2;
      const idx = (x: number) => Math.min(WRn - 1, Math.max(0, Math.floor(fracAtX(Math.min(w - 1, x)) * WRn)));
      const trace = () => {
        ctx.beginPath();
        ctx.moveTo(0, mid - wave.max[idx(0)] * amp);
        for (let x = 1; x <= w; x++) ctx.lineTo(x, mid - wave.max[idx(x)] * amp);
        for (let x = w; x >= 0; x--) ctx.lineTo(x, mid - wave.min[idx(x)] * amp);
        ctx.closePath();
      };
      const playX = ((pct - win0) / winSpan) * w;
      trace(); ctx.globalAlpha = 0.32; ctx.fillStyle = muted; ctx.fill();   // unplayed base
      if (playX > 0.5) {                                                     // played, lit, clipped to the playhead
        ctx.save(); ctx.beginPath(); ctx.rect(0, 0, playX, height); ctx.clip();
        trace(); ctx.globalAlpha = 0.95; ctx.fillStyle = primary; ctx.fill();
        if (sectionTint) for (const s of sections) {                        // subtle energy tint per played section
          const a = Math.max(win0, s.start), b = Math.min(Math.min(win0 + winSpan, pct), s.end);
          if (b <= a) continue;
          ctx.save(); ctx.beginPath(); ctx.rect(((a - win0) / winSpan) * w, 0, ((b - a) / winSpan) * w, height); ctx.clip();
          trace(); ctx.globalAlpha = 0.10 + (2 - s.tier) * 0.07; ctx.fillStyle = "#000"; ctx.fill(); ctx.restore();
        }
        ctx.restore();
      }
    } else {
      // fallback: coarse squared bars from `peaks`
      const n = peaks.length, bw = w / n;
      for (let i = 0; i < n; i++) {
        const f = (i + 0.5) / n;
        if (f < win0 || f > win0 + winSpan) continue;
        const x = ((f - win0) / winSpan) * w;
        const bh = Math.max(1.5, peaks[i] * peaks[i] * (height - 3)), y = (height - bh) / 2;
        const played = f <= pct;
        ctx.fillStyle = played ? primary : muted;
        ctx.globalAlpha = played ? (sectionTint ? 0.45 + tierFrac(f) * 0.275 : 0.9) : 0.30;
        ctx.fillRect(x, y, Math.max(1, (bw * z) - (bw * z > 2.4 ? 0.7 : 0)), bh);
      }
    }
    ctx.globalAlpha = 1;
    // playhead (only when inside the visible window)
    if (pct >= win0 && pct <= win0 + winSpan) {
      const px = ((pct - win0) / winSpan) * w;
      ctx.fillStyle = primary;
      ctx.fillRect(Math.min(w - 2, Math.max(0, px - 1)), 0, 2, height);
    }
  }, [peaks, wave, sections, value, span, w, height, pct, sectionTint, effZoom, effOffset]);

  const fracAt = (clientX: number) => {
    const el = wrap.current; if (!el) return 0;
    const r = el.getBoundingClientRect();
    const local = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    const z = Math.max(1, effZoom);
    const win0 = Math.max(0, Math.min(1 - 1 / z, effOffset));
    return Math.max(0, Math.min(1, win0 + local / z));
  };
  /** Double-tap → jump to the next high-energy "Drop" (wraps to the first if none ahead). */
  const skipToDrop = () => {
    const drops = sections.filter((s) => s.tier === 2);
    if (!drops.length) return;
    const next = drops.find((s) => s.start > pct + 0.01) ?? drops[0];
    const v = next.start * span;
    onChange(v); onCommit?.(v);
  };
  /** The beat-quantized bar (seconds) containing fraction `f`. null if no grid. */
  const barAt = (f: number): { start: number; end: number } | null => {
    if (!barLen) return null;
    const sec = f * span;
    const fb = firstBeat ?? 0;
    const k = Math.floor((sec - fb) / barLen);
    const start = Math.max(0, fb + k * barLen);
    return { start, end: Math.min(span, start + barLen) };
  };
  const clearHold = () => { if (holdTimer.current) { clearTimeout(holdTimer.current); holdTimer.current = null; } };

  const onPtrEnd = (e: React.PointerEvent) => { ptrs.current.delete(e.pointerId); if (ptrs.current.size === 0) multi.current = false; };
  const onDown = (e: React.PointerEvent) => {
    e.preventDefault();
    ptrs.current.add(e.pointerId);
    if (ptrs.current.size >= 2) { multi.current = true; clearHold(); return; } // a pinch — let the host zoom, don't seek
    const now = e.timeStamp;
    if (now - lastTap.current < 300) { // double-tap
      lastTap.current = 0;
      if (liveZoom) { if (onToggleZoom) onToggleZoom(); else setAutoZoom((z) => (z > 1 ? 1 : 12)); navigator.vibrate?.(16); } // deep live-following zoom (host-controlled when wired)
      else skipToDrop();
      return;
    }
    lastTap.current = now;
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    const startX = e.clientX;
    const f0 = fracAt(startX);
    looping.current = false; held.current = false;
    setScrub(f0);
    // press-and-hold (no move): open the fullscreen editor if wired, else a beat-quantized loop-roll
    clearHold();
    if (onExpand) {
      holdTimer.current = window.setTimeout(() => { holdTimer.current = null; held.current = true; navigator.vibrate?.(14); onExpand(); }, 380);
    } else if (barLen && onLoop) {
      holdTimer.current = window.setTimeout(() => {
        holdTimer.current = null;
        looping.current = true;
        navigator.vibrate?.(12);
        const r = barAt(fracAt(startX));
        if (r) onLoop(r);
      }, 280);
    }
    let moved = false;
    const move = (ev: PointerEvent) => {
      if (multi.current) return; // a second finger landed → pinch, abort the seek
      const f = fracAt(ev.clientX);
      if (!moved && Math.abs(ev.clientX - startX) > 6) { moved = true; clearHold(); } // a drag, not a hold
      if (looping.current) { const r = barAt(f); if (r) onLoop?.(r); } // slide the loop across bars
      else if (moved) { setScrub(f); onChange(f * span); scratchMove(ev.clientX, ev.timeStamp); } // seek + vinyl-scratch SFX
    };
    const up = (ev: PointerEvent) => {
      clearHold();
      scratchEnd(); // fade the scrub-scratch out
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setScrub(null);
      if (multi.current) return; // pinch in progress → don't seek/commit
      if (held.current) { held.current = false; return; } // a hold opened the editor → don't seek to the spot
      if (looping.current) { looping.current = false; onLoop?.(null); navigator.vibrate?.(6); } // release → walk on
      else {
        const v = fracAt(ev.clientX) * span;
        if (!moved) onChange(v); // a plain tap seeks
        onCommit?.(v);
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const labelFrac = scrub ?? pct;
  const label = looping.current && loop ? "LOOP" : scrub != null ? labelAt(scrub) : "";
  return (
    <div ref={wrap} className={`wp-songseek ${loop ? "wp-songseek-looping" : ""}`} style={{ height }} onPointerDown={onDown} onPointerUp={onPtrEnd} onPointerCancel={onPtrEnd} title="Hold → loop bar · double-tap → skip to drop">
      <canvas ref={cv} style={{ width: "100%", height, display: "block" }} />
      {loop && (
        <span
          className="wp-seek-loop"
          style={{ left: `${(loop.start / span) * 100}%`, width: `${((loop.end - loop.start) / span) * 100}%` }}
        />
      )}
      {label && (
        <span className="wp-seek-label md-label-m" style={{ left: `${Math.max(8, Math.min(92, labelFrac * 100))}%` }}>{label}</span>
      )}
    </div>
  );
}
