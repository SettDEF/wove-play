/**
 * Lag monitor — a dev/diagnostic tool to CATCH large main-thread stalls so we can fix them.
 *
 * Two detectors, both opt-in (Settings → Performance → Lag monitor):
 *  1. A requestAnimationFrame watchdog — a long task blocks rAF, so the gap between callbacks IS the stall
 *     duration. Works everywhere (incl. webkit2gtk, which lacks the longtask API).
 *  2. PerformanceObserver('longtask') where supported (Chromium/WebView2) — adds precise attribution.
 *
 * Every stall over THRESHOLD is logged to the console with the current tab + an optional context note
 * (set via markLag right before a suspected-heavy action), pushed into a ring buffer (window.__lag), and
 * broadcast to the on-screen HUD. So when something janks you SEE the ms + where it happened.
 */

export interface LagSpike { ms: number; at: number; tab: string; note: string; src: "frame" | "longtask" | "timed"; }

const THRESHOLD = 80; // ms — a stall above this counts as a "large lag" worth recording
const MAX = 60;       // ring-buffer size

const spikes: LagSpike[] = [];
const subs = new Set<() => void>();
let running = false;
let raf = 0;
let last = 0;
let frameMsEMA = 16.7;
let ctxNote = "";
let ctxAt = 0;
let po: PerformanceObserver | null = null;

function emit() { subs.forEach((f) => { try { f(); } catch { /* ignore */ } }); }

let startedAt = 0;
// Tauri invoke handle (cached) so each stall can be ALSO printed to the dev TERMINAL — webview console.*
// doesn't reach it. Preloaded in startLagMonitor so the first stalls aren't dropped.
let invokeFn: ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null = null;
// Off-thread watchdog: reports how late ITS OWN timer fired → distinguishes main-thread block from
// system-wide CPU starvation (see lagWorker.ts). `workerMaxLate` = worst lateness seen since last reset.
let worker: Worker | null = null;
let workerMaxLate = 0;
function termLog(line: string) {
  if (!invokeFn) return;
  try { void invokeFn("debug_log", { line }).catch(() => { /* ignore */ }); } catch { /* ignore */ }
}

/** One precise, copy-pasteable line: time since monitor start · duration · tab · operation · source. */
function fmt(sp: LagSpike): string {
  const t = startedAt ? ((sp.at - startedAt) / 1000).toFixed(1) : "0.0";
  const what = sp.note || (sp.src === "frame" ? "(unattributed main-thread stall)" : sp.src);
  return `[lag +${t}s] ${sp.ms}ms · ${sp.tab} · ${what} [${sp.src}]`;
}

function push(sp: LagSpike) {
  spikes.push(sp);
  if (spikes.length > MAX) spikes.shift();
  const line = fmt(sp);
  // eslint-disable-next-line no-console
  console.warn(line);
  termLog(line); // → the dev terminal (Rust eprintln via debug_log)
  emit();
}

/** Print the whole recent stall log to the terminal (handy for "send me everything"). window.__lagDump() */
export function dumpLag() {
  termLog(`[lag] ──── ${spikes.length} recent stalls (worst ${lagState().worst}ms) ────`);
  for (const sp of spikes) termLog(fmt(sp));
}

/** Tag the NEXT stall with a context note (call right before a suspected-heavy action). Auto-expires. */
export function markLag(note: string) { ctxNote = note; ctxAt = performance.now(); }

/** Profile a named operation: records a spike (with the NAME + exact duration) when it runs over
 *  THRESHOLD — so the HUD/console say e.g. "waveform-decode 10300ms" instead of just the tab. Zero cost
 *  when the monitor is off. Use it to wrap suspected-heavy work (decodes, sorts, grouping). */
export async function timed<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
  if (!running) return await fn();
  const t0 = performance.now();
  try { return await fn(); }
  finally {
    const dt = performance.now() - t0;
    if (dt > THRESHOLD) push({ ms: Math.round(dt), at: performance.now(), tab: document.documentElement.dataset.tab || "?", note: name, src: "timed" });
  }
}
/** Synchronous variant of {@link timed} for blocking work (sorts, grouping, layout). */
export function timedSync<T>(name: string, fn: () => T): T {
  if (!running) return fn();
  const t0 = performance.now();
  try { return fn(); }
  finally {
    const dt = performance.now() - t0;
    if (dt > THRESHOLD) push({ ms: Math.round(dt), at: performance.now(), tab: document.documentElement.dataset.tab || "?", note: name, src: "timed" });
  }
}
function takeNote(): string {
  if (ctxNote && performance.now() - ctxAt < 1500) { const n = ctxNote; ctxNote = ""; return n; }
  return "";
}

export function getLagLog(): LagSpike[] { return spikes.slice(); }
export function clearLagLog() { spikes.length = 0; emit(); }
export function onLag(cb: () => void): () => void { subs.add(cb); return () => subs.delete(cb); }
export function lagState() {
  return {
    fps: Math.max(1, Math.round(1000 / frameMsEMA)),
    frameMs: frameMsEMA,
    count: spikes.length,
    worst: spikes.reduce((m, s) => Math.max(m, s.ms), 0),
    last: spikes[spikes.length - 1] as LagSpike | undefined,
  };
}

function tick(now: number) {
  if (!running) { raf = 0; return; }
  if (last) {
    const gap = now - last;
    frameMsEMA = frameMsEMA * 0.9 + gap * 0.1;
    if (gap > THRESHOLD && !document.hidden) {
      const note = takeNote();
      const tab = document.documentElement.dataset.tab || "?";
      const ms = Math.round(gap), at = now;
      if (note) {
        push({ ms, at, tab, note, src: "frame" });
      } else {
        // Unattributed: was the MAIN thread blocked (JS / a sync Tauri command), or was the whole CPU
        // saturated (heavy work on OTHER threads)? The worker runs on its own thread — reset its lateness,
        // let its during-gap reports drain, then classify: if the worker's timer ALSO went late → CPU
        // starvation; if it stayed on time → the main thread itself was blocked.
        workerMaxLate = 0;
        window.setTimeout(() => {
          const starved = workerMaxLate > Math.min(ms * 0.4, 800);
          push({ ms, at, tab, note: starved ? "CPU-starvation (work on other threads)" : "main-thread blocked (JS / sync command)", src: "frame" });
        }, 320);
      }
    }
  }
  last = now;
  raf = requestAnimationFrame(tick);
}

export function startLagMonitor() {
  if (running) return;
  running = true; last = 0; startedAt = performance.now();
  raf = requestAnimationFrame(tick);
  // Preload the Tauri invoke handle so stalls can be mirrored to the dev terminal (no-op in a browser).
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window && !invokeFn) {
    import("@tauri-apps/api/core").then((c) => { invokeFn = c.invoke as typeof invokeFn; }).catch(() => { /* ignore */ });
  }
  try {
    po = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (e.duration > THRESHOLD) {
          push({ ms: Math.round(e.duration), at: e.startTime, tab: document.documentElement.dataset.tab || "?", note: takeNote() || "longtask", src: "longtask" });
        }
      }
    });
    po.observe({ entryTypes: ["longtask"] });
  } catch { /* longtask unsupported (webkit2gtk) → the rAF watchdog still catches stalls */ }
  if (typeof Worker !== "undefined" && !worker) {
    try {
      worker = new Worker(new URL("./lagWorker.ts", import.meta.url), { type: "module" });
      worker.onmessage = (e: MessageEvent<{ late: number }>) => { const l = e.data?.late || 0; if (l > workerMaxLate) workerMaxLate = l; };
    } catch { worker = null; }
  }
  if (typeof window !== "undefined") {
    const w = window as unknown as { __lag: () => LagSpike[]; __lagDump: () => void };
    w.__lag = getLagLog; w.__lagDump = dumpLag;
  }
}

export function stopLagMonitor() {
  running = false;
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
  try { po?.disconnect(); } catch { /* ignore */ }
  po = null;
  try { worker?.terminate(); } catch { /* ignore */ }
  worker = null;
}
