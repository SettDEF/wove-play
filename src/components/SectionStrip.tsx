import { memo, useEffect, useMemo, useRef, useState } from "react";
import { buzz } from "@/lib/touch";
import { tierForRange } from "@/lib/liveSections";
import type { Section } from "@/lib/trackAnalysis";

const TIER_LABEL = ["Break", "Verse", "Drop"] as const; // 0 / 1 / 2 — matches the section colour tiers

/** Subsections of one section, derived cheaply: a phrase grid (4 bars × 4 beats) snapped to the
 *  beatgrid when tempo is known, else an even split. Returns track-fraction ranges. */
function deriveSubs(sec: Section, max: number, bpm?: number, firstBeat?: number): { start: number; end: number }[] {
  const span = sec.end - sec.start;
  if (span <= 0) return [];
  let bounds: number[];
  if (bpm && bpm > 0 && max > 0) {
    const phrase = (16 * 60) / bpm / max;                    // 4 bars × 4 beats, as a track fraction
    const fb = ((firstBeat ?? 0) % ((16 * 60) / bpm)) / max; // beatgrid phase
    bounds = [sec.start];
    let t = sec.start - ((sec.start - fb) % phrase);
    if (t <= sec.start) t += phrase;
    for (; t < sec.end - phrase * 0.35; t += phrase) bounds.push(t);
    bounds.push(sec.end);
  } else {
    const n = 4;
    bounds = Array.from({ length: n + 1 }, (_, i) => sec.start + (span * i) / n);
  }
  // Cap the subsection count low so each stays wide enough to read in the thin strip (too many = a row of
  // unreadable slivers, which is what made the fisheye look messy).
  const MAXSUB = 8;
  if (bounds.length > MAXSUB + 1) {
    const step = (bounds.length - 1) / MAXSUB;
    bounds = Array.from({ length: MAXSUB + 1 }, (_, i) => bounds[Math.round(i * step)]);
  }
  const subs: { start: number; end: number }[] = [];
  for (let i = 0; i < bounds.length - 1; i++) subs.push({ start: bounds[i], end: bounds[i + 1] });
  return subs.length >= 2 ? subs : [];
}

/** A tappable map of the song's structure under the seekbar. A FOCUSED section grows wider than the rest
 *  and reveals clickable subsections you can jump into — a fisheye that shines on long tracks / mixes.
 *  `mode` (Settings → Player): "auto" focus follows the playhead, "hold" expands only the section you
 *  press-and-hold, "off" is a plain strip. Pure DOM, so it costs nothing per frame. */
export const SectionStrip = memo(function SectionStrip({
  sections, value, max, onSeek, animate = true, loading = false, mode = "auto", bpm, firstBeat, trackId = "", win0 = 0, winSpan = 1,
}: {
  sections: Section[]; value: number; max: number; onSeek: (sec: number) => void;
  /** Sections are still the provisional/live map (precise offline pass not in yet) → render a calm,
   *  label-less skeleton so it doesn't look jumpy while analysis is computing. */
  animate?: boolean; loading?: boolean; mode?: "auto" | "hold" | "off"; bpm?: number; firstBeat?: number; trackId?: string;
  /** Visible window of the track (fractions) so the strip ZOOMS in lock-step with the waveform above. */
  win0?: number; winSpan?: number;
}) {
  const [picked, setPicked] = useState<number | null>(null); // a held/tapped section; null = none / follow playhead
  const holdTimer = useRef(0);
  const didHold = useRef(false);
  if (sections.length < 2 || max <= 0) return null;
  const pct = Math.max(0, Math.min(1, value / max));
  const playIdx = sections.findIndex((s, i) => pct >= s.start && (pct < s.end || (i === sections.length - 1 && pct <= s.end)));

  // Which section is enlarged: auto → the one you tapped, else the playhead's; hold → only one you held; off → none.
  const focus = loading ? -1                  // no fisheye while it's still the provisional map — keep it calm
    : mode === "off" ? -1
    : mode === "hold" ? (picked ?? -1)
    : (picked ?? Math.max(0, playIdx));

  // In auto mode, drop a manual pick once the playhead moves on so focus tracks playback again.
  useEffect(() => { if (mode === "auto") setPicked(null); }, [playIdx, mode]);
  // Reset any held expansion when the mode changes.
  useEffect(() => { setPicked(null); }, [mode]);

  // Subsections of the focused section, each LABELLED by what's happening there (Drop / Verse / Break)
  // from the live energy map — falling back to the parent section's tier.
  const subs = useMemo(() => {
    if (focus < 0) return [];
    const parentTier = sections[focus]?.tier ?? 1;
    return deriveSubs(sections[focus] ?? sections[0], max, bpm, firstBeat).map((u) => {
      const tier = tierForRange(trackId, u.start, u.end, max) ?? parentTier;
      return { ...u, tier, label: TIER_LABEL[tier] };
    });
  }, [sections, focus, max, bpm, firstBeat, trackId, value]);
  const sig = sections.map((s) => `${s.tier}@${Math.round(s.start * 200)}`).join("|");

  const clearHold = () => { if (holdTimer.current) { clearTimeout(holdTimer.current); holdTimer.current = 0; } };
  const onDown = (i: number) => {
    if (mode !== "hold") return;
    didHold.current = false;
    clearHold();
    holdTimer.current = window.setTimeout(() => { didHold.current = true; setPicked((p) => (p === i ? null : i)); buzz(12); }, 360);
  };
  const onTap = (i: number, s: Section) => {
    clearHold();
    if (didHold.current) { didHold.current = false; return; } // the press was a hold (expand), not a jump
    if (mode === "auto") setPicked(i);
    onSeek(s.start * max);
  };

  // Visible window (zoom): only segments overlapping [win0, winEnd] show, sized by their VISIBLE fraction,
  // so the strip zooms in lock-step with the waveform above. winSpan=1 → unchanged (whole track).
  const winEnd = win0 + winSpan;
  return (
    <div className={`wp-secstrip ${animate ? "wp-secstrip-anim" : ""} ${loading ? "wp-secstrip-loading" : ""}`} role="group" aria-label="Song sections">
      {sections.map((s, i) => {
        const vs = Math.max(s.start, win0), ve = Math.min(s.end, winEnd);
        if (ve <= vs) return null;                 // section is outside the visible window
        const active = i === playIdx;
        const focused = i === focus;
        return (
          <button
            key={`${sig}-${i}`}
            className={`wp-secseg wp-secseg-t${s.tier} ${active ? "wp-secseg-on" : ""} ${focused ? "wp-secseg-focus" : ""}`}
            style={{ flexGrow: Math.max(0.001, ve - vs) * (focused ? 3.6 : 1), ["--i"]: Math.min(i, 14) } as React.CSSProperties}
            title={mode === "hold" ? `${s.label} · tap to jump · hold for parts` : `${s.label} · jump here`}
            onPointerDown={() => onDown(i)}
            onPointerUp={() => onTap(i, s)}
            onPointerLeave={clearHold}
            onPointerCancel={clearHold}
          >
            {loading ? null : focused && subs.length >= 2 ? (
              <span className="wp-secsubs" aria-label={`${s.label} subsections`}>
                {subs.map((u, j) => {
                  const here = pct >= u.start && pct < u.end;
                  return (
                    <span
                      key={j}
                      role="button"
                      className={`wp-secsub wp-secseg-t${u.tier} ${here ? "wp-secsub-on" : ""}`}
                      style={{ flexGrow: Math.max(0.001, u.end - u.start) }}
                      title={`${u.label} · jump here`}
                      onPointerUp={(e) => { e.stopPropagation(); onSeek(u.start * max); }}
                    >
                      {/* Only the playing subsection shows its label — the rest stay clean ticks, so the
                          focused section reads as one labelled block instead of repeated "Drop Drop Drop". */}
                      {here && <span className="wp-secsub-label">{u.label}</span>}
                    </span>
                  );
                })}
              </span>
            ) : (
              <span className="wp-secseg-label">{s.label}</span>
            )}
          </button>
        );
      })}
    </div>
  );
});
