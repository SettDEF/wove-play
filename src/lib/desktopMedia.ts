import { hasTauri, isAndroid } from "./backend";

/** Desktop OS media controls (MPRIS on Linux) — mirrors the Android nativeMedia bridge: drives the Rust
 *  `mpris_update` (metadata + cover) / `mpris_playback` (play-state + position) and listens for the
 *  `mpris-control` transport presses from the system. No-op on Android (its own MediaSession) + browser. */
export const desktopMediaActive = hasTauri && !isAndroid;

type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
let _invoke: InvokeFn | null = null;
let _listen: (<T>(ev: string, cb: (e: { payload: T }) => void) => Promise<unknown>) | null = null;
async function load() {
  if (_invoke) return;
  const core = await import("@tauri-apps/api/core");
  const event = await import("@tauri-apps/api/event");
  _invoke = core.invoke as InvokeFn;
  _listen = event.listen as typeof _listen;
}

let artKey = "";            // last fetched art URL
let artB64: string | null = null;

async function fetchBase64(url: string): Promise<string | null> {
  try {
    if (url.startsWith("data:")) return url.split(",")[1] || null;
    const blob = await (await fetch(url)).blob();
    return await new Promise((res) => {
      const fr = new FileReader();
      fr.onload = () => res(((fr.result as string) || "").split(",")[1] || null);
      fr.onerror = () => res(null);
      fr.readAsDataURL(blob);
    });
  } catch { return null; }
}

/** Track changed → full metadata + cover (re-fetches art only when the URL changed). */
export async function desktopSetMeta(meta: { title: string; artist: string; album: string; durationSec: number; positionSec: number; playing: boolean }, artUrl: string | null): Promise<void> {
  if (!desktopMediaActive) return;
  await load();
  if (artUrl && artUrl !== artKey) { artKey = artUrl; artB64 = await fetchBase64(artUrl); }
  if (!artUrl) { artKey = ""; artB64 = null; }
  try {
    await _invoke!("mpris_update", {
      title: meta.title, artist: meta.artist, album: meta.album,
      durationSec: meta.durationSec, positionSec: meta.positionSec, playing: meta.playing, art: artB64,
    });
  } catch { /* ignore */ }
}

let lastPushed = 0;
/** Play-state / position changed → lightweight update (throttled; no cover re-write). `force` on a real
 *  play/pause flip so it's instant. */
export async function desktopSetPlayback(playing: boolean, positionSec: number, force = false): Promise<void> {
  if (!desktopMediaActive) return;
  const now = Date.now();
  if (!force && now - lastPushed < 900) return; // throttle position ticks → avoid D-Bus spam
  lastPushed = now;
  await load();
  try { await _invoke!("mpris_playback", { playing, positionSec }); } catch { /* ignore */ }
}

export interface DesktopControls {
  play: () => void; pause: () => void; toggle: () => void; next: () => void; prev: () => void;
  stop: () => void; seekTo: (s: number) => void; rewind: () => void; forward: () => void;
}
export async function bindDesktopControls(c: DesktopControls): Promise<void> {
  if (!desktopMediaActive) return;
  await load();
  await _listen!<{ kind: string; pos: number }>("mpris-control", (e) => {
    const { kind, pos } = e.payload;
    const map: Record<string, () => void> = {
      play: c.play, pause: c.pause, toggle: c.toggle, next: c.next, prev: c.prev, stop: c.stop,
      seek: () => c.seekTo(pos), forward: c.forward, rewind: c.rewind,
    };
    map[kind]?.();
  });
}
