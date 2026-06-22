/// Lag-monitor helper worker. Runs on its OWN thread and reports how late its fixed-interval timer fires.
/// The main-thread monitor uses this to classify a stall: if the WORKER's timer stayed on time during a
/// main-thread freeze, the MAIN THREAD was specifically blocked (JS or a sync Tauri command). If the
/// worker's timer was ALSO late, the whole CPU was saturated (background work on other threads — e.g.
/// rayon decode), not a main-thread block. Different stalls → different fixes.
const STEP = 120;
let last = performance.now();
setInterval(() => {
  const now = performance.now();
  const late = Math.max(0, now - last - STEP); // how far past the interval we actually fired
  last = now;
  (postMessage as (m: unknown) => void)({ late });
}, STEP);
