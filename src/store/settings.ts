import { create } from "zustand";
import { dynamicColorEnabled, setDynamicColorEnabled } from "@/theme/dynamicColor";
import { engine } from "@/audio/engine";
import type { LyricsProvider } from "@/lib/lyricsProviders";
import type { SwipeActionId } from "@/lib/swipeActions";
import { type OutputCfg, DEFAULT_OUTPUT } from "@/lib/outputConfig";
import { PERF_PRESETS, coverMultFor } from "@/lib/perfModes";
import { hasTauri, isAndroid } from "@/lib/backend";

// Linux desktop's WebView (webkit2gtk) can't decode mp3/aac without system GStreamer codecs AND silences
// Web Audio playback — so the native Rust engine (Symphonia decode → cpal) is the only path that plays the
// full format range there. Default it ON for Linux desktop; Android (Chromium) + macOS/Windows webviews
// play fine, so they keep the Web Audio path (native stays opt-in).
const DESKTOP_LINUX = hasTauri && !isAndroid && typeof navigator !== "undefined" && /linux/i.test(navigator.userAgent);

export type ExportRes = "720p" | "1080p";
export type ExportFps = 24 | 30 | 60;
/** Game-style performance presets. Hybrids: "smooth" (UI-first), "cinematic" (visuals-first).
 *  "dynamic" auto-adapts at runtime; "custom" = your own mix of the knobs. */
export type PerfMode = "ultra" | "high" | "balanced" | "smooth" | "cinematic" | "battery" | "dynamic" | "custom";
export type AnalysisMode = "onplay" | "idle" | "off";
export type UiAnimations = "full" | "reduced" | "off";

const LS = "wavrplay-settings";
interface Stored {
  exportRes: ExportRes;
  exportFps: ExportFps;
  fpsCap: number;        // visualizer render cap (0 = uncapped)
  normalize: boolean;    // playback loudness normalization (wired in a later DSP phase)
  autoEqPerSong: boolean; // auto-apply a corrective AutoEq curve to each song (unless it has a pinned EQ)
  speed: number;         // playback rate 0.5..2
  pitchLock: boolean;    // preserve pitch when changing speed
  crossfade: number;     // seconds of fade on track change (0 = off)
  crossfadeCurve: "linear" | "equal" | "smooth"; // fade shape used on track change
  crossfadeManual: boolean;    // crossfade on a MANUAL skip too (off = instant cut on skip; auto-advance still fades)
  crossfadeSameAlbum: boolean; // crossfade between consecutive tracks of the SAME album (off = gapless within an album)
  queueEndAction: "stop" | "endless"; // at the end of the queue (repeat off): stop, or keep going with an Endless Set
  audioFocus: "duck" | "pause" | "ignore"; // on a system focus loss (call / other app / nav prompt): duck volume, pause, or ignore
  audioFocusResume: boolean;   // resume playback automatically when audio focus is regained
  btResumeOnConnect: boolean;  // auto-resume when a Bluetooth/headset audio device connects
  btPauseOnDisconnect: boolean;// auto-pause when the Bluetooth/headset device disconnects (classic "unplug = pause")
  scrubScratch: boolean;       // vinyl-scratch sound while dragging the seek timeline
  gapless: boolean;      // preload + butt-join the next track (no silence) when crossfade is 0
  crossfadeUnit: "sec" | "ms" | "bars" | "hz"; // remembered unit for the custom-time editor
  lowPower: boolean;     // visualizer low-power mode
  fontScale: number;     // UI text scale 0.9..1.2
  uiZoom: number;        // whole-UI zoom 0.5..1.5 (for HiDPI desktops where the AppImage renders 2× big)
  density: "compact" | "cozy"; // row/padding density
  lyricsProvider: LyricsProvider; // external "find lyrics" search provider
  appBg: "off" | "blur"; // app-wide background: blurred current album art (Poweramp-style)
  bgBlur: number;        // background blur radius in px (0..120)
  bgSaturation: number;  // background colour saturation multiplier (1..2.5)
  waveSeek: boolean;     // waveform-style seek bar instead of a plain slider
  onboarded: boolean;    // first-boot personalization screen has been completed
  scrollbar: "thin" | "normal" | "hidden" | "overlay"; // scrollbar style
  scrollIndicator: "off" | "bubble" | "az" | "auto"; // big-list scroll UI: none / fast-scroll bubble / A–Z index rail / auto (rail for A–Z sorts, bubble for numeric)
  navVinyl: "off" | "playing" | "always"; // spin the centre (Player) nav tab like a vinyl record
  navCenterIcon: "disc" | "ring"; // centre (Player) glyph: solid vinyl disc / gapped ring (the gap makes the spin visible)
  navIndicator: "pill" | "plain" | "shape"; // active nav-tab background: rounded pill / none / a Material shape
  navShape: string; // Material shape name for the active tab when navIndicator === "shape"
  appIcon: string;  // chosen alternate app-icon variant id (Android launcher alias; see lib/appIcons)
  eqValues: "hidden" | "db" | "pct";   // Poweramp-style: how EQ band gains are labelled
  toneValues: "hidden" | "db" | "pct"; // …and how the Bass/Treble tone gains are labelled
  seekStyle: "sections" | "waveform" | "slider" | "wavy"; // Now-Playing timeline look ("wavy" = Android-12 squiggle)
  waveAmp: number;   // wavy timeline: squiggle amplitude (px)
  waveSpeed: number; // wavy timeline: squiggle flow speed (0 = still)
  autoTag: boolean;      // auto-enrich tags for the playing track in the background
  tagOnline: boolean;    // allow optional ONLINE metadata lookup (MusicBrainz) — sends artist+title queries off-device
  tagWriteFile: boolean; // also write enriched tags into the audio FILE (default off → app index only)
  sectionAnim: boolean;  // fade the song-section segments in (staggered) as analysis refines, vs popping in
  sectionFocus: "auto" | "hold" | "off"; // fisheye: focused section expands + shows subsections — follow the playhead / only on hold / never
  audioSections: boolean; // master switch for song-section analysis + display; off → no sections strip, no skip-intro, related options dimmed
  mixDetect: boolean;    // experimental: identify your library tracks inside long mixes via on-device fingerprint
  soundDna: boolean;     // generative "Sound DNA" glyph for art-less tracks (vs a plain music icon)
  lazyCovers: boolean;   // load album art only as a tile scrolls into view (lighter on huge libraries / weak devices)
  showBpm: boolean;      // show the detected BPM badge on Now Playing
  skipIntros: boolean;   // on track start, skip past the intro to the first energetic section
  bpmAlgo: "native" | "fast";          // tempo source: native genre-robust beatgrid vs fast webview autocorrelation
  sectionAlgo: "structural" | "energy"; // song-section source: native SSM/structure vs webview energy tiers
  nativeAudio: boolean;  // desktop: native decode→DSP→cpal engine instead of Web Audio (hi-res path)
  startScreen: "last" | "library" | "home" | "playing" | "search"; // which screen opens on launch ("last" = resume the screen you exited on)
  openPlayerOnPlay: boolean;  // jump straight to the full Now-Playing screen when you start a song
  lockPortrait: boolean;      // lock the app to portrait (disable landscape rotation)
  swipeRight: SwipeActionId; // Songs-list row action when dragged right
  swipeLeft: SwipeActionId;  // Songs-list row action when dragged left
  lockscreen: boolean;       // Android: show the app over the lock screen without unlocking (Poweramp-style)
  resumeOnStart: boolean;    // restore the last session/track (paused, at its saved position) on launch
  resumeScope: "track" | "session"; // restore just the last track, or the whole queue + shuffle/repeat
  fadeOnPause: boolean;      // short fade-out when pausing + fade-in when resuming (no abrupt cut)
  fadeOnSeek: boolean;       // Poweramp-style: brief gain dip around a seek JUMP so it doesn't click
  trackGap: number;          // Poweramp "Silence between tracks": ms of silence inserted on auto-advance (no crossfade)
  rewindOnResume: number;    // seconds to jump back when resuming after a pause (0 = off)
  keepScreenOn: boolean;     // hold a screen wake-lock while a track is playing
  balance: number;           // stereo balance, -1 (full left) .. 0 (center) .. 1 (full right)
  monoOutput: boolean;       // sum both channels to mono (accessibility / single earbud)
  notifButtons: NotifButton[]; // Android: ordered notification/lock-screen transport buttons (1–5; first 3 = compact view)
  notifText: NotifText;        // Android: what the notification shows under the title (artist / album / both / nothing)
  notifIcon: string;           // Android: which white status-bar icon the media notification uses (note/play/wave/eq/bolt/pulse)
  notifStyle: "media" | "plain"; // Android: rich MediaStyle notification, or a plain/normal one (better on some older devices)
  recentLimit: number;         // how many entries the "Recently Played" list keeps (0 = unlimited)
  recentOrder: "recent" | "plays" | "title" | "artist"; // how "Recently Played" is ordered
  tastePerf: "low" | "high";   // taste analysis quality: low = faster/lighter, high = full accuracy
  tasteAutoAnalyze: boolean;   // fingerprint tracks in the background as you actually play them
  clipPrevent: boolean;        // native engine: soft limiter at 0 dBFS (prevents EQ/RG clipping)
  ditherBits: number;          // native engine output dither: 0 = off, else 16/24-bit TPDF
  discovery: "familiar" | "balanced" | "discover"; // For You blend adventurousness
  introSeen: boolean;          // the first-launch feature introduction has been shown
  exploreIntroSeen: boolean;   // first-visit intro for the Explore tab has been shown
  forYouIntroSeen: boolean;    // first-visit intro for the For You page has been shown
  output: OutputCfg;           // Poweramp-style per-device output-plugin config
  npFooter: NpFooterMode[];    // cycling Now-Playing footer info lines (tap cycles, hold = Audio Info)
  streamLan: boolean;          // expose the local media server on the LAN (for Cast + nearby-device sharing)
  btAutoEq: boolean;           // auto-switch the EQ preset when a known Bluetooth device connects (car etc.)
  btEqMap: Record<string, string>; // Bluetooth MAC → EQ preset name
  btDevices: { address: string; name: string }[]; // Bluetooth devices we've seen (for the mapping UI)
  exploreBlur: number;         // Explore map: blurred album-art container background, px (0 = off/fastest)
  lastfmKey: string;           // Last.fm API key (free) → artist bios/tags on the Explore map (empty = off)
  jamendoKey: string;          // Jamendo client ID (free) → browse/stream Creative-Commons music (empty = off)
  subsonicUrl: string;         // Subsonic/Navidrome server URL (empty = off)
  subsonicUser: string;
  subsonicPass: string;
  podcasts: string[];          // subscribed podcast RSS feed URLs
  extensions: { id: string; name: string; code: string; enabled: boolean }[]; // user-installed source plugins
  libTabs: string[];           // Library sub-tabs, in order (omitted ids are hidden)
  // ── Performance (game-style graphics presets) ──────────────────────────────
  perfMode: PerfMode;          // active preset (or "custom"/"dynamic") — see PERF_PRESETS
  coverCacheSize: number;      // in-memory album-art LRU capacity (100..5000); bigger = smoother grid scroll, more RAM
  analysisMode: AnalysisMode;  // when on-device analysis (AutoEq + taste fingerprint) runs: on play / idle only / off
  liveSearch: boolean;         // filter the library as you type (off = filter only when you press Enter)
  searchDebounce: number;      // ms to wait after a keystroke before filtering (live search)
  uiAnimations: UiAnimations;  // motion level: full / reduced / off (reduce-motion)
  batterySaver: boolean;       // auto-throttle visuals (eco mode) when unplugged / on battery
  dbBrowse: boolean;           // experimental: serve Albums/Artists from the SQLite index (P2.9) instead of building lists in JS
  lagMonitor: boolean;         // dev/diagnostic: show a live frame-time + main-thread-stall HUD (Lag monitor)
}
/** The info lines the Now-Playing footer can cycle through (Poweramp-style status strip). */
export type NpFooterMode = "queue" | "path" | "next" | "format" | "output";
export const NP_FOOTER_MODES: { id: NpFooterMode; label: string }[] = [
  { id: "queue", label: "Queue position" },
  { id: "path", label: "File / folder" },
  { id: "next", label: "Up next" },
  { id: "format", label: "Format" },
  { id: "output", label: "Output" },
];
/** Action ids the Android media notification can show. First 3 in the list become the collapsed view. */
export type NotifButton = "prev" | "next" | "playpause" | "rewind" | "forward" | "stop" | "like";
export const NOTIF_BUTTONS: { id: NotifButton; label: string; icon: string }[] = [
  { id: "prev", label: "Previous", icon: "prev" },
  { id: "playpause", label: "Play / Pause", icon: "play" },
  { id: "next", label: "Next", icon: "next" },
  { id: "rewind", label: "Rewind 10s", icon: "prev" },
  { id: "forward", label: "Forward 10s", icon: "next" },
  { id: "like", label: "Like", icon: "favorite" },
  { id: "stop", label: "Stop", icon: "close" },
];
export const NOTIF_BUTTONS_MAX = 5; // Android notifications allow at most 5 actions
/** What the media notification shows on the line(s) under the (always-shown) track title. */
export type NotifText = "artist-album" | "artist" | "album" | "none";
const DEFAULTS: Stored = {
  // export
  exportRes: "1080p", exportFps: 30,
  // visualizer / power
  fpsCap: 60, lowPower: false,
  // playback DSP
  normalize: false, autoEqPerSong: false, speed: 1, pitchLock: true,
  // transitions
  crossfade: 0, crossfadeCurve: "equal", crossfadeManual: true, crossfadeSameAlbum: false, gapless: true, crossfadeUnit: "sec",
  // queue / focus / bluetooth behaviour
  queueEndAction: "stop", audioFocus: "duck", audioFocusResume: true,
  btResumeOnConnect: false, btPauseOnDisconnect: true, scrubScratch: true,
  // appearance / typography
  fontScale: 1, uiZoom: 1, density: "cozy", lyricsProvider: "google", appBg: "blur", bgBlur: 64, bgSaturation: 1.5,
  eqValues: "db", toneValues: "db",
  waveSeek: true, onboarded: false, scrollbar: "thin", scrollIndicator: "auto", seekStyle: "sections", waveAmp: 4, waveSpeed: 1, autoTag: false, tagOnline: false, tagWriteFile: false, sectionAnim: true, sectionFocus: "auto", audioSections: true, mixDetect: false, soundDna: true,
  navVinyl: "playing", navCenterIcon: "disc", navIndicator: "pill", navShape: "cookie6Sided", appIcon: "default",
  // library / analysis
  lazyCovers: false, showBpm: true, skipIntros: false, nativeAudio: DESKTOP_LINUX, startScreen: "last", openPlayerOnPlay: true, lockPortrait: false,
  bpmAlgo: "native", sectionAlgo: "structural",
  // gestures
  swipeRight: "like", swipeLeft: "queue", lockscreen: false,
  // resume / pause behaviour
  resumeOnStart: true, resumeScope: "session", fadeOnPause: false, fadeOnSeek: false, trackGap: 0, rewindOnResume: 0, keepScreenOn: false,
  // output
  balance: 0, monoOutput: false, notifButtons: ["prev", "playpause", "next"], notifText: "artist-album", notifIcon: "note", notifStyle: "media", output: DEFAULT_OUTPUT,
  npFooter: ["queue", "path", "next", "format", "output"],
  // recents / taste
  recentLimit: 50, recentOrder: "recent", tastePerf: "high", tasteAutoAnalyze: true,
  clipPrevent: true, ditherBits: 0, discovery: "balanced", introSeen: false, exploreIntroSeen: false, forYouIntroSeen: false,
  // streaming / bluetooth / explore
  streamLan: false, btAutoEq: false, btEqMap: {}, btDevices: [], exploreBlur: 18, lastfmKey: "", jamendoKey: "", subsonicUrl: "", subsonicUser: "", subsonicPass: "", podcasts: [], extensions: [], libTabs: ["browse", "explore", "songs", "loved", "albums", "artists", "folders", "playlists"],
  // performance preset knobs
  perfMode: "balanced", coverCacheSize: 800, analysisMode: "onplay", liveSearch: true,
  searchDebounce: 180, uiAnimations: "full", batterySaver: false, dbBrowse: false, lagMonitor: false,
};

/** The persisted keys, derived from DEFAULTS — so adding a setting never needs touching `save()`. */
const STORED_KEYS = Object.keys(DEFAULTS) as (keyof Stored)[];

/** The knobs each performance preset controls. "custom" is excluded — it keeps whatever you set.
 *  The preset values + UI cards live in one place: `lib/perfModes.ts`. */
export type PerfKnobs = Pick<Stored, "fpsCap" | "lowPower" | "lazyCovers" | "coverCacheSize" | "exploreBlur" | "bgBlur" | "appBg" | "tastePerf" | "analysisMode" | "liveSearch" | "searchDebounce" | "uiAnimations" | "batterySaver">;

function load(): Stored {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(LS) || "") }; } catch { return { ...DEFAULTS }; }
}
/** Pick just the Stored fields out of the live state (drops actions + transient flags) and persist. */
function persist(state: Stored) {
  const out: Record<string, unknown> = {};
  for (const k of STORED_KEYS) out[k] = state[k];
  try { localStorage.setItem(LS, JSON.stringify(out)); } catch { /* ignore */ }
}

interface SettingsState extends Stored {
  dynamicColor: boolean;
  setExportRes: (r: ExportRes) => void;
  setExportFps: (f: ExportFps) => void;
  setFpsCap: (c: number) => void;
  setNormalize: (on: boolean) => void;
  setAutoEqPerSong: (on: boolean) => void;
  setDynamicColor: (on: boolean) => void;
  setSpeed: (v: number) => void;
  setPitchLock: (on: boolean) => void;
  setCrossfade: (sec: number) => void;
  setCrossfadeCurve: (c: Stored["crossfadeCurve"]) => void;
  setCrossfadeManual: (on: boolean) => void;
  setCrossfadeSameAlbum: (on: boolean) => void;
  setQueueEndAction: (a: Stored["queueEndAction"]) => void;
  setAudioFocus: (m: Stored["audioFocus"]) => void;
  setAudioFocusResume: (on: boolean) => void;
  setBtResumeOnConnect: (on: boolean) => void;
  setBtPauseOnDisconnect: (on: boolean) => void;
  setScrubScratch: (on: boolean) => void;
  setGapless: (on: boolean) => void;
  setCrossfadeUnit: (u: Stored["crossfadeUnit"]) => void;
  setLowPower: (on: boolean) => void;
  setFontScale: (v: number) => void;
  setUiZoom: (v: number) => void;
  setDensity: (d: "compact" | "cozy") => void;
  setLyricsProvider: (p: LyricsProvider) => void;
  setAppBg: (b: "off" | "blur") => void;
  setBgBlur: (px: number) => void;
  setBgSaturation: (m: number) => void;
  setWaveSeek: (on: boolean) => void;
  setOnboarded: (v: boolean) => void;
  setScrollbar: (s: "thin" | "normal" | "hidden" | "overlay") => void;
  setScrollIndicator: (s: "off" | "bubble" | "az" | "auto") => void;
  setNavVinyl: (v: Stored["navVinyl"]) => void;
  setNavCenterIcon: (v: Stored["navCenterIcon"]) => void;
  setNavIndicator: (v: Stored["navIndicator"]) => void;
  setNavShape: (v: string) => void;
  setAppIcon: (id: string) => void;
  setEqValues: (v: "hidden" | "db" | "pct") => void;
  setToneValues: (v: "hidden" | "db" | "pct") => void;
  setSeekStyle: (s: "sections" | "waveform" | "slider" | "wavy") => void;
  setWaveAmp: (v: number) => void;
  setWaveSpeed: (v: number) => void;
  setAutoTag: (v: boolean) => void;
  setTagOnline: (v: boolean) => void;
  setTagWriteFile: (v: boolean) => void;
  setSectionAnim: (on: boolean) => void;
  setSectionFocus: (m: "auto" | "hold" | "off") => void;
  setAudioSections: (on: boolean) => void;
  setMixDetect: (on: boolean) => void;
  setSoundDna: (on: boolean) => void;
  setLazyCovers: (on: boolean) => void;
  setShowBpm: (on: boolean) => void;
  setSkipIntros: (on: boolean) => void;
  setNativeAudio: (on: boolean) => void;
  setStartScreen: (s: Stored["startScreen"]) => void;
  setSwipe: (dir: "left" | "right", id: SwipeActionId) => void;
  setLockscreen: (on: boolean) => void;
  setBpmAlgo: (a: Stored["bpmAlgo"]) => void;
  setSectionAlgo: (a: Stored["sectionAlgo"]) => void;
  setResumeOnStart: (on: boolean) => void;
  setOpenPlayerOnPlay: (on: boolean) => void;
  setLockPortrait: (on: boolean) => void;
  setResumeScope: (s: Stored["resumeScope"]) => void;
  setFadeOnPause: (on: boolean) => void;
  setFadeOnSeek: (on: boolean) => void;
  setTrackGap: (ms: number) => void;
  setRewindOnResume: (sec: number) => void;
  setKeepScreenOn: (on: boolean) => void;
  setBalance: (v: number) => void;
  setMonoOutput: (on: boolean) => void;
  setNotifButtons: (b: NotifButton[]) => void;
  setNotifText: (v: NotifText) => void;
  setNotifIcon: (id: string) => void;
  setNotifStyle: (v: "media" | "plain") => void;
  setRecentLimit: (n: number) => void;
  setRecentOrder: (o: Stored["recentOrder"]) => void;
  setTastePerf: (p: Stored["tastePerf"]) => void;
  setTasteAutoAnalyze: (on: boolean) => void;
  setClipPrevent: (on: boolean) => void;
  setDitherBits: (b: number) => void;
  setDiscovery: (d: Stored["discovery"]) => void;
  setIntroSeen: (v: boolean) => void;
  setExploreIntroSeen: (v: boolean) => void;
  setForYouIntroSeen: (v: boolean) => void;
  setOutput: (o: OutputCfg) => void;
  setNpFooter: (m: NpFooterMode[]) => void;
  setStreamLan: (on: boolean) => void;
  setBtAutoEq: (on: boolean) => void;
  setExploreBlur: (px: number) => void;
  setLastfmKey: (key: string) => void;
  setJamendoKey: (key: string) => void;
  setSubsonicUrl: (v: string) => void;
  setSubsonicUser: (v: string) => void;
  setSubsonicPass: (v: string) => void;
  setPodcasts: (urls: string[]) => void;
  setExtensions: (e: Stored["extensions"]) => void;
  setLibTabs: (t: string[]) => void;
  /** Apply a performance preset (writes all its knobs); "custom" just records the label. */
  setPerfMode: (m: PerfMode) => void;
  setCoverCacheSize: (n: number) => void;
  setAnalysisMode: (m: AnalysisMode) => void;
  setLiveSearch: (on: boolean) => void;
  setSearchDebounce: (ms: number) => void;
  setUiAnimations: (m: UiAnimations) => void;
  setBatterySaver: (on: boolean) => void;
  setDbBrowse: (on: boolean) => void;
  setLagMonitor: (on: boolean) => void;
  /** Push perf prefs to the cover cache + start/stop the dynamic governor — called on mount + on change. */
  applyPerf: () => void;
  /** Map a Bluetooth device (by MAC) to an EQ preset name (empty string = no mapping). */
  setBtEq: (address: string, preset: string) => void;
  /** Record a Bluetooth device we've seen so it can be mapped in Settings even when disconnected. */
  rememberBtDevice: (address: string, name: string) => void;
  /** Reset a specific set of settings keys back to their defaults (per-section "Restore defaults"). */
  reset: (keys: (keyof Stored)[]) => void;
  /** Push audio prefs (speed/pitch) to the engine — called on app mount. */
  applyAudio: () => void;
  /** Apply UI prefs (font scale + density) to the DOM — called on app mount. */
  applyUi: () => void;
}

const init = load();

export const useSettings = create<SettingsState>((set, get) => {
  const save = () => persist(get());
  // A granular perf-knob change means your settings no longer match any preset → mark "custom", persist,
  // then run any side-effect (re-apply to the runtime). Keeps the granular setters DRY.
  const setCustom = (patch: Partial<Stored>, after?: () => void) => { set({ ...patch, perfMode: "custom" }); save(); after?.(); };
  return {
    ...init,
    dynamicColor: dynamicColorEnabled(),
    setExportRes: (exportRes) => { set({ exportRes }); save(); },
    setExportFps: (exportFps) => { set({ exportFps }); save(); },
    setFpsCap: (fpsCap) => { set({ fpsCap }); save(); },
    setNormalize: (normalize) => { set({ normalize }); save(); },
    setAutoEqPerSong: (autoEqPerSong) => {
      set({ autoEqPerSong }); save();
      // re-resolve the current track's EQ right away (turn on → AutoEq it; turn off → restore base)
      import("@/store/player").then((m) => { const t = m.usePlayer.getState().current(); if (t) m.usePlayer.getState().resolveSongEq(t); });
    },
    setDynamicColor: (on) => { setDynamicColorEnabled(on); set({ dynamicColor: on }); },
    setSpeed: (speed) => { engine.setRate(speed); set({ speed }); save(); },
    setPitchLock: (pitchLock) => { engine.setPitchLock(pitchLock); set({ pitchLock }); save(); },
    setCrossfade: (crossfade) => { set({ crossfade: Math.max(0, Math.round(crossfade * 100) / 100) }); save(); },
    setCrossfadeCurve: (crossfadeCurve) => { set({ crossfadeCurve }); save(); },
    setCrossfadeManual: (crossfadeManual) => { set({ crossfadeManual }); save(); },
    setCrossfadeSameAlbum: (crossfadeSameAlbum) => { set({ crossfadeSameAlbum }); save(); },
    setQueueEndAction: (queueEndAction) => { set({ queueEndAction }); save(); },
    setAudioFocus: (audioFocus) => { set({ audioFocus }); save(); import("@/lib/nativeMedia").then((m) => m.nativeSetAudioFocus(audioFocus)); },
    setAudioFocusResume: (audioFocusResume) => { set({ audioFocusResume }); save(); },
    setBtResumeOnConnect: (btResumeOnConnect) => { set({ btResumeOnConnect }); save(); },
    setBtPauseOnDisconnect: (btPauseOnDisconnect) => { set({ btPauseOnDisconnect }); save(); },
    setScrubScratch: (scrubScratch) => { set({ scrubScratch }); save(); import("@/audio/scratch").then((m) => m.setScratchEnabled(scrubScratch)); },
    setGapless: (gapless) => { set({ gapless }); save(); },
    setCrossfadeUnit: (crossfadeUnit) => { set({ crossfadeUnit }); save(); },
    setLowPower: (lowPower) => { set({ lowPower }); save(); },
    setFontScale: (fontScale) => { set({ fontScale }); save(); get().applyUi(); },
    setUiZoom: (uiZoom) => { set({ uiZoom: Math.max(0.5, Math.min(1.5, +uiZoom.toFixed(2))) }); save(); get().applyUi(); },
    setDensity: (density) => { set({ density }); save(); get().applyUi(); },
    setLyricsProvider: (lyricsProvider) => { set({ lyricsProvider }); save(); },
    setAppBg: (appBg) => { set({ appBg }); save(); get().applyUi(); },
    setBgBlur: (bgBlur) => { set({ bgBlur }); save(); get().applyUi(); },
    setBgSaturation: (bgSaturation) => { set({ bgSaturation }); save(); get().applyUi(); },
    setWaveSeek: (waveSeek) => { set({ waveSeek }); save(); },
    setEqValues: (eqValues) => { set({ eqValues }); save(); },
    setToneValues: (toneValues) => { set({ toneValues }); save(); },
    setSeekStyle: (seekStyle) => { set({ seekStyle }); save(); },
    setWaveAmp: (waveAmp) => { set({ waveAmp }); save(); },
    setWaveSpeed: (waveSpeed) => { set({ waveSpeed }); save(); },
    setAutoTag: (autoTag) => { set({ autoTag }); save(); },
    setTagOnline: (tagOnline) => { set({ tagOnline }); save(); },
    setTagWriteFile: (tagWriteFile) => { set({ tagWriteFile }); save(); },
    setSectionAnim: (sectionAnim) => { set({ sectionAnim }); save(); },
    setSectionFocus: (sectionFocus) => { set({ sectionFocus }); save(); },
    setAudioSections: (audioSections) => { set({ audioSections }); save(); },
    setMixDetect: (mixDetect) => { set({ mixDetect }); save(); if (mixDetect) import("@/store/mixId").then((m) => m.startMixFingerprinting()); },
    setSoundDna: (soundDna) => { set({ soundDna }); save(); },
    setLazyCovers: (lazyCovers) => { set({ lazyCovers }); save(); },
    setShowBpm: (showBpm) => { set({ showBpm }); save(); },
    setSkipIntros: (skipIntros) => { set({ skipIntros }); save(); },
    setNativeAudio: (nativeAudio) => { set({ nativeAudio }); save(); engine.setNativeMode(nativeAudio); },
    setStartScreen: (startScreen) => { set({ startScreen }); save(); },
    setSwipe: (dir, id) => { set(dir === "right" ? { swipeRight: id } : { swipeLeft: id }); save(); },
    setLockscreen: (lockscreen) => { set({ lockscreen }); save(); import("@/lib/nativeMedia").then((m) => m.nativeSetLockscreen(lockscreen)); },
    setBpmAlgo: (bpmAlgo) => { set({ bpmAlgo }); save(); },
    setSectionAlgo: (sectionAlgo) => { set({ sectionAlgo }); save(); },
    setResumeOnStart: (resumeOnStart) => { set({ resumeOnStart }); save(); },
  setOpenPlayerOnPlay: (openPlayerOnPlay) => { set({ openPlayerOnPlay }); save(); },
  setLockPortrait: (lockPortrait) => { set({ lockPortrait }); save(); applyOrientation(lockPortrait); },
    setResumeScope: (resumeScope) => { set({ resumeScope }); save(); },
    setFadeOnPause: (fadeOnPause) => { set({ fadeOnPause }); save(); },
    setFadeOnSeek: (fadeOnSeek) => { set({ fadeOnSeek }); save(); },
    setTrackGap: (trackGap) => { set({ trackGap: Math.max(0, Math.min(10000, Math.round(trackGap))) }); save(); },
    setRewindOnResume: (rewindOnResume) => { set({ rewindOnResume: Math.max(0, rewindOnResume) }); save(); },
    setKeepScreenOn: (keepScreenOn) => { set({ keepScreenOn }); save(); },
    setBalance: (balance) => { const v = Math.max(-1, Math.min(1, balance)); set({ balance: v }); save(); engine.setBalance(v); },
    setMonoOutput: (monoOutput) => { set({ monoOutput }); save(); engine.setMono(monoOutput); },
    setNotifButtons: (b) => { const notifButtons = b.slice(0, 5); set({ notifButtons }); save(); import("@/lib/nativeMedia").then((m) => m.nativeSetActions(notifButtons)); },
    setNotifText: (notifText) => { set({ notifText }); save(); import("@/lib/nativeMedia").then((m) => m.nativeSetNotifText(notifText)); },
    setNotifIcon: (notifIcon) => { set({ notifIcon }); save(); import("@/lib/nativeMedia").then((m) => m.nativeSetNotifIcon(notifIcon)); },
    setNotifStyle: (notifStyle) => { set({ notifStyle }); save(); import("@/lib/nativeMedia").then((m) => m.nativeSetNotifStyle(notifStyle)); },
    setRecentLimit: (recentLimit) => { set({ recentLimit: Math.max(0, recentLimit) }); save(); },
    setRecentOrder: (recentOrder) => { set({ recentOrder }); save(); },
    setTastePerf: (tastePerf) => { set({ tastePerf }); save(); },
    setTasteAutoAnalyze: (tasteAutoAnalyze) => { set({ tasteAutoAnalyze }); save(); },
    setClipPrevent: (clipPrevent) => { set({ clipPrevent }); save(); engine.setOutputStage(clipPrevent, get().ditherBits); },
    setDitherBits: (ditherBits) => { set({ ditherBits }); save(); engine.setOutputStage(get().clipPrevent, ditherBits); },
    setDiscovery: (discovery) => { set({ discovery }); save(); },
    setIntroSeen: (introSeen) => { set({ introSeen }); save(); },
    setExploreIntroSeen: (exploreIntroSeen) => { set({ exploreIntroSeen }); save(); },
    setForYouIntroSeen: (forYouIntroSeen) => { set({ forYouIntroSeen }); save(); },
    setOutput: (output) => { set({ output }); save(); },
    setNpFooter: (npFooter) => { set({ npFooter }); save(); },
    setStreamLan: (streamLan) => { set({ streamLan }); save(); import("@/lib/backend").then((m) => m.streamSetLan(streamLan)); },
    setBtAutoEq: (btAutoEq) => { set({ btAutoEq }); save(); if (btAutoEq) import("@/lib/bluetoothEq").then((m) => m.ensureBtPermission()); },
    setExploreBlur: (exploreBlur) => { set({ exploreBlur: Math.max(0, Math.min(40, Math.round(exploreBlur))) }); save(); },
    setLastfmKey: (lastfmKey) => { set({ lastfmKey: lastfmKey.trim() }); save(); },
    setJamendoKey: (jamendoKey) => { set({ jamendoKey: jamendoKey.trim() }); save(); },
    setSubsonicUrl: (subsonicUrl) => { set({ subsonicUrl: subsonicUrl.trim() }); save(); },
    setSubsonicUser: (subsonicUser) => { set({ subsonicUser: subsonicUser.trim() }); save(); },
    setSubsonicPass: (subsonicPass) => { set({ subsonicPass }); save(); },
    setPodcasts: (podcasts) => { set({ podcasts }); save(); },
    setExtensions: (extensions) => { set({ extensions }); save(); },
    setLibTabs: (libTabs) => { set({ libTabs }); save(); },
    setPerfMode: (perfMode) => {
      // A preset writes ALL its knobs at once; "custom" only records the label (keeps your mix).
      if (perfMode !== "custom") set({ ...PERF_PRESETS[perfMode], perfMode });
      else set({ perfMode });
      save(); get().applyUi(); get().applyPerf();
    },
    // Granular perf knobs flip the active preset to "custom" (your mix no longer matches a preset).
    setCoverCacheSize: (n) => setCustom({ coverCacheSize: Math.max(100, Math.min(5000, Math.round(n))) }, get().applyPerf),
    setAnalysisMode: (analysisMode) => setCustom({ analysisMode }),
    setLiveSearch: (liveSearch) => setCustom({ liveSearch }),
    setSearchDebounce: (ms) => setCustom({ searchDebounce: Math.max(0, Math.min(800, Math.round(ms))) }),
    setUiAnimations: (uiAnimations) => setCustom({ uiAnimations }, get().applyUi),
    // Battery saver layers on top of Dynamic (both can be on) → don't clobber a Dynamic selection.
    setBatterySaver: (batterySaver) => { set({ batterySaver, perfMode: get().perfMode === "dynamic" ? "dynamic" : "custom" }); save(); get().applyPerf(); },
    setDbBrowse: (dbBrowse) => { set({ dbBrowse }); save(); },
    setLagMonitor: (lagMonitor) => { set({ lagMonitor }); save(); import("@/lib/lagMonitor").then((m) => lagMonitor ? m.startLagMonitor() : m.stopLagMonitor()); },
    applyPerf: () => {
      const { coverCacheSize, perfMode, batterySaver } = get();
      // Cover-fetch aggressiveness scales with the perf mode (defined alongside the preset in perfModes).
      import("@/components/Cover").then((m) => { m.setCoverCacheLimit(coverCacheSize); m.setCoverConcurrency(coverMultFor(perfMode)); });
      import("@/lib/perfRuntime").then((m) => m.syncPerfRuntime(perfMode === "dynamic", batterySaver));
    },
    setBtEq: (address, preset) => { set((s) => ({ btEqMap: { ...s.btEqMap, [address]: preset } })); save(); },
    rememberBtDevice: (address, name) => {
      const cur = get().btDevices;
      const i = cur.findIndex((d) => d.address === address);
      if (i >= 0 && (!name || cur[i].name === name)) return; // already known, nothing new
      const btDevices = i >= 0 ? cur.map((d, j) => (j === i ? { address, name: name || d.name } : d))
                               : [...cur, { address, name }];
      set({ btDevices }); save();
    },
    reset: (keys) => {
      const patch: Partial<Stored> = {};
      for (const k of keys) (patch as Record<string, unknown>)[k] = DEFAULTS[k];
      set(patch as Partial<SettingsState>); save();
      get().applyUi(); get().applyAudio(); // re-apply DOM + engine (balance/mono/native/clip/dither)
    },
    setOnboarded: (onboarded) => { set({ onboarded }); save(); },
    setScrollbar: (scrollbar) => { set({ scrollbar }); save(); get().applyUi(); },
    setScrollIndicator: (scrollIndicator) => { set({ scrollIndicator }); save(); },
    setNavVinyl: (navVinyl) => { set({ navVinyl }); save(); },
    setNavCenterIcon: (navCenterIcon) => { set({ navCenterIcon }); save(); },
    setNavIndicator: (navIndicator) => { set({ navIndicator }); save(); get().applyUi(); },
    setNavShape: (navShape) => { set({ navShape }); save(); },
    setAppIcon: (appIcon) => { set({ appIcon }); save(); import("@/lib/nativeMedia").then((m) => m.nativeSetAppIcon(appIcon)); },
    applyAudio: () => {
      const { speed, pitchLock, nativeAudio, balance, monoOutput, clipPrevent, ditherBits, audioFocus, scrubScratch } = get();
      engine.setPitchLock(pitchLock); engine.setRate(speed); engine.setNativeMode(nativeAudio);
      engine.setBalance(balance); engine.setMono(monoOutput); engine.setOutputStage(clipPrevent, ditherBits);
      import("@/lib/nativeMedia").then((m) => m.nativeSetAudioFocus(audioFocus));
      import("@/audio/scratch").then((m) => m.setScratchEnabled(scrubScratch));
    },
    applyUi: () => {
      const { fontScale, uiZoom, density, appBg, bgBlur, bgSaturation, scrollbar, uiAnimations, lowPower } = get();
      const root = document.documentElement;
      root.style.setProperty("--wp-fs", String(fontScale));
      // Whole-UI zoom (webkit-ok CSS `zoom`). Plain multiplier — CSS px are resolution-independent, so a
      // higher-DPI screen shows the SAME apparent size, just sharper (do NOT divide by devicePixelRatio,
      // that wrongly shrinks the UI on better monitors). One value, consistent across all displays.
      const z = uiZoom || 1;
      (root.style as CSSStyleDeclaration & { zoom?: string }).zoom = Math.abs(z - 1) > 0.001 ? String(z) : "";
      root.style.setProperty("--wp-bg-blur", `${bgBlur}px`);
      root.style.setProperty("--wp-bg-sat", String(bgSaturation));
      root.dataset.density = density;
      root.dataset.appbg = appBg;
      root.dataset.scrollbar = scrollbar;
      root.dataset.anim = uiAnimations;
      root.dataset.navInd = get().navIndicator;
      // "Lite" = drop EVERY backdrop-filter (the single biggest continuous GPU/battery/heat cost on
      // phones). The lighter presets opt in: any mode that already kills the blurred app background, or
      // runs low-power / reduced motion. Richer modes (ultra/high/balanced/cinematic) keep full glass.
      const lite = appBg === "off" || lowPower || uiAnimations !== "full";
      root.dataset.perflite = lite ? "1" : "0";
      applyOrientation(get().lockPortrait);
    },
  };
});

/** Best-effort orientation lock. When `lock` is on we pin the screen to portrait (disable landscape);
 *  off releases it back to auto-rotate. Uses the Screen Orientation API, which most Android WebViews
 *  honour; silently no-ops where it isn't supported. */
function applyOrientation(lock: boolean) {
  try {
    const o = (screen as unknown as { orientation?: { lock?: (t: string) => Promise<void>; unlock?: () => void } }).orientation;
    if (!o) return;
    if (lock) void o.lock?.("portrait").catch(() => { /* needs fullscreen / unsupported → ignore */ });
    else o.unlock?.();
  } catch { /* unsupported */ }
}
