/**
 * Vinyl-scratch SFX driven by DRAG VELOCITY — used by the seek timeline AND the Vinyl cover.
 *
 * The trick that makes it sound like a real turntable scratch (not white noise): a looped TONAL "groove"
 * buffer whose **playbackRate follows the hand speed**, so dragging fast raises the pitch + tempo (the
 * classic "wikki-wikki") and dragging slowly drops it — exactly how a record reacts to your hand. Loudness
 * and a tracking band-pass follow the speed too; a still / released finger fades to silence.
 *
 * A tiny dedicated WebAudio graph, independent of the playback engine (works on the Web-Audio AND native
 * paths), lazily created on the first drag (a user gesture → autoplay policy satisfied). Frontend-only;
 * toggled by Settings → Playback (scrubScratch).
 */
let enabled = true;
let ctx: AudioContext | null = null;
let gain: GainNode | null = null;
let band: BiquadFilterNode | null = null;
let src: AudioBufferSourceNode | null = null;
let lastX = 0;
let lastT = 0;
let decayTimer: ReturnType<typeof setTimeout> | undefined;

/** Enable/disable the scrub-scratch sound (called from settings). Disabling silences it immediately. */
export function setScratchEnabled(on: boolean): void {
  enabled = on;
  if (!on) stopNow();
}

/** A short, SEAMLESSLY-LOOPING tonal "vinyl groove": a few harmonics (chosen as integer cycles over the
 *  loop length so the wrap never clicks) plus a touch of grit. Pitched by playbackRate while scratching. */
function grooveBuffer(ac: AudioContext): AudioBuffer {
  const dur = 0.3; // 0.3s → 100/150/220Hz are 30/45/66 whole cycles → click-free loop
  const len = Math.floor(ac.sampleRate * dur);
  const buf = ac.createBuffer(1, len, ac.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) {
    const t = i / ac.sampleRate;
    let v = Math.sin(2 * Math.PI * 100 * t) * 0.5
          + Math.sin(2 * Math.PI * 150 * t) * 0.3
          + Math.sin(2 * Math.PI * 220 * t) * 0.18;
    // a little broadband grit windowed to zero at both ends so it doesn't click at the loop seam
    const w = Math.sin(Math.PI * (i / len));
    v += (Math.random() * 2 - 1) * 0.22 * w;
    d[i] = v * 0.5;
  }
  return buf;
}

function ensure(): boolean {
  if (ctx) return true;
  try {
    const AC: typeof AudioContext | undefined =
      window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return false;
    ctx = new AC();
    src = ctx.createBufferSource();
    src.buffer = grooveBuffer(ctx);
    src.loop = true;
    src.playbackRate.value = 1;
    band = ctx.createBiquadFilter();
    band.type = "bandpass";
    band.frequency.value = 700;
    band.Q.value = 0.9;
    gain = ctx.createGain();
    gain.gain.value = 0;
    src.connect(band).connect(gain).connect(ctx.destination);
    src.start();
    return true;
  } catch {
    ctx = null;
    return false;
  }
}

/** Feed a drag sample (clientX + event timestamp); drives the scratch from the resulting velocity. */
export function scratchMove(clientX: number, t: number): void {
  if (!enabled) return;
  if (!ensure() || !ctx || !gain || !band || !src) return;
  if (ctx.state === "suspended") void ctx.resume();
  const dx = clientX - lastX;
  const dt = Math.max(1, t - lastT);
  const speed = lastT === 0 ? 0 : Math.min(4, Math.abs(dx) / dt); // px/ms, clamped; first sample = warm-up
  lastX = clientX;
  lastT = t;
  if (speed < 0.01) return; // not really moving — let it decay
  const now = ctx.currentTime;
  const vol = Math.min(0.4, 0.06 + speed * 0.14);          // faster = louder
  const rate = 0.45 + speed * 0.95;                         // faster = higher PITCH + tempo (the scratch "speed")
  const bright = 400 + speed * 1500;                        // faster = brighter
  gain.gain.cancelScheduledValues(now);
  gain.gain.setTargetAtTime(vol, now, 0.01);
  src.playbackRate.cancelScheduledValues(now);
  src.playbackRate.setTargetAtTime(rate, now, 0.012);       // the pitch bend that makes it read as a scratch
  band.frequency.setTargetAtTime(bright, now, 0.02);
  // If samples stop arriving (finger paused mid-drag) auto-fade so a held-still finger is silent.
  if (decayTimer) clearTimeout(decayTimer);
  decayTimer = setTimeout(fade, 70);
}

function fade(): void {
  if (!ctx || !gain) return;
  const now = ctx.currentTime;
  gain.gain.cancelScheduledValues(now);
  gain.gain.setTargetAtTime(0, now, 0.05);
}

/** Drag ended → fade the scratch out. Safe to call even if it never started. */
export function scratchEnd(): void {
  if (decayTimer) { clearTimeout(decayTimer); decayTimer = undefined; }
  lastX = 0;
  lastT = 0;
  fade();
}

function stopNow(): void {
  if (decayTimer) { clearTimeout(decayTimer); decayTimer = undefined; }
  if (gain && ctx) { gain.gain.cancelScheduledValues(ctx.currentTime); gain.gain.value = 0; }
}
