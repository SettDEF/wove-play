import type { Track } from "./types";
import { bindNativeControls, nativeSetMeta, nativeSetPlayback } from "./nativeMedia";
import { bindDesktopControls, desktopSetMeta, desktopSetPlayback } from "./desktopMedia";

/** OS media-session integration: lock-screen / notification metadata + hardware media keys.
 *  The W3C `navigator.mediaSession` covers desktop OS controls + (best-effort) the Android
 *  WebView. On Android it ALSO drives the native foreground `PlaybackService` (lib/nativeMedia),
 *  which is what gives a persistent notification + true background playback. */

interface Handlers {
  play: () => void;
  pause: () => void;
  next: () => void;
  prev: () => void;
  seekTo: (sec: number) => void;
  rewind: () => void;
  forward: () => void;
  like: () => void;
  playMediaId: (id: string) => void; // Android Auto browse selection
}

const has = () => typeof navigator !== "undefined" && "mediaSession" in navigator;

// Latest known position/duration/play-state, so a state change can push position to the native
// session (and a position tick can carry the play-state) without each caller supplying all three.
let lastPlaying = false;
let lastPosition = 0;
let lastDuration = 0;

export function setupMediaSession(h: Handlers): void {
  // Native Android transport controls (notification / lock screen / headset / bluetooth keys).
  void bindNativeControls({
    play: h.play, pause: h.pause, next: h.next, prev: h.prev,
    stop: h.pause, seekTo: h.seekTo, rewind: h.rewind, forward: h.forward, like: h.like,
    playMediaId: h.playMediaId,
  });
  // Desktop OS media controls (MPRIS on Linux)
  void bindDesktopControls({
    play: h.play, pause: h.pause, toggle: () => (lastPlaying ? h.pause() : h.play()),
    next: h.next, prev: h.prev, stop: h.pause, seekTo: h.seekTo, rewind: h.rewind, forward: h.forward,
  });

  if (!has()) return;
  const ms = navigator.mediaSession;
  const set = (action: MediaSessionAction, fn: (d?: MediaSessionActionDetails) => void) => {
    try { ms.setActionHandler(action, fn); } catch { /* unsupported action */ }
  };
  set("play", () => h.play());
  set("pause", () => h.pause());
  set("previoustrack", () => h.prev());
  set("nexttrack", () => h.next());
  set("seekto", (d) => { if (d && typeof d.seekTime === "number") h.seekTo(d.seekTime); });
  set("seekbackward", () => h.seekTo(-1));
  set("seekforward", () => h.seekTo(-1));
}

export function updateMediaMetadata(track: Track, artUrl: string | null): void {
  void nativeSetMeta({ title: track.title, artist: track.artist, album: track.album }, artUrl);
  void desktopSetMeta({ title: track.title, artist: track.artist, album: track.album, durationSec: lastDuration, positionSec: lastPosition, playing: lastPlaying }, artUrl);
  if (!has() || typeof MediaMetadata === "undefined") return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: track.title,
    artist: track.artist,
    album: track.album,
    artwork: artUrl ? [{ src: artUrl, sizes: "256x256", type: "image/jpeg" }] : [],
  });
}

export function setPlaybackState(playing: boolean): void {
  lastPlaying = playing;
  nativeSetPlayback(playing, lastPosition, lastDuration);
  void desktopSetPlayback(playing, lastPosition, true); // force: a real play/pause flip = instant
  if (!has()) return;
  navigator.mediaSession.playbackState = playing ? "playing" : "paused";
}

export function setPositionState(duration: number, position: number): void {
  if (Number.isFinite(duration) && duration > 0) lastDuration = duration;
  lastPosition = position;
  nativeSetPlayback(lastPlaying, position, lastDuration);
  void desktopSetPlayback(lastPlaying, position); // throttled inside
  if (!has() || typeof navigator.mediaSession.setPositionState !== "function") return;
  if (!Number.isFinite(duration) || duration <= 0) return;
  try { navigator.mediaSession.setPositionState({ duration, position: Math.min(position, duration), playbackRate: 1 }); } catch { /* ignore */ }
}
