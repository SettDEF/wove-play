/** Pure transition planner for the dual-voice ("true crossfade") engine.
 *
 *  NO audio, NO DOM — just the state machine the BEAT_POWERAMP ruling requires
 *  us to unit-test BEFORE wiring two AudioContext voices. The engine/store
 *  EXECUTE the emitted actions; this file only decides *when* a crossfade
 *  starts/hands-off/completes and computes the equal-power gain curve.
 *
 *  Roles: at any instant one physical voice (A or B) is the *active* voice —
 *  it owns the transport UI + position. During a crossfade the *incoming*
 *  voice (the other one) ramps up; at the midpoint the current pointer hands
 *  off to it; when the ramp finishes the old voice is freed and the incoming
 *  voice becomes active.
 *
 *  Equal-power curve (cos/sin): gainActive² + gainIncoming² ≡ 1 across the
 *  whole seam, so summed power — hence RMS — never dips. That is the property
 *  the OfflineAudioContext seam-test asserts once audio is wired. */

export type VoiceId = "A" | "B";

export interface XfadeState {
  active: VoiceId;          // the voice that owns UI/position right now
  fading: boolean;          // a crossfade is in progress
  elapsed: number;          // seconds into the current crossfade
  overlap: number;          // crossfade length captured at trigger time (s)
  handoffDone: boolean;     // current-pointer already moved to the incoming voice
}

export interface XfadeInput {
  dt: number;               // seconds since the previous step (>= 0)
  position: number;         // active voice position (s)
  duration: number;         // active voice duration (s; 0 if unknown)
  hasNext: boolean;         // a next track is available to fade into
  enabled: boolean;         // settings.trueCrossfade
  overlapSec: number;       // crossfade length (s)
  paused: boolean;          // transport paused → freeze the fade clock
  skipNow: boolean;         // user pressed "next" → fade immediately (edge)
}

export interface XfadeAction {
  startIncoming: boolean;   // edge: load the next track on the idle voice + play at gain 0
  handoff: boolean;         // edge: move the current pointer to the incoming voice
  complete: boolean;        // edge: fade finished → stop + free the old voice
  gainActive: number;       // gain for the voice that was active at fade start
  gainIncoming: number;     // gain for the incoming voice
  activeVoice: VoiceId;     // which physical voice gainActive targets
  incomingVoice: VoiceId;   // which physical voice gainIncoming targets
}

export const initXfade = (active: VoiceId = "A"): XfadeState => ({
  active, fading: false, elapsed: 0, overlap: 0, handoffDone: false,
});

const other = (v: VoiceId): VoiceId => (v === "A" ? "B" : "A");
const clamp01 = (t: number) => (t < 0 ? 0 : t > 1 ? 1 : t);
// equal-power crossfade: cos²+sin² ≡ 1 → constant summed power across the seam
const eqOut = (t: number) => Math.cos(clamp01(t) * Math.PI / 2);
const eqIn = (t: number) => Math.sin(clamp01(t) * Math.PI / 2);

/** One step of the planner. Pure: same (state, input) → same (state, action). */
export function stepXfade(s: XfadeState, i: XfadeInput): { state: XfadeState; action: XfadeAction } {
  const incomingVoice = other(s.active);
  const idle = (): XfadeAction => ({
    startIncoming: false, handoff: false, complete: false,
    gainActive: 1, gainIncoming: 0, activeVoice: s.active, incomingVoice,
  });

  // Flag off → single-voice, byte-identical behaviour; abort any stray fade.
  if (!i.enabled) return { state: initXfade(s.active), action: idle() };

  // ── trigger ────────────────────────────────────────────────────────────
  if (!s.fading) {
    const remaining = i.duration > 0 ? i.duration - i.position : Infinity;
    const overlap = Math.max(0.1, i.overlapSec);
    const shouldFade = i.hasNext && (i.skipNow || remaining <= overlap);
    if (!shouldFade) return { state: s, action: idle() };
    return {
      state: { ...s, fading: true, elapsed: 0, overlap, handoffDone: false },
      action: {
        startIncoming: true, handoff: false, complete: false,
        gainActive: 1, gainIncoming: 0, activeVoice: s.active, incomingVoice,
      },
    };
  }

  // ── progressing fade ─────────────────────────────────────────────────────
  const elapsed = s.elapsed + (i.paused ? 0 : Math.max(0, i.dt));
  const t = s.overlap > 0 ? elapsed / s.overlap : 1;
  const handoff = !s.handoffDone && t >= 0.5;       // midpoint hand-off
  const complete = t >= 1;

  if (complete) {
    // incoming voice becomes the new active voice; old voice is freed.
    return {
      state: initXfade(incomingVoice),
      action: {
        startIncoming: false, handoff: !s.handoffDone, complete: true,
        gainActive: 0, gainIncoming: 1, activeVoice: s.active, incomingVoice,
      },
    };
  }

  return {
    state: { ...s, elapsed, handoffDone: s.handoffDone || handoff },
    action: {
      startIncoming: false, handoff, complete: false,
      gainActive: eqOut(t), gainIncoming: eqIn(t),
      activeVoice: s.active, incomingVoice,
    },
  };
}
