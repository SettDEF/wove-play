/**
 * Runtime performance governor — the brain behind "Dynamic" mode and "Battery saver".
 *
 * It watches the REAL frame rate (and battery state) and, when things get heavy, drops an "eco" flag
 * that the visualizer and the stylesheet react to — WITHOUT ever mutating the user's saved settings.
 * So Dynamic mode can quietly trim visuals on a struggling device and restore them when it recovers,
 * and Battery saver can go light the moment you unplug, all reversibly.
 *
 * Everything here is best-effort and degrades to a no-op where the platform doesn't support it
 * (e.g. the Battery Status API is missing on desktop webviews → treated as "plugged in").
 */

let running = false;
let raf = 0;
let eco = false;
let dynamicOn = false;
let batteryOn = false;
let battDischarging = false;

// rolling 1s FPS sampler (Dynamic mode)
let frames = 0, acc = 0, lastT = 0, lowStreak = 0, highStreak = 0;

function setEco(v: boolean) {
  if (v === eco) return;
  eco = v;
  if (typeof document !== "undefined") document.documentElement.dataset.perf = v ? "eco" : "normal";
}

/** The fps the visualizer should cap to right now, or null for "no eco override". */
export function perfEcoFpsCap(): number | null { return eco ? 30 : null; }
/** Whether the governor currently wants low-power visuals (used by the visualizer's resolution cap). */
export function perfEco(): boolean { return eco; }

function tick(now: number) {
  if (!running) { raf = 0; return; }
  if (lastT) { acc += now - lastT; frames++; }
  lastT = now;
  if (acc >= 1000) {
    const fps = (frames * 1000) / acc;
    acc = 0; frames = 0;
    if (dynamicOn) {
      // Step INTO eco after ~2s of sustained jank; step back OUT after ~4s of sustained smoothness
      // (asymmetric so we don't flap, and only recover when the battery isn't forcing eco).
      if (fps < 45) { lowStreak++; highStreak = 0; }
      else if (fps > 55) { highStreak++; lowStreak = 0; }
      else { lowStreak = 0; highStreak = 0; }
      if (lowStreak >= 2) setEco(true);
      else if (highStreak >= 4 && !(batteryOn && battDischarging)) setEco(false);
    }
  }
  // Battery saver wins: unplugged → eco regardless of fps (but never un-eco while dynamic wants it).
  if (batteryOn) setEco(battDischarging || (dynamicOn && (lowStreak >= 2)));
  raf = requestAnimationFrame(tick);
}

let batteryWired = false;
function wireBattery() {
  if (batteryWired) return;
  batteryWired = true;
  const nav = navigator as Navigator & {
    getBattery?: () => Promise<{ charging: boolean; addEventListener: (e: string, f: () => void) => void }>;
  };
  nav.getBattery?.().then((b) => {
    const upd = () => { battDischarging = !b.charging; };
    upd();
    b.addEventListener("chargingchange", upd);
  }).catch(() => { battDischarging = false; });
}

/**
 * Turn the governor on/off to match the current settings (called from settings.applyPerf).
 * Runs only while Dynamic mode or Battery saver is active; otherwise it clears eco and idles.
 */
export function syncPerfRuntime(dynamic: boolean, batterySaver: boolean) {
  dynamicOn = dynamic;
  batteryOn = batterySaver;
  if (batterySaver) wireBattery();
  const want = (dynamic || batterySaver) && typeof requestAnimationFrame !== "undefined";
  if (want && !running) {
    running = true;
    lastT = 0; acc = 0; frames = 0; lowStreak = 0; highStreak = 0;
    raf = requestAnimationFrame(tick);
  } else if (!want && running) {
    running = false;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    setEco(false);
  } else if (!want) {
    setEco(false);
  }
}
