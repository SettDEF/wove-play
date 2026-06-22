import { useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { usePlayer } from "@/store/player";
import { useSectionEdits } from "@/store/sectionEdits";
import { useBackGuard } from "@/lib/backStack";
import { saveTextFile } from "@/lib/backend";
import { toast } from "@/store/toasts";
import { buzz } from "@/lib/touch";
import { fmtTime } from "@/lib/format";
import type { Section, WaveEnvelope } from "@/lib/trackAnalysis";
import { SongSeek } from "./SongSeek";
import { Icon } from "./Icons";

const TIERS: { tier: 0 | 1 | 2; label: string; color: string }[] = [
  { tier: 0, label: "Break", color: "#5a87c0" },
  { tier: 1, label: "Verse", color: "var(--md-tertiary, #8b7fd0)" },
  { tier: 2, label: "Drop", color: "var(--md-primary)" },
];
const tierColor = (s: Section) => TIERS.find((t) => t.tier === s.tier)?.color ?? "#5a87c0";
const MINLEN = 0.01; // smallest section as a fraction of the track

/**
 * Fullscreen sections editor — opened by holding the Now-Playing timeline. Bloom-to-centre over a
 * blurred backdrop. View sections as colored bands, tap to skip; pinch to zoom (bar→beat grid densifies);
 * Edit mode lets you rename, recolor, drag boundaries, split at the playhead, and delete (merge). Edits
 * persist per track and override detection everywhere until Reset.
 */
export function SectionsEditor({
  trackId, peaks, wave, detected, bpm, firstBeat, duration, onClose,
}: {
  trackId: string; peaks: number[]; wave?: WaveEnvelope; detected: Section[];
  bpm?: number; firstBeat?: number; duration: number; onClose: () => void;
}) {
  const position = usePlayer((s) => s.position);
  const playing = usePlayer((s) => s.playing);
  const override = useSectionEdits((s) => s.edits[trackId]);
  const secs = override ?? detected;
  const [zoom, setZoom] = useState(1);
  const [bars, setBars] = useState(true);
  const [edit, setEdit] = useState(false);
  const [snap, setSnap] = useState(true);
  const [sel, setSel] = useState<number | null>(null);
  const [closing, setClosing] = useState(false);
  const pinch = useRef<{ d: number; z: number } | null>(null);
  const stage = useRef<HTMLDivElement>(null);
  useBackGuard(true, () => close());

  const dur = duration || 1;
  const pct = Math.max(0, Math.min(1, position / dur));
  const winSpan = 1 / Math.max(1, zoom);
  const win0 = zoom <= 1 ? 0 : Math.max(0, Math.min(1 - winSpan, pct - winSpan / 2));
  const xOf = (f: number) => `${((f - win0) / winSpan) * 100}%`;
  const seek = (sec: number) => usePlayer.getState().seek(sec);
  const commit = (next: Section[]) => useSectionEdits.getState().set(trackId, next);
  const close = () => { if (closing) return; setClosing(true); window.setTimeout(onClose, 240); };

  const barLen = bpm && bpm > 0 ? (4 * 60) / bpm : 0; // seconds per bar
  const showBeats = winSpan < 0.07;                   // beats appear once zoomed in
  /** Snap a fraction to the nearest bar (or beat when zoomed in) so edits land musically. */
  const snapFrac = (f: number) => {
    if (!snap || !barLen) return f;
    const step = showBeats ? barLen / 4 : barLen, fb = firstBeat ?? 0;
    const k = Math.round((f * dur - fb) / step);
    return Math.max(0, Math.min(1, (fb + k * step) / dur));
  };

  // ── editing ops (each writes the override store) ──
  const rename = (i: number, label: string) => commit(secs.map((s, k) => (k === i ? { ...s, label } : s)));
  const recolor = (i: number, tier: 0 | 1 | 2) => { commit(secs.map((s, k) => (k === i ? { ...s, tier } : s))); buzz(6); };
  const moveBoundary = (i: number, f: number) => {
    const lo = secs[i].start + MINLEN, hi = secs[i + 1].end - MINLEN;
    const b = Math.max(lo, Math.min(hi, snapFrac(f)));
    commit(secs.map((s, k) => (k === i ? { ...s, end: b } : k === i + 1 ? { ...s, start: b } : s)));
  };
  const splitHere = () => {
    const at = snapFrac(pct);
    const i = secs.findIndex((s) => at >= s.start && at < s.end);
    if (i < 0 || at - secs[i].start < MINLEN || secs[i].end - at < MINLEN) return;
    const left = { ...secs[i], end: at }, right = { ...secs[i], start: at, label: secs[i].label + " ²" };
    commit([...secs.slice(0, i), left, right, ...secs.slice(i + 1)]); buzz(10);
  };
  /** Export sections + beatgrid as a JSON sidecar — the file half of WAVR Studio integration. */
  const exportSections = async () => {
    const cur = usePlayer.getState().current();
    const doc = {
      format: "helios.sections", version: 1,
      title: cur?.title ?? "", artist: cur?.artist ?? "", path: cur?.path ?? "",
      durationSec: dur, bpm: bpm ?? null, firstBeatSec: firstBeat ?? null,
      sections: secs.map((s) => ({ label: s.label, tier: s.tier, startSec: s.start * dur, endSec: s.end * dur })),
    };
    const name = `${(cur?.title || "track").replace(/[^\w.-]+/g, "_")}.sections.json`;
    try { await saveTextFile(name, JSON.stringify(doc, null, 2), "application/json"); toast.success("Sections exported"); }
    catch { toast.error("Export failed"); }
  };
  const remove = (i: number) => {
    if (secs.length <= 1) return;
    const j = i === 0 ? 1 : i - 1; // merge into a neighbour
    const a = Math.min(secs[i].start, secs[j].start), b = Math.max(secs[i].end, secs[j].end);
    const merged = { ...secs[j], start: a, end: b };
    const out = secs.filter((_, k) => k !== i).map((s, k) => (k === Math.min(i, j) ? merged : s));
    commit(out); setSel(null); buzz(10);
  };

  // ── pinch-to-zoom (single-finger touches pass through to SongSeek / handles) ──
  const dist = (t: React.TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  const onTouchMove = (e: React.TouchEvent) => {
    if (e.touches.length !== 2) return;
    e.preventDefault();
    const d = dist(e.touches);
    if (!pinch.current) { pinch.current = { d, z: zoom }; return; }
    setZoom(Math.max(1, Math.min(24, pinch.current.z * (d / pinch.current.d))));
  };
  const onTouchEnd = (e: React.TouchEvent) => { if (e.touches.length < 2) pinch.current = null; };

  // drag a boundary handle
  const fracFromX = (clientX: number) => {
    const r = stage.current?.getBoundingClientRect(); if (!r) return 0;
    const local = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    return win0 + local * winSpan;
  };
  const onHandleDown = (i: number) => (e: React.PointerEvent) => {
    e.preventDefault(); e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    const move = (ev: PointerEvent) => moveBoundary(i, fracFromX(ev.clientX));
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); buzz(4); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  };

  // ── bar / beat grid ──
  const grid = useMemo(() => {
    const g: { f: number; beat: boolean }[] = [];
    if (!bars || !barLen) return g;
    const step = showBeats ? barLen / 4 : barLen, fb = firstBeat ?? 0;
    for (let t = fb, k = 0; t <= dur && k < 4000; t += step, k++) {
      const f = t / dur;
      if (f >= win0 - 1e-4 && f <= win0 + winSpan + 1e-4) g.push({ f, beat: showBeats && k % 4 !== 0 });
    }
    return g;
  }, [bars, barLen, showBeats, firstBeat, dur, win0, winSpan]);

  const selSec = sel != null ? secs[sel] : null;

  return createPortal(
    <div className={`wp-seced-scrim ${closing ? "wp-seced-closing" : ""}`} onClick={close}>
      <div className="wp-seced" onClick={(e) => e.stopPropagation()}>
        <header className="wp-seced-head">
          <div className="wp-row-text">
            <div className="md-title-m">Sections</div>
            <div className="md-body-s wp-muted">{secs.length} parts{bpm ? ` · ${bpm} BPM` : ""}{override ? " · edited" : ""}{zoom > 1 ? ` · ${zoom.toFixed(1)}×` : ""}</div>
          </div>
          <button className={`wp-seced-toggle ${edit ? "on" : ""}`} onClick={() => { setEdit((e) => !e); setSel(null); }}><Icon name="edit" size={16} /> Edit</button>
          <button className={`wp-seced-toggle ${bars ? "on" : ""}`} onClick={() => setBars((b) => !b)} title="Bar grid"><Icon name="tune" size={16} /></button>
          <button className="md-icon-btn" onClick={close} title="Close"><Icon name="close" size={22} /></button>
        </header>

        <div className="wp-seced-stage" ref={stage} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd} onTouchCancel={onTouchEnd}>
          <div className="wp-seced-bands">
            {secs.map((s, i) => {
              const a = Math.max(win0, s.start), b = Math.min(win0 + winSpan, s.end);
              if (b <= a) return null;
              return <span key={i} className="wp-seced-band" style={{ left: xOf(a), width: `${((b - a) / winSpan) * 100}%`, background: tierColor(s) }} />;
            })}
          </div>
          <SongSeek value={position} max={dur} peaks={peaks} wave={wave} sections={secs} sectionTint
            onChange={seek} height={150} bpm={bpm} firstBeat={firstBeat} zoom={zoom} offset={win0} />
          <div className="wp-seced-grid">
            {grid.map((g, i) => <span key={i} className={`wp-seced-bar ${g.beat ? "beat" : ""}`} style={{ left: xOf(g.f) }} />)}
          </div>
          {/* section FLAGS planted at each section's start — pennant with a › tip, tap to skip/select */}
          {secs.map((s, i) => {
            if (s.start < win0 - 1e-4 || s.start > win0 + winSpan + 1e-4) return null;
            const active = pct >= s.start && pct < s.end;
            return (
              <button key={i} className={`wp-seced-flag ${(edit ? sel === i : active) ? "on" : ""}`}
                style={{ left: xOf(s.start), ["--c" as string]: tierColor(s) }}
                onClick={() => { if (edit) setSel(i); else { seek(s.start * dur); buzz(8); } }}>
                <span className="wp-seced-flag-tag">{s.label || `Part ${i + 1}`}</span>
                <span className="wp-seced-flag-pole" />
              </button>
            );
          })}
          {edit && secs.slice(0, -1).map((s, i) => {
            const f = s.end;
            if (f < win0 || f > win0 + winSpan) return null;
            return <span key={i} className="wp-seced-handle" style={{ left: xOf(f) }} onPointerDown={onHandleDown(i)}><span className="wp-seced-handle-grip" /></span>;
          })}
        </div>

        {edit && selSec ? (
          <div className="wp-seced-editrow">
            <input className="wp-search-input md-body-l wp-seced-name" value={selSec.label}
              placeholder="Section name" onChange={(e) => rename(sel!, e.target.value)} />
            <div className="wp-seced-tiers">
              {TIERS.map((t) => (
                <button key={t.tier} className={`wp-seced-tier ${selSec.tier === t.tier ? "on" : ""}`} style={{ ["--c" as string]: t.color }}
                  onClick={() => recolor(sel!, t.tier)} title={t.label}><span /></button>
              ))}
            </div>
            <button className="md-icon-btn wp-select-del" onClick={() => remove(sel!)} title="Delete (merge)"><Icon name="trash" size={20} /></button>
          </div>
        ) : edit ? (
          <div className="wp-seced-edithint md-body-s wp-muted">Tap a section to rename/recolor · drag the handles to move boundaries{snap && barLen ? ` · snapping to ${showBeats ? "beats" : "bars"}` : ""}</div>
        ) : null}

        <footer className="wp-seced-foot">
          {edit ? (
            <>
              <button className="wp-text-btn md-label-l" onClick={splitHere}><Icon name="add" size={16} /> Split here</button>
              {barLen > 0 && <button className={`wp-seced-toggle ${snap ? "on" : ""}`} onClick={() => setSnap((v) => !v)} title="Snap to grid"><Icon name="bolt" size={15} /> Snap</button>}
              <button className="wp-text-btn md-label-l" onClick={exportSections} title="Export to WAVR Studio"><Icon name="share" size={16} /> Export</button>
              {override && <button className="wp-text-btn md-label-l" onClick={() => { useSectionEdits.getState().clear(trackId); setSel(null); }}>Reset</button>}
            </>
          ) : (
            <span className="md-body-s wp-muted">{fmtTime(position)} / {fmtTime(dur)}</span>
          )}
          <div className="wp-seced-foot-actions">
            {zoom > 1 && <button className="wp-text-btn md-label-l" onClick={() => setZoom(1)}>Reset zoom</button>}
            <button className="wp-fab wp-seced-play" onClick={() => usePlayer.getState().toggle()} title={playing ? "Pause" : "Play"}>
              <Icon name={playing ? "pause" : "play"} size={28} />
            </button>
          </div>
          <span className="md-body-s wp-muted">Pinch to zoom</span>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
