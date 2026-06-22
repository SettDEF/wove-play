import { hasTauri, isAndroid } from "./backend";

/** Native Android media session is only meaningful inside the Android Tauri webview. */
export const nativeMediaActive = hasTauri && isAndroid;

type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
let _invoke: InvokeFn | null = null;
let _addPluginListener: (<T>(plugin: string, event: string, cb: (p: T) => void) => Promise<unknown>) | null = null;

async function core() {
  if (!_invoke) {
    const c = await import("@tauri-apps/api/core");
    _invoke = c.invoke as InvokeFn;
    _addPluginListener = c.addPluginListener as typeof _addPluginListener;
  }
}

interface ControlHandlers {
  play: () => void;
  pause: () => void;
  next: () => void;
  prev: () => void;
  stop: () => void;
  seekTo: (sec: number) => void;
  rewind: () => void;   // notification "Rewind" button → seek back
  forward: () => void;  // notification "Forward" button → seek ahead
  like: () => void;     // notification "Like" button → toggle the track's loved state
  playMediaId: (id: string) => void; // Android Auto browse item picked (id = "track:<id>" etc.)
}

interface Snap {
  title: string; artist: string; album: string;
  durationSec: number; positionSec: number; playing: boolean;
  art: string | null;   // base64, no data: prefix
}
const snap: Snap = { title: "", artist: "", album: "", durationSec: 0, positionSec: 0, playing: false, art: null };
let started = false;
let lastArtKey = "";
// User-configurable notification transport buttons (first 3 = compact view) + the current track's
// loved state (for the heart button's filled/outline icon). Pushed to the native side on each flush.
let actions: string[] = ["prev", "playpause", "next"];
let liked = false;
// What the notification renders under the title (artist / album / both / nothing).
let notifText = "artist-album";
// Which white status-bar icon the notification uses (note/play/wave/eq/bolt/pulse).
let notifIcon = "note";
// "media" = rich MediaStyle notification; "plain" = a normal notification (older-device friendly).
let notifStyle = "media";

async function flush(artChanged: boolean): Promise<void> {
  if (!nativeMediaActive) return;
  await core();
  try {
    await _invoke!("media_update", {
      title: snap.title, artist: snap.artist, album: snap.album,
      durationSec: snap.durationSec, positionSec: snap.positionSec,
      playing: snap.playing, art: artChanged ? snap.art : null, artChanged,
      actions, liked, notifText, notifIcon, notifStyle,
    });
    started = true;
  } catch { /* native side unavailable — ignore */ }
}

/** Fetch any artwork URL (data:, blob:, asset) → raw base64 for the notification's large icon. */
async function toBase64(url: string | null): Promise<string | null> {
  if (!url) return null;
  try {
    const res = await fetch(url);
    const blob = await res.blob();
    return await new Promise<string | null>((resolve) => {
      const r = new FileReader();
      r.onloadend = () => {
        const s = typeof r.result === "string" ? r.result : "";
        const i = s.indexOf(",");
        resolve(i >= 0 ? s.slice(i + 1) : null);
      };
      r.onerror = () => resolve(null);
      r.readAsDataURL(blob);
    });
  } catch { return null; }
}

/** Subscribe to native transport controls (notification / lock screen / headset / media keys). */
export async function bindNativeControls(h: ControlHandlers): Promise<void> {
  if (!nativeMediaActive) return;
  await core();
  try {
    await _addPluginListener!<{ action: string; seek: number; value?: string }>("wavrmedia", "control", ({ action, seek, value }) => {
      console.log("[WoveMedia] control received:", action); // DIAG: did the notification button reach JS?
      switch (action) {
        case "play": h.play(); break;
        case "pause": h.pause(); break;
        case "next": h.next(); break;
        case "prev": h.prev(); break;
        case "stop": h.stop(); break;
        case "seek": if (typeof seek === "number" && seek >= 0) h.seekTo(seek); break;
        case "rewind": h.rewind(); break;
        case "forward": h.forward(); break;
        case "like": h.like(); break;
        case "playMediaId": if (value) h.playMediaId(value); break;
      }
    });
  } catch { /* listener unsupported — ignore */ }
}

/** Track metadata changed → update the session + notification (artwork re-fetched). */
export async function nativeSetMeta(meta: { title: string; artist: string; album: string }, artUrl: string | null): Promise<void> {
  if (!nativeMediaActive) return;
  snap.title = meta.title || ""; snap.artist = meta.artist || ""; snap.album = meta.album || "";
  const key = `${meta.title}|${artUrl ?? ""}`;
  if (key !== lastArtKey) {
    lastArtKey = key;
    snap.art = await toBase64(artUrl);
    await flush(true);
  } else {
    await flush(false);
  }
}

/** Playback state / position changed. We push ONLY on a real change — play/pause, a seek jump, or
 *  the first frame. Steady-playback position ticks are dropped entirely: Android extrapolates the
 *  lock-screen / notification scrubber from the last PlaybackState's position + timestamp + speed, so
 *  re-pushing every couple of seconds just wakes the bridge + rebuilds the notification for nothing.
 *  Killing that periodic churn is the main background-playback CPU/battery win. */
export function nativeSetPlayback(playing: boolean, positionSec: number, durationSec: number): void {
  if (!nativeMediaActive) return;
  const stateChanged = playing !== snap.playing;
  const seekJump = Math.abs(positionSec - snap.positionSec) > 1.6;
  snap.playing = playing;
  snap.positionSec = positionSec;
  if (durationSec > 0) snap.durationSec = durationSec;
  if (!started || stateChanged || seekJump) {
    void flush(false);
  }
}

/**
 * Poweramp-style lock-screen access: ask the Activity to show over the keyguard so the user can see
 * & control the app without unlocking. Persisted natively + re-applied on every launch. No-op off Android.
 */
export async function nativeSetLockscreen(enabled: boolean): Promise<void> {
  if (!nativeMediaActive) return;
  await core();
  try { await _invoke!("set_show_when_locked", { enabled }); } catch { /* plugin missing until rebuild */ }
}

/** Push the audio-focus behaviour preference to the native side (how to react on focus loss). */
export async function nativeSetAudioFocus(mode: "duck" | "pause" | "ignore"): Promise<void> {
  if (!nativeMediaActive) return;
  await core();
  try { await _invoke!("media_set_audio_focus", { mode }); } catch { /* plugin missing until rebuild */ }
}

/** A system audio-focus change: an incoming call, another media app, or a navigation prompt. */
export interface FocusEvent { state: "loss" | "transient" | "duck" | "gain" }
/** Subscribe to audio-focus changes so the app can duck / pause / resume in the JS layer. */
export async function bindAudioFocus(cb: (e: FocusEvent) => void): Promise<void> {
  if (!nativeMediaActive) return;
  await core();
  try { await _addPluginListener!<FocusEvent>("wavrmedia", "audiofocus", cb); } catch { /* unsupported — ignore */ }
}

/** A Bluetooth connect/disconnect event (used for car/headset EQ auto-swap). */
export interface BtEvent { address: string; name: string; connected: boolean }
/** Subscribe to Bluetooth device connect/disconnect events. */
export async function bindBluetooth(cb: (e: BtEvent) => void): Promise<void> {
  if (!nativeMediaActive) return;
  await core();
  try { await _addPluginListener!<BtEvent>("wavrmedia", "bluetooth", cb); } catch { /* unsupported — ignore */ }
}
/** Is BLUETOOTH_CONNECT granted (needed to read device name/MAC on Android 12+)? */
export async function nativeBtHasPermission(): Promise<boolean> {
  if (!nativeMediaActive) return false;
  await core();
  try { return await _invoke!<boolean>("media_bt_has_permission"); } catch { return false; }
}
/** Pop the BLUETOOTH_CONNECT permission dialog. */
export async function nativeBtRequestPermission(): Promise<void> {
  if (!nativeMediaActive) return;
  await core();
  try { await _invoke!("media_bt_request_permission"); } catch { /* plugin missing until rebuild */ }
}

/** A node in the Android Auto browse catalog. `playable` items start playback when picked; the rest
 *  are browsable folders whose `id` is requested as a parent to load its children. */
export interface BrowseNode { id: string; title: string; subtitle?: string; playable?: boolean }
/** Push the Android Auto browse catalog: a flat `{ parentId: BrowseNode[] }` map ("__root__" = top). */
export async function nativeSetBrowseTree(tree: Record<string, BrowseNode[]>): Promise<void> {
  if (!nativeMediaActive) return;
  await core();
  try { await _invoke!("media_set_browse_tree", { tree: JSON.stringify(tree) }); } catch { /* plugin missing until rebuild */ }
}

/** Set the configurable notification transport buttons (ordered; first 3 = compact view). */
export function nativeSetActions(buttons: string[]): void {
  if (!nativeMediaActive) return;
  actions = buttons.length ? buttons.slice(0, 5) : ["prev", "playpause", "next"];
  if (started) void flush(false);
}

/** Set what the notification renders under the track title (artist / album / both / nothing). */
export function nativeSetNotifText(v: string): void {
  if (!nativeMediaActive) return;
  notifText = v || "artist-album";
  if (started) void flush(false);
}

/** Set the white status-bar icon the media notification uses (note/play/wave/eq/bolt/pulse). */
export function nativeSetNotifIcon(v: string): void {
  if (!nativeMediaActive) return;
  notifIcon = v || "note";
  if (started) void flush(false);
}

/** Choose the notification style: "media" (rich MediaStyle) or "plain" (a normal notification). */
export function nativeSetNotifStyle(v: string): void {
  if (!nativeMediaActive) return;
  notifStyle = v === "plain" ? "plain" : "media";
  if (started) void flush(false);
}

/** Update the loved state shown on the notification's heart button (filled vs outline). */
export function nativeSetLiked(v: boolean): void {
  if (!nativeMediaActive || v === liked) return;
  liked = v;
  if (started) void flush(false);
}

/** Swap the Android launcher icon to the chosen variant (enables its <activity-alias>, disables the
 *  rest). No-op off Android / until the aliases ship in a rebuilt APK. */
export async function nativeSetAppIcon(id: string): Promise<void> {
  if (!nativeMediaActive) return;
  await core();
  try { await _invoke!("media_set_app_icon", { id }); } catch { /* plugin/aliases missing until rebuild */ }
}

/** Playback fully stopped → tear down the session + notification. */
export async function nativeStop(): Promise<void> {
  if (!nativeMediaActive || !started) return;
  await core();
  started = false;
  try { await _invoke!("media_stop"); } catch { /* ignore */ }
}
