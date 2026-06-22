import { useEffect, useReducer } from "react";
import { onLag, lagState, clearLagLog } from "@/lib/lagMonitor";

/** Tiny always-on-top readout of frame time + recent main-thread stalls (Settings → Performance → Lag
 *  monitor). Pointer-events: none so it never blocks the UI; tap the ✕ region is disabled — clear via the
 *  Settings toggle. When a big stall lands it flashes red so you can catch WHEN it happened. */
export function LagHud() {
  const [, force] = useReducer((x) => x + 1, 0);
  useEffect(() => {
    const off = onLag(force);
    const iv = window.setInterval(force, 500); // keep the live fps fresh between spikes
    return () => { off(); clearInterval(iv); };
  }, []);
  const s = lagState();
  const recent = s.last && performance.now() - s.last.at < 1200;
  return (
    <div className={`wp-laghud ${recent ? "wp-laghud-hit" : ""}`} aria-hidden>
      <div className="wp-laghud-row"><b>{s.fps}</b> fps · {Math.round(s.frameMs)}ms</div>
      <div className="wp-laghud-row">stalls: {s.count} · worst {s.worst}ms</div>
      {s.last && <div className="wp-laghud-last">↳ {s.last.ms}ms · {s.last.tab}{s.last.note ? ` · ${s.last.note}` : ""}</div>}
      <button className="wp-laghud-clear" onClick={() => clearLagLog()} title="Clear">clear</button>
    </div>
  );
}
