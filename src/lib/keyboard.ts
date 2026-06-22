import { usePlayer, type Tab } from "@/store/player";
import { useSettings } from "@/store/settings";
import { engine } from "@/audio/engine";

/**
 * Desktop keyboard shortcuts + vim-style navigation. Installed once from App; ignores keystrokes while
 * typing in an input/textarea/contenteditable. No-op without a physical keyboard (Android).
 *
 *  Space            play / pause
 *  ← / h            seek −5s          → / l   seek +5s
 *  Shift+← / Shift+→ (or [ / ])       previous / next track
 *  ↑ / k            volume +          ↓ / j   volume −
 *  m  mute    s  shuffle    r  repeat    /  search
 *  1..5             tabs: Library · Home · Player · EQ · Search
 *  g g  scroll to top    G  scroll to bottom (of the active list)
 *  ?  show this list (toast)
 */

const TABS: Tab[] = ["library", "home", "playing", "eq", "search"];

function typing(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
}

/** The scrollable list the user is looking at (active screen's virtual list / content), for gg / G. */
function activeScroller(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".wp-screen:not([hidden]) .wp-vlist, .wp-screen:not([hidden]) .wp-scroll")
    ?? document.querySelector<HTMLElement>(".wp-vlist, .wp-scroll");
}

let lastG = 0;

function handler(e: KeyboardEvent) {
  if (typing(e.target) || e.altKey) return;
  const p = usePlayer.getState();

  // Ctrl/⌘ + 1..5 → tabs (also plain 1..5 below); leave other modified combos to the OS/app.
  if (e.ctrlKey || e.metaKey) {
    if (e.key >= "1" && e.key <= "5") { p.setTab(TABS[+e.key - 1]); e.preventDefault(); return; }
    // Ctrl/⌘ +/−/0 → zoom the whole UI (great for HiDPI desktops where it renders too big)
    const s = useSettings.getState();
    if (e.key === "-" || e.key === "_") { s.setUiZoom(s.uiZoom - 0.1); e.preventDefault(); return; }
    if (e.key === "=" || e.key === "+") { s.setUiZoom(s.uiZoom + 0.1); e.preventDefault(); return; }
    if (e.key === "0") { s.setUiZoom(1); e.preventDefault(); return; }
    return;
  }

  const vol = (d: number) => p.setVolume(Math.max(0, Math.min(1, p.volume + d)));
  const seek = (d: number) => p.seek(Math.max(0, engine.currentTime + d));

  // Shift+←/→ = previous/next track (handled before plain-arrow seek so they don't both fire).
  if (e.shiftKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
    if (e.key === "ArrowLeft") void p.prev(); else void p.next();
    e.preventDefault(); return;
  }

  switch (e.key) {
    case " ": p.toggle(); break;
    case "ArrowRight": case "l": seek(5); break;
    case "ArrowLeft": case "h": seek(-5); break;
    case "ArrowUp": case "k": vol(0.05); break;
    case "ArrowDown": case "j": vol(-0.05); break;
    case "[": void p.prev(); break;
    case "]": void p.next(); break;
    case "m": { const v = p.volume > 0 ? 0 : (prevVol || 1); if (p.volume > 0) prevVol = p.volume; p.setVolume(v); break; }
    case "s": p.toggleShuffle(); break;
    case "r": p.cycleRepeat(); break;
    case "/": p.setTab("search"); setTimeout(() => document.querySelector<HTMLInputElement>(".wp-search input, input[type=search]")?.focus(), 60); break;
    case "1": case "2": case "3": case "4": case "5": p.setTab(TABS[+e.key - 1]); break;
    case "G": { const s = activeScroller(); if (s) s.scrollTo({ top: s.scrollHeight }); break; }
    case "g": {
      const now = e.timeStamp;
      if (now - lastG < 500) { const s = activeScroller(); if (s) s.scrollTo({ top: 0 }); lastG = 0; } // gg → top
      else lastG = now;
      return; // don't preventDefault on a lone g
    }
    case "?": import("@/store/toasts").then((m) => m.toast.info("Space play · ←/→ seek · [ ] track · ↑/↓ vol · m s r · / search · 1-5 tabs · gg/G top/bottom")); break;
    default: return; // unhandled → let it through
  }
  e.preventDefault();
}

let prevVol = 1;       // remembered volume for mute toggle
let installed = false;
/** Attach the global shortcuts (idempotent). Returns a remover. */
export function installKeyboard(): () => void {
  if (installed) return () => { /* already installed */ };
  installed = true;
  window.addEventListener("keydown", handler);
  return () => { window.removeEventListener("keydown", handler); installed = false; };
}
