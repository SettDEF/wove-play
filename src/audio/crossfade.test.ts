/** Unit tests for the pure crossfade planner. Run with:
 *    node_modules/.bin/esbuild src/audio/crossfade.test.ts --bundle --platform=node --format=cjs | node
 *  (no test-runner dependency — esbuild bundles, node runs, throws on failure). */
import { stepXfade, initXfade, XfadeInput, XfadeState } from "./crossfade";

let passed = 0;
const approx = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps;
function ok(cond: boolean, msg: string) {
  if (!cond) { console.error("FAIL:", msg); process.exitCode = 1; throw new Error(msg); }
  passed++;
}

const base = (over: Partial<XfadeInput> = {}): XfadeInput => ({
  dt: 0.1, position: 10, duration: 200, hasNext: true,
  enabled: true, overlapSec: 6, paused: false, skipNow: false, ...over,
});

// 1. Flag OFF → never fades, always full active / silent incoming, even at the very end.
{
  let s = initXfade("A");
  const r = stepXfade(s, base({ enabled: false, position: 199.9, duration: 200 }));
  ok(!r.state.fading && r.action.gainActive === 1 && r.action.gainIncoming === 0, "disabled = single-voice idle");
}

// 2. No trigger when there is no next track, even at the seam.
{
  const r = stepXfade(initXfade("A"), base({ hasNext: false, position: 199, duration: 200 }));
  ok(!r.state.fading && !r.action.startIncoming, "no next → no fade");
}

// 3. No trigger mid-track (remaining > overlap).
{
  const r = stepXfade(initXfade("A"), base({ position: 10, duration: 200, overlapSec: 6 }));
  ok(!r.state.fading && !r.action.startIncoming, "mid-track → no fade");
}

// 4. Trigger fires when remaining <= overlap, requesting the incoming load.
{
  const r = stepXfade(initXfade("A"), base({ position: 195, duration: 200, overlapSec: 6 }));
  ok(r.state.fading && r.action.startIncoming, "near end → fade triggers + loads incoming");
  ok(r.action.activeVoice === "A" && r.action.incomingVoice === "B", "incoming is the idle voice");
}

// 5. skipNow forces an immediate fade mid-track.
{
  const r = stepXfade(initXfade("A"), base({ position: 10, duration: 200, skipNow: true }));
  ok(r.state.fading && r.action.startIncoming, "skipNow → immediate fade");
}

// 6. EQUAL-POWER INVARIANT: across the whole seam, gainActive² + gainIncoming² ≈ 1.
//    This is the pure-form RMS-preservation guarantee (no silence valley).
{
  let s: XfadeState = stepXfade(initXfade("A"), base({ position: 195, duration: 200, overlapSec: 6 })).state;
  let worst = 0, steps = 0;
  for (let k = 0; k < 200; k++) {
    const r = stepXfade(s, base({ dt: 0.05, overlapSec: 6 }));
    s = r.state;
    const power = r.action.gainActive ** 2 + r.action.gainIncoming ** 2;
    worst = Math.max(worst, Math.abs(power - 1));
    steps++;
    if (r.action.complete) break;
  }
  // <=0.02 power ⇒ <~0.09 dB summed-power dip — far inside the manifesto's 1.5 dB budget.
  ok(worst <= 0.02, `equal-power held across seam (worst power error ${worst.toFixed(4)})`);
  ok(steps > 1, "fade spanned multiple steps");
}

// 7. Handoff fires EXACTLY once, at the midpoint, and completion fires once + swaps active voice.
{
  let s: XfadeState = stepXfade(initXfade("A"), base({ position: 197, duration: 200, overlapSec: 4 })).state;
  ok(s.fading, "test 7 fixture triggered a fade");
  let handoffs = 0, completes = 0, finalActive: string | null = null;
  for (let k = 0; k < 500; k++) {
    const r = stepXfade(s, base({ dt: 0.05, overlapSec: 4 }));
    s = r.state;
    if (r.action.handoff) handoffs++;
    if (r.action.complete) { completes++; finalActive = r.state.active; break; }
  }
  ok(handoffs === 1, `handoff fired once (got ${handoffs})`);
  ok(completes === 1, `complete fired once (got ${completes})`);
  ok(finalActive === "B", "active voice swapped A → B after completion");
}

// 8. Pause freezes the fade clock — gains do not advance while paused.
{
  let s: XfadeState = stepXfade(initXfade("A"), base({ position: 195, duration: 200, overlapSec: 6 })).state;
  const a1 = stepXfade(s, base({ dt: 0.1 })); s = a1.state;
  const g1 = a1.action.gainIncoming;
  const a2 = stepXfade(s, base({ dt: 5.0, paused: true })); // big dt but paused
  ok(approx(a2.action.gainIncoming, g1, 1e-6), "paused holds the fade (incoming gain unchanged)");
  ok(a2.state.elapsed === s.elapsed, "paused does not advance elapsed");
}

// 9. After completion the planner is ready to fade the NEW active voice again (no stuck state).
{
  let s = initXfade("A");
  s = stepXfade(s, base({ position: 197, duration: 200, overlapSec: 4 })).state;
  for (let k = 0; k < 500; k++) { const r = stepXfade(s, base({ dt: 0.1, overlapSec: 4 })); s = r.state; if (r.action.complete) break; }
  ok(s.active === "B" && !s.fading, "settled on B, idle");
  const r = stepXfade(s, base({ position: 198, duration: 200, overlapSec: 4 }));
  ok(r.state.fading && r.action.incomingVoice === "A", "B → A fade triggers on the next track");
}

console.log(`crossfade planner: ${passed} assertions passed ✓`);
