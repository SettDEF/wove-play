import { create } from "zustand";

/**
 * SMART, self-tuning brake on heavy background on-device analysis (taste fingerprinting + mix track-ID).
 * Instead of guessing (e.g. "pause on every skip"), it MEASURES UI smoothness and only backs analysis
 * off when it actually detects jank that coincides with analysis running — then resumes the moment the
 * UI is smooth again. So on a fast phone analysis runs full-speed; on a struggling one it yields.
 *
 * Jank signal: `PerformanceObserver('longtask')` (main-thread blocks ≥ 50ms — exactly what a decode /
 * FFT pass causes), with a requestAnimationFrame frame-gap fallback where longtask isn't supported.
 */
interface AnalysisPauseState { paused: boolean }
export const useAnalysisPause = create<AnalysisPauseState>(() => ({ paused: false }));

/** Cheap non-reactive read for the background loops. */
export const analysisPaused = (): boolean => useAnalysisPause.getState().paused;

const now = (): number => (typeof performance !== "undefined" ? performance.now() : Date.now());
let janks: number[] = [];   // timestamps of recent long tasks / dropped frames
let lastActivity = 0;       // when a background analyzer last did real work
let started = false;

/** A background analyzer calls this right before a heavy chunk, so the governor can attribute jank to
 *  analysis (and not, say, a heavy scroll) before deciding to pause. */
export function noteAnalysisActivity(): void { lastActivity = now(); }

/** Start the governor once (idempotent, lightweight). */
export function startAnalysisGovernor(): void {
  if (started || typeof window === "undefined") return;
  started = true;

  let usedPO = false;
  try {
    const PO = (window as unknown as { PerformanceObserver?: new (cb: (l: { getEntries: () => { duration: number }[] }) => void) => { observe: (o: { entryTypes: string[] }) => void } }).PerformanceObserver;
    if (PO) {
      const obs = new PO((list) => { for (const e of list.getEntries()) if (e.duration >= 50) janks.push(now()); });
      obs.observe({ entryTypes: ["longtask"] });
      usedPO = true;
    }
  } catch { /* longtask unsupported (e.g. some WebKit builds) → fall back below */ }

  if (!usedPO && typeof requestAnimationFrame === "function") {
    let last = 0;
    const tick = (t: number) => { if (last && t - last > 60) janks.push(now()); last = t; requestAnimationFrame(tick); }; // >60ms gap ≈ a dropped frame
    requestAnimationFrame(tick);
  }

  window.setInterval(() => {
    const t = now();
    janks = janks.filter((j) => t - j < 1500); // only the last ~1.5s of jank counts
    const paused = useAnalysisPause.getState().paused;
    if (!paused) {
      // Pause only when the UI is sustainedly janky AND analysis actually ran recently (so it's the cause).
      if (janks.length >= 3 && t - lastActivity < 1500) useAnalysisPause.setState({ paused: true });
    } else if (janks.length === 0) {
      // Fully smooth again → let analysis resume.
      useAnalysisPause.setState({ paused: false });
    }
  }, 700);
}
