import { useCallback, useEffect, useRef, useState } from "react";

/**
 * In-app back navigation for Android (and desktop Esc / browser back).
 *
 * Tauri's Android activity only navigates back when `webView.canGoBack()` — i.e. when the page has
 * History API entries. Our SPA never pushed any, so the hardware/gesture back button exited the app
 * instantly. This keeps a stack of "back handlers": opening any overlay/screen pushes a history
 * entry; a back press (popstate) pops the top handler and runs it (closing that overlay) instead of
 * leaving the app. Closing via an in-app control unwinds the matching history entry.
 *
 * ── How to wire the back button (pick ONE; never two for the same overlay) ──────────────────────
 *  • An OVERLAY COMPONENT (sheet/dialog/menu that is mounted only while open) OWNS its back-guard:
 *    call `useBackGuard(true, onClose)` at the top of the component (this is what `Sheet` does). The
 *    parent then just conditionally renders it — it must NOT add its own guard (that double-guards).
 *  • A LOCAL overlay that's just inline JSX + a piece of state in the parent (a "see all" page, a
 *    sub-tab, a picker) uses `useOverlay()` / `useOverlayValue()` below, or a bare
 *    `useBackGuard(isOpen, close)` — the parent owns it because there's no child component to.
 *  • A SCREEN/tab guard (e.g. "back from a non-home tab → home") is a parent `useBackGuard` too.
 *  Nesting "just works": guards form a LIFO stack by mount order, so the most-recently-opened thing
 *  (a popup over a screen) is always closed first.
 *
 *  ⚠️ MULTI-LEVEL screens (a sub-page that drills further, e.g. list → item → detail) need ONE guard
 *  PER LEVEL, not a single guard with `if (deep) …else if (mid) …else close()`. A single guard only
 *  registers ONE history entry, so after the first back the deeper levels fall through to the PARENT
 *  guards and the app jumps out entirely. Use `useBackGuard(levelActive, closeThatLevel)` per level.
 */
type Handler = () => void;
const stack: Handler[] = [];
let suppress = 0; // COUNTER, not a boolean: closing nested overlays fires several programmatic
                  // history.back()s whose popstates can overlap a real back press; a boolean would
                  // let a real back get swallowed (→ the app exits unexpectedly from a guarded tab).
let installed = false;

function install() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("popstate", () => {
    if (suppress > 0) { suppress--; return; }         // one of our own history.back()s — ignore
    const h = stack.pop();
    if (h) h();                                       // back consumed by the top overlay
    // if the stack was empty we let the navigation through (next back exits the app)
  });
  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || stack.length === 0) return;
    const t = e.target as HTMLElement | null;
    if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return; // let Esc clear fields first
    e.preventDefault();
    stack[stack.length - 1]();                        // mimic back; the handler's cleanup unwinds history
  });
}

function pushHandler(h: Handler) {
  install();
  stack.push(h);
  try { history.pushState({ wpBack: stack.length }, ""); } catch { /* ignore */ }
}
function removeHandler(h: Handler) {
  const i = stack.lastIndexOf(h);
  if (i === -1) return;          // already popped by a real back press → nothing to unwind
  stack.splice(i, 1);
  suppress++;
  try { history.back(); } catch { suppress--; }
}

/** Is there anything to go back to (a guarded overlay/screen on the stack)? */
export function hasBack(): boolean { return stack.length > 0; }
/** Run the top back handler — same effect as the Android back button / Esc (its cleanup unwinds
 *  history). Used by the live edge-swipe-back gesture. */
export function goBack(): void { if (stack.length) stack[stack.length - 1](); }

/** While `active`, route the Android back button / Esc / browser-back to `onBack` (e.g. close me). */
export function useBackGuard(active: boolean, onBack: () => void) {
  const ref = useRef(onBack);
  ref.current = onBack;
  useEffect(() => {
    if (!active) return;
    const h: Handler = () => ref.current();
    pushHandler(h);
    return () => removeHandler(h);
  }, [active]);
}

export interface Overlay {
  open: boolean;
  show: () => void;
  close: () => void;
  toggle: () => void;
}
/**
 * A boolean overlay (local sheet/menu/page) that is ALWAYS back-closable: opening it registers a
 * back-guard automatically, so a popup can never ship without one. Replaces the
 * `const [x,setX]=useState(false); useBackGuard(x,()=>setX(false))` boilerplate with `const x=useOverlay()`.
 * (Don't use this for an overlay whose child component already self-guards — that would double-guard.)
 */
export function useOverlay(initial = false): Overlay {
  const [open, setOpen] = useState(initial);
  const show = useCallback(() => setOpen(true), []);
  const close = useCallback(() => setOpen(false), []);
  const toggle = useCallback(() => setOpen((v) => !v), []);
  useBackGuard(open, close);
  return { open, show, close, toggle };
}

/**
 * Like `useOverlay`, but the overlay carries the value it's showing (a track, a "see all" list…).
 * `value !== null` ⇒ open; the back button resets it to null. Same API shape as `useState`.
 */
export function useOverlayValue<T>(initial: T | null = null): [T | null, (v: T | null) => void] {
  const [value, setValue] = useState<T | null>(initial);
  useBackGuard(value !== null, () => setValue(null));
  return [value, setValue];
}
