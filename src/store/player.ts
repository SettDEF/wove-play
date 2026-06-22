import { create } from "zustand";
import type { Track, RepeatMode, EqPreset, EqSnapshot } from "@/lib/types";
import { engine, EQ_FREQS } from "@/audio/engine";
import { autoEqForTrack } from "@/lib/autoEqTrack";
import { useEqAssign } from "@/store/eqAssign";
import { fileUrl, prefetchFileUrl, scanLibraryDiff, scanLibraryStream, pickMusicFolder, demoTracks, hasTauri, isAndroid, indexStatus, readIndex, stopIndexing, cacheLoadStream, cacheSave, tracksMetaUris, mediaStoreScan, hasMediaPermission, requestMediaPermission, safTreeToRelPath, buildEndlessSet, analyzeTracksNative } from "@/lib/backend";
import type { EndlessTransition } from "@/lib/backend";
import { toast, useToasts } from "@/store/toasts";
import { useSettings } from "@/store/settings";
import { analysisPaused, noteAnalysisActivity } from "@/store/analysisPause";
import * as taste from "@/lib/taste";

export type Tab = "home" | "library" | "search" | "playing" | "eq" | "visualizer" | "daw" | "settings";

/** Built-in EQ presets (Poweramp-style), 10 bands low→high in dB. */
export const EQ_PRESETS: EqPreset[] = [
  { name: "Flat", preamp: 0, enabled: true, gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  { name: "Bass Boost", preamp: 0, enabled: true, gains: [6, 5, 4, 2, 0, 0, 0, 0, 0, 0] },
  { name: "Treble", preamp: 0, enabled: true, gains: [0, 0, 0, 0, 0, 1, 2, 4, 5, 6] },
  { name: "Vocal", preamp: 0, enabled: true, gains: [-2, -1, 0, 2, 4, 4, 3, 1, 0, -1] },
  { name: "Electronic", preamp: 0, enabled: true, gains: [5, 4, 1, 0, -1, 1, 0, 1, 4, 5] },
  { name: "Loudness", preamp: -2, enabled: true, gains: [6, 4, 0, 0, -1, 0, 0, 2, 5, 6] },
];

const LS = "wavrplay-state";
/** A restorable playback session: the whole queue (track ids) + where we were in it. */
interface Session { ids: string[]; index: number; pos: number; shuffle: boolean; repeat: RepeatMode; }
interface Persisted { folders: string[]; eq: EqPreset; volume: number; eqFreqs?: number[]; eqQs?: number[]; resumeId?: string; resumePos?: number; session?: Session; lastTab?: Tab; }
function loadPersisted(): Persisted {
  try {
    const p = JSON.parse(localStorage.getItem(LS) || "");
    const folders: string[] = Array.isArray(p.folders) ? p.folders : (p.folder ? [p.folder] : []); // migrate single folder
    return {
      folders, eq: p.eq ?? EQ_PRESETS[0], volume: typeof p.volume === "number" ? p.volume : 1,
      eqFreqs: Array.isArray(p.eqFreqs) && p.eqFreqs.length === EQ_FREQS.length ? p.eqFreqs : undefined,
      eqQs: Array.isArray(p.eqQs) && p.eqQs.length === EQ_FREQS.length ? p.eqQs : undefined,
      resumeId: typeof p.resumeId === "string" ? p.resumeId : undefined,
      resumePos: typeof p.resumePos === "number" ? p.resumePos : undefined,
      lastTab: typeof p.lastTab === "string" ? p.lastTab as Tab : undefined,
      session: p.session && Array.isArray(p.session.ids) ? {
        ids: p.session.ids.filter((x: unknown) => typeof x === "string"),
        index: typeof p.session.index === "number" ? p.session.index : 0,
        pos: typeof p.session.pos === "number" ? p.session.pos : 0,
        shuffle: !!p.session.shuffle,
        repeat: (p.session.repeat === "all" || p.session.repeat === "one") ? p.session.repeat : "off",
      } : undefined,
    };
  } catch { /* default */ }
  return { folders: [], eq: EQ_PRESETS[0], volume: 1 };
}
// Remember the current track + position so "Resume on startup" can restore it. Throttled (writing
// localStorage on every ~4Hz timeupdate would be wasteful); call with force=true on pause / app close.
// Saving the whole queue id-list on every tick would be wasteful, so the throttled path only nudges
// the position/index forward; the full session (ids + shuffle/repeat) is rewritten on `force` —
// i.e. on track change, pause and app close, which is when the queue can actually have changed.
const SESSION_CAP = 5000; // don't persist absurdly large queues
// Throttle the periodic (non-forced) resume write. Each one parses + RE-STRINGIFIES the whole session
// (up to SESSION_CAP track ids) on the main thread, so doing it every few seconds during playback is a
// real jank source. 10s granularity is plenty for crash-recovery; the exact position is still captured
// by the FORCED writes on track-change / pause / app-close. [perf]
const RESUME_THROTTLE = 10000;
let lastResumeSave = 0;
let lastSessionQueue: Track[] | null = null; // queue ref whose ids are already serialized into p.session
function saveResume(get: () => PlayerState, force = false) {
  const now = Date.now();
  if (!force && now - lastResumeSave < RESUME_THROTTLE) return;
  const s = get();
  const t = s.current();
  if (!t) return;
  lastResumeSave = now;
  const p = loadPersisted();
  const pos = Math.floor(engine.currentTime);
  // Rebuild the (up-to-SESSION_CAP-id) session list ONLY when the queue actually changed. Skipping or
  // tapping another track WITHIN the same queue keeps identical ids — so we just nudge index/pos/flags
  // instead of re-mapping + re-stringifying thousands of path strings. That rebuild was the main
  // synchronous hitch after tapping a track. (Queues are immutable here — a new ref ⇒ real change.) [perf]
  if (force && (s.queue !== lastSessionQueue || !p.session)) {
    p.session = { ids: s.queue.slice(0, SESSION_CAP).map((q) => q.id), index: Math.min(s.index, SESSION_CAP - 1), pos, shuffle: s.shuffle, repeat: s.repeat };
    lastSessionQueue = s.queue;
  } else if (p.session) {
    p.session.pos = pos; p.session.index = Math.min(s.index, SESSION_CAP - 1);
    p.session.shuffle = s.shuffle; p.session.repeat = s.repeat;
  }
  savePersisted({ ...p, resumeId: t.id, resumePos: pos });
}
// Defer a forced resume write off the track-change critical path so a tap → player switch paints first,
// and coalesce rapid skips into one write. flushResume() (pause / app close) still writes synchronously.
let resumeSaveTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleResumeSave(get: () => PlayerState) {
  if (resumeSaveTimer) clearTimeout(resumeSaveTimer);
  resumeSaveTimer = setTimeout(() => { resumeSaveTimer = undefined; saveResume(get, true); }, 500);
}
function savePersisted(p: Persisted) { try { localStorage.setItem(LS, JSON.stringify(p)); } catch { /* ignore */ } }
/** The tab the app was on when it last exited (for startScreen = "last"). undefined on a fresh install. */
export function lastExitTab(): Tab | undefined { return loadPersisted().lastTab; }

interface PlayerState {
  tab: Tab;
  prevTab: Tab; // the tab the player was opened from → leavePlayer() returns here
  revealNonce: number; // bumped to ask the Library to scroll to the current track
  revealCurrent: () => void;
  library: Track[];
  queue: Track[];
  index: number; // index into queue
  playing: boolean;
  position: number; // seconds
  duration: number; // seconds
  loop: { start: number; end: number } | null; // beat-quantized hold-to-loop region (seconds)
  // Endless Set (Tier-1 #1): an active beatmatched/key-aware auto-DJ over the queue. Each entry is
  // the planned transition OUT of the queue track at the same index (null = play to the end normally).
  endless: { transitions: (EndlessTransition | null)[]; flow: number; skipped: number } | null;
  endlessBuilding: boolean;
  repeat: RepeatMode;
  shuffle: boolean;
  stopAfterCurrent: boolean; // one-shot: pause when the current track ends (auto-advance only), then clear
  volume: number;
  scanning: boolean;
  hydrated: boolean; // the initial cache load has finished — gates the "No music yet" empty state
  scanInfo: string; // quiet inline indexing status (no toast)
  folders: string[];

  // EQ
  eqEnabled: boolean;
  preamp: number;
  bands: number[];
  bandFreqs: number[];   // per-band centre frequency (Advanced)
  bandQs: number[];      // per-band Q / "width" / shape (Advanced)
  presetName: string;

  current: () => Track | null;

  setTab: (t: Tab) => void;
  leavePlayer: () => void;
  artistJump: string | null; // transient: "Go to artist" → Library opens this artist's detail, then clears
  goToArtist: (artist: string) => void;
  clearArtistJump: () => void;
  folderJump: string | null; // transient: "Go to folder" → Library opens that folder's detail, then clears
  goToFolder: (folder: string) => void;
  clearFolderJump: () => void;
  albumJump: { album: string; artist?: string } | null; // transient: "Go to album" → Library opens it, then clears
  goToAlbum: (album: string, artist?: string) => void;
  clearAlbumJump: () => void;
  yearJump: number | null; // transient: "Go to year" → Library opens that year's songs, then clears
  goToYear: (year: number) => void;
  clearYearJump: () => void;
  setLibrary: (t: Track[]) => void;
  updateTrackMeta: (id: string, patch: Partial<Track>) => void;
  removeTracks: (ids: string[]) => void;
  addTracks: (t: Track[]) => void;
  loadFolder: () => Promise<void>;
  removeFolder: (path: string) => void;
  rescan: (auto?: boolean) => Promise<void>;
  watchIndexing: () => void; // Android: poll the background indexing service + load its results
  cancelIndexing: () => void; // stop the background scan + the poll loop
  loadMediaStore: (auto?: boolean) => Promise<void>; // Android: instant full-library scan via MediaStore (paged)
  addFolderFromMediaStore: (treeUri: string) => Promise<boolean>; // Android: merge one picked folder's songs (fast, tagged). false = not on primary storage → caller falls back
  addMediaStoreFolderPath: (relPath: string, volume?: string) => Promise<void>; // Android: merge a folder (by RELATIVE_PATH, optionally scoped to a storage VOLUME_NAME) into the library
  playSource: string; // label of where the current queue came from (album/playlist/folder/territory…) — for "reveal source"
  playFrom: (queue: Track[], index: number, source?: string) => Promise<void>;
  playTrack: (t: Track, opts?: { instant?: boolean }) => Promise<void>;
  jumpTo: (index: number) => Promise<void>;
  addToQueue: (tracks: Track[]) => void;
  playNext: (tracks: Track[]) => void;
  removeFromQueue: (index: number) => void;
  moveInQueue: (from: number, to: number) => void;
  clearQueue: () => void;
  shuffleQueue: () => void;
  clearUpcoming: () => void;
  dedupeQueue: () => void;
  toggle: () => void;
  /** Restore the last-played track (paused, at its saved position) — called once after the library hydrates. */
  resumeLast: () => Promise<void>;
  /** Persist the current track + position immediately (e.g. on app close). */
  flushResume: () => void;
  startEndlessSet: (seed?: Track, pool?: Track[]) => Promise<void>;
  stopEndlessSet: () => void;
  next: (auto?: boolean) => Promise<void>;
  prev: () => Promise<void>;
  /** Toggle the one-shot "stop after this track" flag (pauses at the natural end, then clears). */
  setStopAfterCurrent: (on: boolean) => void;
  seek: (sec: number) => void;
  setLoop: (r: { start: number; end: number } | null) => void;
  cycleRepeat: () => void;
  toggleShuffle: () => void;
  setVolume: (v: number) => void;
  // EQ actions
  setBand: (i: number, db: number) => void;
  setEqFreq: (i: number, hz: number) => void;
  setEqQ: (i: number, q: number) => void;
  resetEqBand: (i: number) => void;
  setPreamp: (db: number) => void;
  setEqEnabled: (on: boolean) => void;
  applyPreset: (p: EqPreset) => void;
  applyParametric: (name: string, filters: { fc: number; gain: number; q: number }[], preamp: number) => void;
  /** The current EQ as a full snapshot (for pinning to a song). */
  currentEqSnapshot: () => EqSnapshot;
  /** Push a full EQ snapshot to the engine + UI. `persist` false = transient (a per-song override). */
  applyEqSnapshot: (snap: EqSnapshot, persist?: boolean) => void;
  /** Analyse the current track and apply a corrective AutoEq curve. Returns false if unavailable. */
  autoEqCurrent: () => Promise<boolean>;
  /** Pin the current EQ to a song so it auto-applies on playback (Poweramp "Apply to songs"). */
  pinEqToSong: (id: string) => void;
  unpinEqFromSong: (id: string) => void;
  /** Re-resolve which EQ applies for `track`: per-song pin → AutoEq (if enabled) → your base EQ. */
  resolveSongEq: (track: Track) => void;
  // internal
  _syncTime: () => void;
}

const init = loadPersisted();

// Module-level handle for the Android background-indexing poll loop (kept out of state).
let indexTimer: number | null = null;

// ── taste event hooks: track the current playback "session" so each transition emits a
// play/skip signal to the taste engine (Phase 5). `tasteEnded` distinguishes a natural finish
// (→ FullPlay) from a user skip (graded by how far it got).
let tasteActiveId: string | null = null;
let tasteMaxPos = 0;
let tasteEnded = false;
let loopRaf = 0; // rAF handle for tight (~60Hz) hold-to-loop enforcement
let playGen = 0; // bumped on every playTrack; stale async loads (rapid skipping) check & bail
let prefetchTimer: ReturnType<typeof setTimeout> | undefined; // deferred next/prev warm (avoid SD I/O contention at track start)
let crossfadeFiredFor = -1; // queue index whose end-crossfade already started (fire once per track)
let lastSwitchAt = 0; // ts of the last track switch — a fast follow-up cuts instantly (no stacked crossfades)
let playingTrack: Track | null = null; // the track currently loaded in the engine — for the same-album crossfade rule
let duckPrevVol = -1;       // volume saved before an audio-focus duck (-1 = not ducked)
let pausedByFocus = false;  // we paused on a focus loss → eligible to auto-resume on regain

/** Two tracks belong to the same album (so a Poweramp-style gapless join applies between them). */
function sameAlbum(a: Track, b: Track): boolean {
  const al = (a.album || "").trim().toLowerCase();
  if (!al || al === "folder" || al === "unknown album") return false;
  if (al !== (b.album || "").trim().toLowerCase()) return false;
  const aa = (a.albumArtist || a.artist || "").trim().toLowerCase();
  const ba = (b.albumArtist || b.artist || "").trim().toLowerCase();
  return aa === ba;
}

/** Warm the source URL for the tracks adjacent to the current one so the next skip is instant. Only
 *  the slow content:// read does real work; everything else is a cheap no-op. */
function prefetchNeighbors(get: () => PlayerState): void {
  const { queue, index, shuffle } = get();
  if (index < 0 || !queue.length) return;
  if (index + 1 < queue.length) {
    const next = queue[index + 1].path;
    prefetchFileUrl(next);
    // Buffer the next track into the engine's IDLE deck so a forward skip is an instant deck-swap (no
    // fetch/decode wait). Resolve to the same cached URL playTrack will use, so load() takes the fast
    // path. [perf — skip]
    void fileUrl(next).then((url) => engine.preloadNext(url)).catch(() => { /* best-effort */ });
  }
  if (!shuffle && index - 1 >= 0) prefetchFileUrl(queue[index - 1].path); // Prev (only meaningful in order)
}

// ── Endless Set executor: fire each planned transition once, at its out_at ────
let endlessFiredFor = -1;   // queue index whose transition has already triggered (fire-once)
let endlessAdvancing = false; // re-entrancy guard while a crossfade is in flight
async function maybeAdvanceEndless() {
  const st = usePlayer.getState();
  const e = st.endless;
  if (!e || endlessAdvancing) return;
  const i = st.index;
  if (i < 0 || i >= st.queue.length - 1) return; // last track has nothing to mix into
  if (endlessFiredFor === i) return;
  const tr = e.transitions[i];
  if (!tr) return; // this stop plays out normally (handled by onEnded → next)
  const pos = engine.currentTime;
  const dur = engine.duration || 0;
  // out_at is seconds into the current track; clamp so a bogus value can't fire instantly or never.
  const trigger = tr.out_at > 0 ? Math.min(tr.out_at, dur > 0 ? dur - 0.2 : tr.out_at)
                                : (dur > 0 ? Math.max(0, dur - tr.overlap_secs) : Infinity);
  if (pos < trigger) return;
  const next = st.queue[i + 1];
  if (!next) return;
  endlessFiredFor = i;       // mark before awaiting so the next tick won't double-fire
  endlessAdvancing = true;
  try {
    finalizeTaste();         // emit the outgoing track's play signal
    void import("@/store/ratings").then((m) => m.useRatings.getState().bumpPlay(next.id));
    void import("@/store/playLog").then((m) => m.usePlayLog.getState().logPlay(next)); // adaptive time-of-day learning
    const ms = Math.max(200, tr.overlap_secs * 1000);
    if (engine.isNative()) {
      await engine.crossfadeToNext(next.path, ms);
    } else {
      // Web Audio fallback: a master-gain fade (no true overlap, but the journey order still holds).
      const url = await fileUrl(next.path);
      await engine.fadeTo(0, ms / 2);
      await engine.load(url, true, next.path, next.streaming);
      void engine.fadeTo(1, ms / 2);
    }
    const { useSettings } = await import("@/store/settings");
    useSettings.getState().applyAudio();
    tasteActiveId = next.id; tasteMaxPos = 0; tasteEnded = false;
    usePlayer.setState({ index: i + 1, position: 0, duration: next.duration || 0, loop: null });
  } catch { /* leave the natural onEnded → next() to recover */ } finally {
    endlessAdvancing = false;
  }
}

function finalizeTaste() {
  const id = tasteActiveId;
  if (!id) return;
  const dur = engine.duration || 0;
  const played = Math.max(tasteMaxPos, engine.currentTime || 0);
  const ended = tasteEnded;
  tasteActiveId = null; tasteMaxPos = 0; tasteEnded = false;
  taste.reportPlayback(id, played, dur, ended);
  // Negative-feedback loop: bailing early on a non-trivial track is a soft "not now" → the recommender
  // lowers that track/artist's affinity over time.
  if (!ended && dur > 30 && played / dur < 0.2) {
    void import("@/store/ratings").then((m) => m.useRatings.getState().bumpSkip(id));
  }
  // Build the taste profile from what you ACTUALLY listen to: once you've heard a good chunk,
  // fingerprint that one track in the background. Incremental + cheap — no whole-library grind.
  if (ended || (dur > 0 && played / dur >= 0.5)) maybeAnalyzeOnPlay(id);
}

// Analyze-on-play: one track at a time, in the background, de-duped, gated by the user setting.
const analyzeOnPlayInFlight = new Set<string>();
async function maybeAnalyzeOnPlay(id: string) {
  if (!hasTauri || analyzeOnPlayInFlight.has(id)) return;
  const t = usePlayer.getState().queue.find((x) => x.id === id) ?? usePlayer.getState().library.find((x) => x.id === id);
  if (!t) return;
  const st = useSettings.getState();
  if (!st.tasteAutoAnalyze && !st.autoTag) return;
  analyzeOnPlayInFlight.add(id);
  try {
    if (st.tasteAutoAnalyze) {
      const { analyzeOne, tasteOpts } = await import("@/lib/tasteIngest");
      await analyzeOne(t, tasteOpts(st.tastePerf)); // persists; regroup happens on demand
    }
    if (st.autoTag) {
      const { autoTagTrack } = await import("@/lib/tagEnrich"); // background tag enrichment while playing
      await autoTagTrack(t);
    }
  } catch { /* best-effort */ } finally { analyzeOnPlayInFlight.delete(id); }
}

// ── Background coverage analyzer ───────────────────────────────────────────────
// Vibe search / moods / personalized picks only rank over FINGERPRINTED tracks. Analyze-on-play only
// covers what you play; this fills the long tail so results keep getting better. Runs ONLY while
// PAUSED + visible (never competes with playback), bounded per tick, highest-priority tracks first.
let idleStarted = false;
let idleQueue: Track[] | null = null;
let idleIdx = 0, idleLibLen = -1, idleComplete = false, idleBusy = false;
const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function idleAnalyzeStep() {
  if (idleBusy || !hasTauri || !useSettings.getState().tasteAutoAnalyze) return;
  if (useSettings.getState().analysisMode === "off" || analysisPaused()) return; // disabled, or auto-paused while skipping
  const st = usePlayer.getState();
  if (st.playing || !st.hydrated || st.scanning || st.library.length === 0) return;
  if (typeof document !== "undefined" && document.hidden) return;
  idleBusy = true;
  try {
    // (re)build the priority queue whenever the library size changes (new music → resume coverage)
    if (idleQueue === null || st.library.length !== idleLibLen) {
      const { selectForAnalysis } = await import("@/lib/tasteIngest");
      const rt = await import("@/store/ratings");
      const stat = (id: string) => rt.useRatings.getState().stats[id] ?? { rating: 0, plays: 0, lastPlayed: 0 };
      idleQueue = selectForAnalysis(st.library, stat, 0);
      idleIdx = 0; idleLibLen = st.library.length; idleComplete = false;
      return;
    }
    if (idleComplete) return;
    const { analyzeOne, tasteOpts } = await import("@/lib/tasteIngest");
    const opts = tasteOpts(useSettings.getState().tastePerf);
    let added = 0, scanned = 0;
    while (idleIdx < idleQueue.length && scanned < 60 && added < 4) {
      if (usePlayer.getState().playing || (typeof document !== "undefined" && document.hidden) || !useSettings.getState().tasteAutoAnalyze || analysisPaused()) break;
      const t = idleQueue[idleIdx++]; scanned++;
      noteAnalysisActivity(); // tell the governor analysis is working, so it can pause us if the UI janks
      if (await analyzeOne(t, opts)) { added++; await sleepMs(300); } // 300ms gap keeps the UI smooth
    }
    if (idleIdx >= (idleQueue?.length ?? 0)) idleComplete = true; // full pass done; resumes when library grows
  } catch { /* best-effort */ } finally { idleBusy = false; }
}

/** Start the gentle background coverage analyzer (idempotent). Called once on app mount.
 *  Self-paced instead of a blind interval: each pass is scheduled via requestIdleCallback, so taste
 *  analysis only runs when the main thread is otherwise idle (never stealing time from scroll /
 *  animation / playback), and it backs WAY off once a full pass is done — a finished / locked /
 *  always-playing app isn't woken every few seconds for nothing. Re-engages within ~30s as the
 *  library grows. [bg perf] */
export function startIdleAnalysis(): void {
  if (idleStarted || typeof window === "undefined") return;
  idleStarted = true;
  const whenIdle = (cb: () => void, timeout: number) =>
    typeof window.requestIdleCallback === "function"
      ? window.requestIdleCallback(() => cb(), { timeout })
      : window.setTimeout(cb, Math.min(timeout, 1500));
  const loop = async () => {
    await idleAnalyzeStep();
    const next = idleComplete ? 30000 : 5000; // nothing left to do → idle hard; else keep sipping work
    window.setTimeout(() => whenIdle(loop, 4000), next);
  };
  whenIdle(loop, 6000);
}

export const usePlayer = create<PlayerState>((set, get) => ({
  tab: "library",
  prevTab: "library",
  revealNonce: 0,
  playSource: "",
  artistJump: null,
  library: [],
  queue: [],
  index: -1,
  playing: false,
  position: 0,
  duration: 0,
  loop: null,
  endless: null,
  endlessBuilding: false,
  repeat: "off",
  shuffle: false,
  stopAfterCurrent: false,
  volume: init.volume,
  scanning: false,
  hydrated: false,
  scanInfo: "",
  folders: init.folders,

  eqEnabled: init.eq.enabled,
  preamp: init.eq.preamp,
  bands: [...init.eq.gains],
  bandFreqs: init.eqFreqs ? [...init.eqFreqs] : [...EQ_FREQS],
  bandQs: init.eqQs ? [...init.eqQs] : new Array(EQ_FREQS.length).fill(1.1),
  presetName: init.eq.name,

  current: () => { const { queue, index } = get(); return index >= 0 ? queue[index] ?? null : null; },

  setTab: (t) => {
    // Remember the tab we came FROM when opening the player, so leaving it returns there exactly (the
    // Library keeps its own playlist/album/explore/group state mounted, so just switching back restores it).
    set((s) => ({ tab: t, prevTab: t === "playing" && s.tab !== "playing" ? s.tab : s.prevTab }));
    // Remember where the user was so "Resume last screen" (startScreen = "last") can restore it.
    // "search" is excluded — it needs a live query, so it's not a meaningful place to relaunch into.
    if (t !== "search") { const p = loadPersisted(); savePersisted({ ...p, lastTab: t }); }
  },
  /** Leave the player → back to wherever it was opened from (playlist/album/explore/home/songs…). */
  leavePlayer: () => {
    const p = get();
    p.setTab(p.prevTab && p.prevTab !== "playing" ? p.prevTab : "library");
  },
  /** Jump to the Library Songs list scrolled to the currently-playing track (tap the player cover). */
  revealCurrent: () => set((s) => ({ tab: "library", revealNonce: s.revealNonce + 1 })),
  goToArtist: (artist) => set({ artistJump: artist, tab: "library" }),
  clearArtistJump: () => set({ artistJump: null }),
  folderJump: null,
  goToFolder: (folder) => set({ folderJump: folder, tab: "library" }),
  clearFolderJump: () => set({ folderJump: null }),
  albumJump: null,
  goToAlbum: (album, artist) => set({ albumJump: { album, artist }, tab: "library" }),
  clearAlbumJump: () => set({ albumJump: null }),
  yearJump: null,
  goToYear: (year) => set({ yearJump: year, tab: "library" }),
  clearYearJump: () => set({ yearJump: null }),
  setLibrary: (library) => set({ library }),
  updateTrackMeta: (id, patch) => set((s) => ({
    library: s.library.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    queue: s.queue.map((t) => (t.id === id ? { ...t, ...patch } : t)),
  })),
  removeTracks: (ids) => set((s) => {
    const drop = new Set(ids);
    const library = s.library.filter((t) => !drop.has(t.id));
    const cur = s.index >= 0 ? s.queue[s.index] : null;
    const queue = s.queue.filter((t) => !drop.has(t.id));
    const index = cur && !drop.has(cur.id) ? queue.findIndex((t) => t.id === cur.id) : Math.min(s.index, queue.length - 1);
    return { library, queue, index: queue.length ? index : -1 };
  }),
  addTracks: (tracks) => set((s) => {
    const seen = new Set(s.library.map((t) => t.id));
    const fresh = tracks.filter((t) => !seen.has(t.id));
    return { library: [...s.library, ...fresh] };
  }),

  loadFolder: async () => {
    const folder = await pickMusicFolder();
    if (!folder) return;
    const folders = get().folders.includes(folder) ? get().folders : [...get().folders, folder];
    set({ folders });
    const p = loadPersisted(); savePersisted({ ...p, folders });
    await get().rescan();
  },

  removeFolder: (path) => {
    const folders = get().folders.filter((f) => f !== path);
    // drop that folder's tracks from the library + cache
    const library = get().library.filter((t) => !t.path.startsWith(path));
    set({ folders, library });
    const p = loadPersisted(); savePersisted({ ...p, folders });
    if (hasTauri) cacheSave(folders[0] ?? "", library);
  },

  rescan: async (auto = false) => {
    if (!hasTauri) { set({ library: demoTracks(), hydrated: true }); return; }
    // Android: the library is built by the background IndexingService, not walkdir. Load whatever
    // it has indexed to disk, and if a scan is still running, resume watching it.
    if (isAndroid) {
      // STREAM the cache in 2k batches so the list PAINTS after the first batch instead of waiting for
      // the whole 40k file to parse. `all` accumulates; `folder` is the meta marker.
      let folder = "";
      const all: Track[] = [];
      // Launch speed: paint the FIRST batch instantly so the list fills immediately, then DON'T
      // repaint mid-stream — each repaint re-sorts/re-groups the whole (up to 50k) library, and doing
      // that several times is the bulk of the "slow launch". The single final flush below shows the
      // complete list, so we sort the full library exactly once instead of ~N times.
      let painted = false;
      await cacheLoadStream(
        (f) => { folder = f; },
        (batch) => {
          for (const t of batch) all.push(t);
          if (!painted) { painted = true; set({ library: all.slice() }); }
        },
      );
      set({ library: all, hydrated: true }); // final flush (all is stable now — no need to copy 40k)
      const fromMs = folder === "mediastore-v2";

      // FAST PATH — already MediaStore-backed: do ONE cheap count query. MediaStore is the system's
      // always-current index, so if its count still matches the cache, NOTHING changed → no indexing.
      // Only when songs were added/removed (count differs) do we silently refresh.
      if (fromMs) {
        if (await hasMediaPermission()) {
          const { total } = await mediaStoreScan(0, 1);                 // 1 row + a count — milliseconds
          if (total > 0 && total !== all.length) void get().loadMediaStore(true); // changed → refresh
          else void enrichAndroidMeta();                                // unchanged → just top up tag-less rows
        }
        return;
      }

      // LEGACY/first-run path: merge the SAF index over the streamed cache, then upgrade to MediaStore
      // once (saves as "mediastore-v2", so future launches take the fast path above).
      const enriched = new Map(all.map((t) => [t.path, t] as const));
      const tracks: Track[] = [];
      for (let skip = 0; ; skip += 8000) {
        const chunk = await readIndex(skip, 8000);
        if (!chunk.length) break;
        for (const t of chunk) tracks.push(enriched.get(t.path) ?? t);
        if (chunk.length < 8000) break;
      }
      if (tracks.length) set({ library: tracks });
      const s = await indexStatus();
      if (s && s.exists && !s.done) get().watchIndexing();
      if (await hasMediaPermission()) void get().loadMediaStore(true); // upgrade to MediaStore (real tags)
      else void enrichAndroidMeta();
      return;
    }
    // 1) show the cached library instantly (no re-scan needed on launch). STREAM it in 2k batches —
    // the old cacheLoad() parsed + mapped the whole (40k+) file and did ONE giant render before the
    // list could paint; streaming paints the first batch right away and the screen fills immediately.
    if (get().library.length === 0) {
      const all: Track[] = [];
      let painted = false;
      await cacheLoadStream(
        () => {},
        (batch) => {
          for (const t of batch) all.push(t);
          // paint the first batch instantly for immediate content, then one final flush (below) — no
          // mid-stream repaints, so the full library is sorted/grouped once instead of repeatedly.
          if (!painted) { painted = true; set({ library: all.slice() }); }
        },
      );
      set({ library: all, hydrated: true }); // all is stable now — no need to copy 40k
    } else {
      set({ hydrated: true });
    }
    // On launch (`auto`), trust the cache — don't re-walk the whole tree every time. The user
    // refreshes new files with an explicit Rescan (Settings → Library). Avoids re-indexing 48k
    // files on every start.
    if (auto && get().library.length > 0) return;
    const folders = get().folders;
    if (!folders.length) return;
    if (get().scanning) return; // a scan is already running — don't start a concurrent one (corrupts the merge + cache)
    // 2) incremental scan across all folders: only new/modified files are tag-read; adds & removals merged
    set({ scanning: true, scanInfo: "Reading…" });
    // working set keyed by path, seeded from the cached library → batches upsert into it progressively
    const byPath = new Map(get().library.map((tr) => [tr.path, tr] as const));
    let pendingRender = 0; // throttle array rebuilds: only re-render the library every ~2k new tracks
    const fmtN = (n: number) => n.toLocaleString();
    try {
      // Launch is cache-only (auto). A manual Rescan/Reindex re-reads every file's tags (known=[])
      // so metadata fixes (e.g. filename-derived artists) reach already-cached tracks.
      const known = auto ? get().library.map((tr) => ({ path: tr.path, mtime: tr.mtime ?? null })) : [];
      const streamed = await scanLibraryStream(folders, known, (e) => {
        if (e.kind === "progress") {
          set({ scanInfo: `${fmtN(e.files)} songs · ${fmtN(e.folders)} folders` }); // quiet inline status, no toast
        } else if (e.kind === "batch") {
          for (const tr of e.changed) byPath.set(tr.path, tr);
          pendingRender += e.changed.length;
          if (pendingRender >= 2000) { pendingRender = 0; set({ library: [...byPath.values()] }); } // live, progressive fill
        } else {
          for (const p of e.removed) byPath.delete(p);
          const merged = [...byPath.values()];
          set({ library: merged });
          cacheSave(folders[0] ?? "", merged);
        }
      });
      if (!streamed) {
        // fallback (shouldn't happen under Tauri): one-shot diff
        const { changed, removed } = await scanLibraryDiff(folders, known);
        const removedSet = new Set(removed);
        for (const p of removedSet) byPath.delete(p);
        for (const tr of changed) byPath.set(tr.path, tr);
        const merged = [...byPath.values()];
        set({ library: merged });
        cacheSave(folders[0] ?? "", merged);
      }
    } catch {
      toast.error("Couldn't read your music folders."); // only failures get a toast
    } finally { set({ scanning: false, scanInfo: "" }); }
  },

  // Android: poll the foreground IndexingService → live count toast + progressively load its results.
  // Safe to call repeatedly (guarded by a module-level timer); also called on launch to resume a scan.
  watchIndexing: () => {
    if (indexTimer != null) return;
    set({ scanning: true });
    const t = toast.progress("Reading folder…", "scan");
    const fmtN = (n: number) => n.toLocaleString();
    let loaded = 0;          // how many index lines we've already pulled in — only fetch the delta
    let busy = false;        // don't overlap reads if one tick runs long
    let lastTs = -1;         // service heartbeat: detect a dead/killed scanner
    let lastChange = Date.now();
    const stopWatch = () => { if (indexTimer != null) { clearInterval(indexTimer); indexTimer = null; } set({ scanning: false }); };
    // Pull in BOUNDED chunks: a 40k-song library returned in one readIndex call is a multi-MB JSON
    // payload across the bridge + a 40k-element array build → OOM/crash. Loop 4k at a time, yielding.
    const PULL_CHUNK = 4000;
    const pull = async () => {
      for (;;) {
        const delta = await readIndex(loaded, PULL_CHUNK);
        if (!delta.length) break;
        get().addTracks(delta);
        loaded += delta.length;
        if (delta.length < PULL_CHUNK) break; // caught up to the writer
        await new Promise((r) => setTimeout(r, 0)); // yield so the UI/audio stay responsive
      }
    };
    const tick = async () => {
      if (busy) return;        // don't overlap a slow read with the next interval
      busy = true;
      try {
        const s = await indexStatus();
        if (!s || !s.exists) return; // service not up yet
        // stall detection — if the heartbeat hasn't advanced for 30s and we're not done, the
        // foreground service was killed (battery saver / swipe): stop spinning forever. (The service
        // beats every ~1.2s mid-scan, so 30s is a generous "really dead" threshold.)
        if (s.ts !== lastTs) { lastTs = s.ts; lastChange = Date.now(); }
        else if (!s.done && Date.now() - lastChange > 30000) {
          await pull();
          stopWatch();
          cacheSave("android", get().library);
          void enrichAndroidMeta(); // fill real artists for whatever DID index, even on a partial scan
          t.fail(`Indexing stopped at ${fmtN(s.files)} songs — tap “Scan all music (fast)” in Settings for the rest.`);
          return;
        }
        t.update(`Indexing… ${fmtN(s.files)} songs · ${fmtN(s.folders)} folders`);
        // Don't run heavy library loads WHILE music is playing (keeps playback smooth) — just tick the
        // count; pull the accumulated tracks when paused, and always settle once at done.
        if ((s.done || (!get().playing && s.files - loaded >= 4000)) && s.files > loaded) await pull();
        if (s.done) {
          stopWatch();
          cacheSave("android", get().library);
          t.done(`Library ready · ${fmtN(s.files)} songs · ${fmtN(s.folders)} folders`);
          void enrichAndroidMeta(); // fill real tags for the freshly-indexed (filename-only) tracks
        }
      } finally { busy = false; }
    };
    indexTimer = setInterval(() => { void tick(); }, 900) as unknown as number;
    void tick();
  },

  cancelIndexing: () => {
    if (indexTimer != null) { clearInterval(indexTimer); indexTimer = null; }
    set({ scanning: false });
    abortEnrich(); // stop any background tag sweep so it doesn't repopulate a wiped library
    void stopIndexing();
    const ts = useToasts.getState().toasts.find((t) => t.key === "scan");
    if (ts) useToasts.getState().dismiss(ts.id);
  },

  // Android FAST scan: pull the whole library straight from MediaStore (system-indexed, full tags) in
  // paged chunks. No SAF walk, no per-file MMR enrichment (tags arrive complete). This is the "beat
  // Poweramp" path — instant on 40k. Covers still lazy-load via coverArt() on first view.
  loadMediaStore: async (auto = false) => {
    if (!isAndroid || mediaScanning) return; // guard: ignore double-taps / overlapping runs
    // Permission gate: only PROMPT on an explicit tap. On an auto (launch) run, bail silently if the
    // user hasn't granted media access yet — never throw a dialog at them unprompted.
    if (!(await hasMediaPermission())) {
      if (!auto) { await requestMediaPermission(); toast.info("Allow music access, then tap “Scan all music” again."); }
      return;
    }
    mediaScanning = true;
    get().cancelIndexing();           // stop any SAF scan/enrich first
    const t = auto ? null : toast.progress("Scanning your music…", "scan");
    if (!auto) set({ scanning: true, scanInfo: "Reading library…" });
    const CHUNK = 5000;
    try {
      const all: Track[] = [];
      let grandTotal = 0;
      for (let off = 0; ; off += CHUNK) {
        const { tracks, total } = await mediaStoreScan(off, CHUNK);
        for (const tr of tracks) all.push(tr);
        set({ library: [...all], scanInfo: auto ? "" : `${all.length.toLocaleString()} songs` });
        if (off === 0 && total > 0) grandTotal = total; // true library size (only sent on the first page)
        t?.update(`Scanning your music… ${all.length.toLocaleString()}${grandTotal ? ` / ${grandTotal.toLocaleString()}` : ""}`);
        if (tracks.length < CHUNK) break; // short page = last page (don't trust per-page counts)
        await new Promise((r) => setTimeout(r, 0)); // yield so the UI stays live
      }
      set({ scanning: false, scanInfo: "" });
      cacheSave("mediastore-v2", all);  // persist → instant next launch; marker = has folder paths too
      t?.done(`Library ready · ${all.length.toLocaleString()} songs`);
    } catch {
      set({ scanning: false, scanInfo: "" });
      t?.fail("Quick scan failed.");
    } finally { mediaScanning = false; }
  },

  // Android: MERGE one picked folder's songs into the library via MediaStore (fast + real tags), scoped
  // to that folder + subfolders. Returns false if the folder isn't on primary storage (SD card) so the
  // caller can fall back to the slow SAF walk. Dedups by id, so re-adding a folder is harmless.
  addFolderFromMediaStore: async (treeUri) => {
    if (!isAndroid) return false;
    const rel = safTreeToRelPath(treeUri);
    if (rel === null) return false; // not primary shared storage → caller uses the SAF walk
    await get().addMediaStoreFolderPath(rel);
    return true;
  },

  addMediaStoreFolderPath: async (rel, volume) => {
    if (!isAndroid) return;
    if (!(await hasMediaPermission())) {
      await requestMediaPermission();
      toast.info("Allow music access, then add the folder again.");
      return;
    }
    const t = toast.progress("Adding folder…", "scan");
    const CHUNK = 5000;
    try {
      let added = 0;
      for (let off = 0; ; off += CHUNK) {
        const { tracks } = await mediaStoreScan(off, CHUNK, rel, volume);
        if (!tracks.length) break;
        const before = get().library.length;
        get().addTracks(tracks);              // appends + dedups by id
        added += get().library.length - before;
        t.update(`Adding folder… ${get().library.length.toLocaleString()} songs`);
        if (tracks.length < CHUNK) break;
        await new Promise((r) => setTimeout(r, 0));
      }
      cacheSave("mediastore-v2", get().library); // mark MediaStore-backed so launch won't auto-replace
      t.done(added > 0 ? `Added ${added.toLocaleString()} song${added === 1 ? "" : "s"}` : "Those songs are already in your library.");
    } catch { t.fail("Couldn't add that folder."); }
  },

  playFrom: async (queue, index, source = "") => {
    endlessFiredFor = -1;
    // Optionally jump straight to the full Now-Playing screen when starting a song (Settings → Playback →
    // "Open player on play"). Set the tab in the SAME update as the queue so it switches in one paint;
    // playTrack preserves whatever tab is current, so this sticks.
    const openPlayer = useSettings.getState().openPlayerOnPlay;
    set((s) => ({ queue, index, endless: null, playSource: source, ...(openPlayer ? { tab: "playing" as Tab, prevTab: s.tab !== "playing" ? s.tab : s.prevTab } : {}) })); // a user-chosen queue replaces any active Endless Set
    const t = queue[index];
    // Tapping a track is a DELIBERATE choice → play it now, no crossfade-out wait (that delay is for
    // natural track-ends only). Same snappiness as Next/Prev.
    if (t) await get().playTrack(t, { instant: true });
  },

  playTrack: async (t, opts) => {
    const myGen = ++playGen;                                        // newest request wins; stale async loads bail
    crossfadeFiredFor = -1;                                         // arm the end-crossfade for the new track
    void import("@/components/Cover").then((m) => m.deprioritizeCovers()); // let the new track buffer off (slow) storage before covers read it
    finalizeTaste();                                                // emit the outgoing track's play/skip signal
    const native = engine.isNative();
    const wasPlaying = get().playing;
    const manual = !!opts?.instant;                                 // a deliberate skip/tap (vs a natural-end advance, instant:false)
    const outgoing = playingTrack;                                  // what's currently in the engine (for the same-album rule)
    // Crossfade a transition — manual skip, pick-from-list, or natural end — when a track is already
    // playing, using the user's editable Transitions settings (Settings → Playback → Transitions: time +
    // curve). BUT a fast follow-up switch (skip-spam, or skipping mid-crossfade) CUTS instantly so blends
    // never stack/glitch; isolated switches + natural endings blend. `wasPlaying` gates out first-play.
    const cfg = useSettings.getState();
    const xfSet = cfg.crossfade;
    const now = Date.now();
    const rapid = now - lastSwitchAt < Math.max(600, xfSet * 1000); // a switch while the last blend is still going
    lastSwitchAt = now;
    // Rapid follow-ups (skip-spam / skipping mid-crossfade) use a SHORT blend — still smooth, never a
    // hard cut, but snappy and non-stacking. Isolated switches + natural endings use the full crossfade.
    let xf = rapid && xfSet > 0 ? Math.min(xfSet, 0.18) : xfSet;
    // Smart-crossfade rules (Poweramp): a manual skip can cut instantly, and consecutive tracks from the
    // same album play GAPLESS (no fade) so albums flow as authored.
    if (manual && !cfg.crossfadeManual) xf = 0;
    if (xf > 0 && !cfg.crossfadeSameAlbum && outgoing && sameAlbum(outgoing, t)) xf = 0;
    const curve = cfg.crossfadeCurve;
    const urlPromise = fileUrl(t.path);
    if (myGen !== playGen) return;
    const url = await urlPromise;
    if (myGen !== playGen) return;                                  // a newer track was requested while we resolved the URL
    engine.setVolume(get().volume);
    void import("@/store/ratings").then((m) => m.useRatings.getState().bumpPlay(t.id));
    void import("@/store/playLog").then((m) => m.usePlayLog.getState().logPlay(t)); // adaptive time-of-day learning
    // Real overlap crossfade into the new track when one was already playing; otherwise a clean load.
    if (xf > 0 && wasPlaying) {
      const ok = await engine.crossfadeToNext(native ? t.path : url, xf * 1000, curve);
      if (!ok) await engine.load(url, true, t.path, t.streaming);  // autoplay blocked etc. → hard load
    } else {
      await engine.load(url, true, t.path, t.streaming);           // <audio>/native decode + autoplay
    }
    if (myGen !== playGen) return;
    useSettings.getState().applyAudio();                            // re-assert speed/pitch on the new source
    playingTrack = t;                                               // now loaded in the engine (same-album rule reads this next switch)
    tasteActiveId = t.id; tasteMaxPos = 0; tasteEnded = false;      // arm the new playback session
    set({ playing: true, position: 0, duration: t.duration || 0, loop: null, tab: get().tab === "library" ? "library" : get().tab });
    scheduleResumeSave(get); // remember this track for "Resume on startup" — deferred off the tap path
    // Warm a small forward WINDOW of URL tokens RIGHT AWAY (each is cheap — a stream-token resolve, no
    // whole-file read), so RAPID forward-skipping resolves every track's URL instantly instead of paying
    // the resolve IPC round-trip per skip. Dedup-guarded inside prefetchFileUrl. In shuffle the "next" is
    // random so only the single immediate candidate is worth warming. [perf — skip]
    { const { queue: q, index: i, shuffle: sh } = get();
      const window = sh ? 1 : 3;
      for (let k = 1; k <= window && i + k < q.length; k++) prefetchFileUrl(q[i + k].path); }
    // The fuller neighbour warm (prev too, and the blob-fallback whole-file read on no-stream devices)
    // stays DELAYED until the current track is stably buffered, cancelled if the user skips again first —
    // keeps the track-start window free of competing SD reads. [perf — SD I/O]
    if (prefetchTimer) clearTimeout(prefetchTimer);
    prefetchTimer = setTimeout(() => { if (playGen === myGen) prefetchNeighbors(get); }, 2500);
  },

  jumpTo: async (index) => {
    const { queue } = get();
    if (index < 0 || index >= queue.length) return;
    endlessFiredFor = -1; // let this stop's own transition fire later (at its out_at), not immediately
    set({ index });
    await get().playTrack(queue[index], { instant: true });
  },

  addToQueue: (tracks) => set((s) => {
    if (!tracks.length) return {};
    tracks.forEach((t) => void taste.recordEvent(t.id, "AddedManually")); // explicit "I want this" signal
    const queue = [...s.queue, ...tracks];
    // if nothing is loaded yet, point the index at the first added track
    return s.index < 0 ? { queue, index: s.queue.length } : { queue };
  }),

  playNext: (tracks) => set((s) => {
    if (!tracks.length) return {};
    tracks.forEach((t) => void taste.recordEvent(t.id, "AddedManually"));
    if (s.index < 0) return { queue: [...tracks], index: 0 };
    const queue = [...s.queue];
    queue.splice(s.index + 1, 0, ...tracks);
    return { queue };
  }),

  removeFromQueue: (index) => set((s) => {
    if (index < 0 || index >= s.queue.length) return {};
    const queue = s.queue.filter((_, i) => i !== index);
    let ni = s.index;
    if (index < s.index) ni = s.index - 1;        // shift current back
    else if (index === s.index) ni = Math.min(s.index, queue.length - 1); // removed current
    return { queue, index: queue.length ? ni : -1 };
  }),

  moveInQueue: (from, to) => set((s) => {
    const n = s.queue.length;
    if (from < 0 || from >= n || to < 0 || to >= n || from === to) return {};
    const queue = [...s.queue];
    const [moved] = queue.splice(from, 1);
    queue.splice(to, 0, moved);
    // keep `index` pointing at the same logical current track
    let ni = s.index;
    if (s.index === from) ni = to;
    else if (from < s.index && to >= s.index) ni = s.index - 1;
    else if (from > s.index && to <= s.index) ni = s.index + 1;
    return { queue, index: ni };
  }),

  clearQueue: () => { finalizeTaste(); endlessFiredFor = -1; playingTrack = null; set({ queue: [], index: -1, playing: false, endless: null }); },

  // Shuffle only the UPCOMING tracks (everything after the current one stays put + keeps playing).
  shuffleQueue: () => set((s) => {
    if (s.queue.length < 3) return {};
    const head = s.queue.slice(0, Math.max(0, s.index + 1));
    const tail = s.queue.slice(Math.max(0, s.index + 1));
    for (let i = tail.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [tail[i], tail[j]] = [tail[j], tail[i]]; }
    return { queue: [...head, ...tail], endless: null };
  }),

  // Remove everything AFTER the current track (keep the current one playing).
  clearUpcoming: () => set((s) => {
    if (s.index < 0 || s.index >= s.queue.length - 1) return {};
    return { queue: s.queue.slice(0, s.index + 1), endless: null };
  }),

  // Drop duplicate tracks (keep the first occurrence); re-anchor the index onto the current track.
  dedupeQueue: () => set((s) => {
    const cur = s.index >= 0 ? s.queue[s.index] : null;
    const seen = new Set<string>();
    const queue = s.queue.filter((t) => (seen.has(t.id) ? false : (seen.add(t.id), true)));
    const index = cur ? Math.max(0, queue.findIndex((t) => t.id === cur.id)) : s.index;
    return { queue, index, endless: null };
  }),

  toggle: () => {
    const st = useSettings.getState();
    if (engine.paused) {
      // resuming: optionally jump back a few seconds so you re-hear context, then fade in
      if (st.rewindOnResume > 0) { const back = Math.max(0, engine.currentTime - st.rewindOnResume); engine.seek(back); set({ position: back }); }
      void engine.play();
      if (!engine.isNative()) { if (st.fadeOnPause) { void engine.fadeTo(0, 0); void engine.fadeTo(1, 220, "equal"); } else void engine.fadeTo(1, 0); }
    } else {
      saveResume(get, true); // remember exactly where we paused
      if (st.fadeOnPause && !engine.isNative()) { void engine.fadeTo(0, 200, "equal").then(() => engine.pause()); }
      else engine.pause();
    }
  },

  resumeLast: async () => {
    const st = useSettings.getState();
    if (!st.resumeOnStart) return;
    if (get().queue.length || get().playing) return; // user already started something
    const p = loadPersisted();
    const lib = get().library;
    let queue: Track[] = [];
    let index = 0;
    let pos = 0;
    // Full session: rebuild the whole queue (by id) + restore shuffle/repeat.
    if (st.resumeScope === "session" && p.session && p.session.ids.length) {
      const byId = new Map(lib.map((x) => [x.id, x] as const));
      queue = p.session.ids.map((id) => byId.get(id)).filter((x): x is Track => !!x);
      if (queue.length) {
        // the saved index points into the original list; map it onto the (possibly shrunk) queue via id
        const savedId = p.session.ids[p.session.index];
        const mapped = savedId ? queue.findIndex((t) => t.id === savedId) : -1;
        index = mapped >= 0 ? mapped : Math.min(Math.max(0, p.session.index), queue.length - 1);
        pos = Math.max(0, p.session.pos || 0);
        set({ shuffle: p.session.shuffle, repeat: p.session.repeat });
      }
    }
    // Track-only scope, or no usable session → restore just the last track.
    if (!queue.length) {
      if (!p.resumeId) return;
      const t = lib.find((x) => x.id === p.resumeId);
      if (!t) return;
      queue = [t]; index = 0; pos = Math.max(0, p.resumePos || 0);
    }
    const cur = queue[index];
    if (!cur) return;
    try {
      const url = await fileUrl(cur.path);
      if (get().queue.length || get().playing) return; // a track loaded while we resolved the URL
      set({ queue, index, position: pos, duration: cur.duration || 0 });
      engine.setVolume(get().volume);
      if (engine.isNative()) { await engine.load(url, false, cur.path, cur.streaming); if (pos > 0) engine.seek(pos); }
      else {
        if (pos > 0) engine.el.addEventListener("loadedmetadata", () => engine.seek(pos), { once: true });
        await engine.load(url, false, cur.path, cur.streaming);
      }
    } catch { /* best-effort: a missing/moved file just leaves nothing loaded */ }
  },

  flushResume: () => { if (resumeSaveTimer) { clearTimeout(resumeSaveTimer); resumeSaveTimer = undefined; } saveResume(get, true); },

  // ── Endless Set: build a beatmatched/key-aware journey and play it ──────────
  // Uses the native analysis cache (tempo/key/sections) to order a pool of tracks so each hand-off
  // is the smoothest available, then drives auto-crossfades at the planned points (native engine).
  // Falls back gracefully on Web Audio (ordering still applies; transitions use the normal crossfade).
  startEndlessSet: async (seed, pool) => {
    if (!hasTauri) { toast.info("Endless Set needs the desktop/app build."); return; }
    if (get().endlessBuilding) return;
    const base = (pool && pool.length ? pool : get().library).filter((t) => t.path);
    if (base.length < 2) { toast.info("Add more music to build an Endless Set."); return; }
    // Cap the working pool so analysis + O(n²) ordering stay snappy; seed leads the candidate list.
    const CAP = 60;
    const seen = new Set<string>();
    const candidates: Track[] = [];
    if (seed) { candidates.push(seed); seen.add(seed.path); }
    for (const t of base) {
      if (candidates.length >= CAP) break;
      if (!seen.has(t.path)) { candidates.push(t); seen.add(t.path); }
    }
    const byPath = new Map(candidates.map((t) => [t.path, t] as const));
    set({ endlessBuilding: true });
    const prog = toast.progress("Building your Endless Set…", "endless");
    try {
      // Make sure the pool is analyzed (tempo/key/sections); skips already-cached tracks.
      await analyzeTracksNative(candidates.map((t) => t.path), (done, total) => {
        prog.update(`Analyzing tracks… ${done}/${total}`);
      });
      prog.update("Planning transitions…");
      const res = await buildEndlessSet(candidates.map((t) => t.path), seed?.path);
      if (!res || res.set.stops.length < 2) {
        prog.fail("Couldn't build a set — try analyzing more tracks first.");
        set({ endlessBuilding: false });
        return;
      }
      const queue = res.set.stops.map((s) => byPath.get(s.id)).filter((t): t is Track => !!t);
      const transitions = res.set.stops.map((s) => s.transition);
      endlessFiredFor = -1;
      set({ queue, index: 0, endless: { transitions, flow: res.set.flow, skipped: res.skipped }, endlessBuilding: false });
      await get().playTrack(queue[0]);
      const pct = Math.round(res.set.flow * 100);
      prog.done(`Endless Set ready · ${queue.length} tracks · ${pct}% flow`);
    } catch {
      prog.fail("Couldn't build the Endless Set.");
      set({ endlessBuilding: false });
    }
  },

  stopEndlessSet: () => { endlessFiredFor = -1; set({ endless: null }); },

  next: async (auto = false) => {
    const { queue, index, repeat, shuffle, stopAfterCurrent } = get();
    if (!queue.length) return;
    if (auto && repeat === "one") { engine.seek(0); engine.play(); return; }
    // Stop-after-current: a one-shot that halts at this track's natural end (auto-advance only), then clears.
    if (auto && stopAfterCurrent) { set({ playing: false, stopAfterCurrent: false }); engine.pause(); return; }
    let ni: number;
    if (shuffle) ni = Math.floor(Math.random() * queue.length);
    else ni = index + 1;
    if (ni >= queue.length) {
      if (repeat === "all") ni = 0;
      // End of the queue with repeat off. Either stop, or (Poweramp "never stop the music") keep going
      // by auto-building an Endless Set seeded from what just played. Only on a natural end, not a manual skip.
      else if (auto && useSettings.getState().queueEndAction === "endless") { void get().startEndlessSet(); return; }
      else { set({ playing: false }); engine.pause(); return; }
    }
    endlessFiredFor = -1; // the new current's transition fires at its own out_at, not now
    set({ index: ni });
    // Silence Between Tracks (Poweramp): on a NATURAL advance with no crossfade, hold a beat of silence
    // before the next track. Skipped for manual skips and when crossfade is on (the overlap is the join).
    const gap = useSettings.getState().trackGap;
    if (auto && gap > 0 && useSettings.getState().crossfade === 0) { engine.pause(); await sleepMs(gap); }
    await get().playTrack(queue[ni], { instant: !auto }); // manual skip = instant; natural end = crossfade
  },

  setStopAfterCurrent: (on) => set({ stopAfterCurrent: on }),

  prev: async () => {
    const { queue, index } = get();
    if (!queue.length) return;
    if (engine.currentTime > 3) { engine.seek(0); return; }
    const ni = index <= 0 ? queue.length - 1 : index - 1;
    endlessFiredFor = -1;
    set({ index: ni });
    await get().playTrack(queue[ni], { instant: true });
  },

  seek: (sec) => {
    // Fade on Seek (Poweramp): dip + restore the gain around a JUMP (>1.5s) so it doesn't click. The
    // >1.5s guard skips fine scrubbing (many tiny seeks) so a drag stays smooth, not choppy.
    if (useSettings.getState().fadeOnSeek && get().playing && !engine.isNative() && Math.abs(sec - engine.currentTime) > 1.5) {
      void engine.fadeTo(0, 60, "equal").then(() => { engine.seek(sec); void engine.fadeTo(1, 150, "equal"); });
    } else {
      engine.seek(sec);
    }
    set({ position: sec });
  },
  setLoop: (r) => {
    if (r) {
      const p = engine.currentTime;
      if (p < r.start || p >= r.end) { engine.seek(r.start); set({ position: r.start }); } // jump into the loop bar
    }
    set({ loop: r });
    // Native engine loops sample-accurately in the audio callback (no seam click) — no rAF needed.
    if (engine.setLoopRegion(r)) {
      if (loopRaf) { cancelAnimationFrame(loopRaf); loopRaf = 0; }
      return;
    }
    if (loopRaf) { cancelAnimationFrame(loopRaf); loopRaf = 0; }
    if (r && typeof requestAnimationFrame !== "undefined") {
      // tight ~60Hz enforcement (the media element's timeupdate is only ~4Hz → too loose for a bar loop).
      const tick = () => {
        const lp = usePlayer.getState().loop;
        if (!lp) { loopRaf = 0; return; }
        if (engine.currentTime >= lp.end) engine.seek(lp.start);
        loopRaf = requestAnimationFrame(tick);
      };
      loopRaf = requestAnimationFrame(tick);
    }
  },

  cycleRepeat: () => set((s) => ({ repeat: s.repeat === "off" ? "all" : s.repeat === "all" ? "one" : "off" })),
  toggleShuffle: () => set((s) => ({ shuffle: !s.shuffle })),

  setVolume: (v) => {
    engine.setVolume(v);
    set({ volume: v });
    persistVolume(v); // debounced — the slider drag fires this per pointermove; only persist once it settles
  },

  setBand: (i, db) => {
    engine.setBand(i, db);
    set((s) => { const bands = [...s.bands]; bands[i] = db; return { bands, presetName: "Custom" }; });
    persistEq(get);
  },
  setEqFreq: (i, hz) => {
    engine.setEqFreq(i, hz);
    set((s) => { const bandFreqs = [...s.bandFreqs]; bandFreqs[i] = hz; return { bandFreqs }; });
    persistEq(get);
  },
  setEqQ: (i, q) => {
    engine.setEqQ(i, q);
    set((s) => { const bandQs = [...s.bandQs]; bandQs[i] = q; return { bandQs }; });
    persistEq(get);
  },
  resetEqBand: (i) => {
    engine.setEqFreq(i, EQ_FREQS[i]); engine.setEqQ(i, 1.1); engine.setBand(i, 0);
    set((s) => {
      const bandFreqs = [...s.bandFreqs]; bandFreqs[i] = EQ_FREQS[i];
      const bandQs = [...s.bandQs]; bandQs[i] = 1.1;
      const bands = [...s.bands]; bands[i] = 0;
      return { bandFreqs, bandQs, bands, presetName: "Custom" };
    });
    persistEq(get);
  },
  setPreamp: (db) => { engine.setPreamp(db); set({ preamp: db }); persistEq(get); },
  setEqEnabled: (on) => { engine.setEqEnabled(on); set({ eqEnabled: on }); persistEq(get); },
  applyPreset: (p) => {
    engine.applyPreset(p.gains, p.preamp, p.enabled);
    set({ bands: [...p.gains], preamp: p.preamp, eqEnabled: p.enabled, presetName: p.name });
    persistEq(get);
  },

  /** Apply a full parametric set (e.g. an imported AutoEq headphone curve) across the 10 bands:
   *  per-band freq + Q + gain + preamp. Filters beyond 10 are dropped; unused bands go flat. */
  applyParametric: (name, filters, preamp) => {
    const n = EQ_FREQS.length;
    const fr = [...get().bandFreqs], qs = [...get().bandQs], gn = [...get().bands];
    for (let i = 0; i < n; i++) {
      const f = filters[i];
      fr[i] = f ? f.fc : EQ_FREQS[i];
      qs[i] = f ? Math.max(0.1, f.q) : 1.1;
      gn[i] = f ? f.gain : 0;
      engine.setEqFreq(i, fr[i]); engine.setEqQ(i, qs[i]); engine.setBand(i, gn[i]);
    }
    engine.setPreamp(preamp); engine.setEqEnabled(true);
    set({ bandFreqs: fr, bandQs: qs, bands: gn, preamp, presetName: name, eqEnabled: true });
    persistEq(get);
  },

  currentEqSnapshot: () => {
    const s = get();
    return { name: s.presetName, gains: [...s.bands], freqs: [...s.bandFreqs], qs: [...s.bandQs], preamp: s.preamp, enabled: s.eqEnabled };
  },

  applyEqSnapshot: (snap, persist = true) => {
    const n = EQ_FREQS.length;
    for (let i = 0; i < n; i++) {
      const fr = snap.freqs[i] ?? EQ_FREQS[i], q = snap.qs[i] ?? 1.1, g = snap.gains[i] ?? 0;
      engine.setEqFreq(i, fr); engine.setEqQ(i, q); engine.setBand(i, g);
    }
    engine.setPreamp(snap.preamp); engine.setEqEnabled(snap.enabled);
    set({ bandFreqs: [...snap.freqs], bandQs: [...snap.qs], bands: [...snap.gains], preamp: snap.preamp, eqEnabled: snap.enabled, presetName: snap.name });
    if (persist) persistEq(get);
  },

  autoEqCurrent: async () => {
    const t = get().current();
    if (!t) return false;
    try {
      const url = await fileUrl(t.path);
      const snap = await autoEqForTrack(t.id, url, "Auto");
      if (!snap) return false;
      get().applyEqSnapshot(snap, !eqOverrideActive); // don't clobber the base while a song override is live
      return true;
    } catch { return false; }
  },

  pinEqToSong: (id) => {
    if (!eqOverrideActive) { eqBaseSnap = get().currentEqSnapshot(); eqOverrideActive = true; }
    useEqAssign.getState().pin(id, get().currentEqSnapshot());
  },
  unpinEqFromSong: (id) => {
    useEqAssign.getState().unpin(id);
    const cur = get().current();
    if (cur && cur.id === id) get().resolveSongEq(cur); // fall back to base / AutoEq immediately
  },

  resolveSongEq: (track) => {
    const pin = useEqAssign.getState().get(track.id);
    // AutoEq runs an FFT on the starting track; only do it on-play when the user allows on-play
    // analysis (Settings → Performance). In "idle"/"off" modes a pinned EQ still applies, but the
    // corrective AutoEq is skipped so starting a track never stalls the UI. [perf P1]
    const auto = useSettings.getState().autoEqPerSong && useSettings.getState().analysisMode === "onplay";
    if (pin || auto) {
      if (!eqOverrideActive) { eqBaseSnap = get().currentEqSnapshot(); eqOverrideActive = true; }
      if (pin) get().applyEqSnapshot(pin, false);
      else void get().autoEqCurrent(); // transient (eqOverrideActive guards persist)
    } else if (eqOverrideActive) {
      if (eqBaseSnap) get().applyEqSnapshot(eqBaseSnap, false); // restore the user's base EQ
      eqBaseSnap = null; eqOverrideActive = false;
    }
  },

  _syncTime: () => {
    const pos = engine.currentTime, dur = engine.duration, playing = !engine.paused;
    const s = get();
    // Coalesce: skip the store write (and the resulting re-render of EVERY position subscriber —
    // seekbar, section strip, visualizer, time label) when nothing the UI actually shows has moved.
    // The native engine polls at 10Hz and `timeupdate` can fire sub-frame; a <0.2s delta is invisible
    // on any seekbar, so writing it just burns a full store-notify per tick. This was the bulk of the
    // "the whole app feels slow while a track plays" cost. [perf]
    if (playing === s.playing && Math.abs(pos - s.position) < 0.2 && Math.abs(dur - s.duration) < 0.2) return;
    set({ position: pos, duration: dur, playing });
    if (playing) saveResume(get);
  },
}));

// Per-song EQ override state: while a pinned/AutoEq curve is live for the current song, `eqBaseSnap`
// holds the user's base EQ to restore afterwards, and `eqOverrideActive` suppresses persistEq so the
// transient override never overwrites the saved base.
let eqOverrideActive = false;
let eqBaseSnap: EqSnapshot | null = null;

// Coalesce the EQ/volume disk writes. setBand/setEqFreq/setEqQ/setVolume fire on every pointermove of a
// fader/slider — and each write does a localStorage parse + re-stringify of the WHOLE persisted blob
// (which carries the up-to-SESSION_CAP-id session queue). The value is already live in the store + engine,
// so the heavy serialize only needs to land once the drag settles. Trailing debounce → one write per drag.
let eqPersistTimer: ReturnType<typeof setTimeout> | undefined;
function persistEq(get: () => PlayerState) {
  if (eqOverrideActive) return; // a per-song override is live → don't persist it as the base EQ
  if (eqPersistTimer) clearTimeout(eqPersistTimer);
  eqPersistTimer = setTimeout(() => {
    if (eqOverrideActive) return; // an override went live while we waited → don't clobber the base EQ
    const s = get();
    const p = loadPersisted();
    savePersisted({ ...p, eq: { name: s.presetName, gains: s.bands, preamp: s.preamp, enabled: s.eqEnabled }, eqFreqs: s.bandFreqs, eqQs: s.bandQs });
  }, 300);
}
let volPersistTimer: ReturnType<typeof setTimeout> | undefined;
function persistVolume(v: number) {
  if (volPersistTimer) clearTimeout(volPersistTimer);
  volPersistTimer = setTimeout(() => { const p = loadPersisted(); savePersisted({ ...p, volume: v }); }, 300);
}

// On Android the SAF index only knows filenames; this fills REAL tags (artist/album/title/duration)
// from native MediaMetadataRetriever in the background, in small batches, then persists so it's
// one-time. A track needs enriching while its album is the sentinel "Folder" OR its artist is still
// "Unknown artist" — the latter also re-sweeps tracks that an OLDER, flaky reader finalized with no
// artist (the content://-to-MMR fix). `enrichTried` bounds re-reads to once per file per session.
const enrichTried = new Set<string>();
let enriching = false;
let mediaScanning = false; // re-entrancy guard for the MediaStore fast scan
let enrichGen = 0;
/** Abort an in-flight background enrichment sweep (called before wiping/replacing the library so the
 *  loop doesn't keep mutating a library that's being deleted). */
export function abortEnrich() { enrichGen++; }
async function enrichAndroidMeta() {
  if (!isAndroid || enriching) return;
  enriching = true;
  const myGen = ++enrichGen;
  const clean = (s?: string) => (s && s.trim() ? s.trim() : undefined);
  const needs = (t: Track) => (t.album === "Folder" || t.artist === "Unknown artist") && !enrichTried.has(t.path);
  // Snapshot the to-enrich list ONCE. Previously each 200-track batch re-filtered the WHOLE (40k) library
  // AND rebuilt a 40k path→track Map — O(n) per batch × hundreds of batches = O(n²) main-thread work that
  // ran for the whole launch and stuttered everything you did. Now it's O(n) total. [perf — launch]
  const todo = usePlayer.getState().library.filter(needs);
  if (todo.length === 0) { enriching = false; return; }
  // Accumulate per-track patches across many MMR batches, then rebuild the (possibly 40k-element)
  // library array only OCCASIONALLY. Rebuilding it every 120-track batch = hundreds of full-array
  // re-allocations + re-renders + 40k album/artist re-groupings → jank/OOM on big libraries.
  const patches = new Map<string, Partial<Track>>();
  // Reused path→index map so each flush is O(changed) + one array copy, instead of mapping (with a Map
  // lookup) over all 40k rows every flush. Rebuilt only if the library length changes underneath us. [perf P1]
  let idxByPath: Map<string, number> | null = null;
  let idxLen = -1;
  const flush = () => {
    if (patches.size === 0 || myGen !== enrichGen) return;
    const lib = usePlayer.getState().library;
    if (!idxByPath || idxLen !== lib.length) {
      idxByPath = new Map();
      for (let i = 0; i < lib.length; i++) idxByPath.set(lib[i].path, i);
      idxLen = lib.length;
    }
    const next = lib.slice();                       // new array ref (React) — keeps unchanged rows by ref
    for (const [path, patch] of patches) {
      const i = idxByPath.get(path);
      if (i !== undefined) next[i] = { ...next[i], ...patch } as Track;
    }
    patches.clear();
    usePlayer.setState({ library: next });          // same order/length → idxByPath stays valid next flush
  };
  try {
    let sincePaint = 0;
    for (let off = 0; off < todo.length; off += 200) {
      if (myGen !== enrichGen) return; // a wipe/replace happened → stop touching the library
      const pending = todo.slice(off, off + 200);          // walk the snapshot — no per-batch 40k re-filter
      pending.forEach((t) => enrichTried.add(t.path)); // mark attempted up-front → never re-read this session
      const rows = await tracksMetaUris(pending.map((t) => t.path));
      if (myGen !== enrichGen) return; // wiped during the await → don't write back
      if (rows.length === 0) break; // native reader unavailable → stop (avoid a hot loop)
      const byUri = new Map(pending.map((t) => [t.path, t] as const)); // tiny (≤200) — just for fallback values
      for (const r of rows) {
        const t = byUri.get(r.uri);
        if (!t) continue;
        patches.set(r.uri, {
          title: clean(r.title) ?? t.title,
          artist: clean(r.artist) ?? clean(r.albumArtist) ?? t.artist,
          albumArtist: clean(r.albumArtist) ?? t.albumArtist,
          album: clean(r.album) ?? (t.album === "Folder" ? "Unknown album" : t.album), // clear sentinel
          genre: clean(r.genre) ?? t.genre,
          year: r.year ? (parseInt(r.year, 10) || t.year) : t.year,
          duration: r.durationMs && r.durationMs > 0 ? r.durationMs / 1000 : t.duration,
        });
      }
      sincePaint += rows.length;
      if (sincePaint >= 6000) { flush(); sincePaint = 0; } // repaint at most ~every 6k tracks → far fewer re-sorts
      await new Promise((res) => setTimeout(res, 30)); // yield: keep UI + playback smooth
    }
    flush(); // apply the tail
    cacheSave(usePlayer.getState().folders[0] ?? "", usePlayer.getState().library); // persist → one-time
  } catch { /* ignore */ } finally { enriching = false; }
}

/** Start a real crossfade into the next track `crossfade` seconds before the current one ends, so the
 *  two tracks overlap (a true blend, not a fade-in from silence). Fires once per track; manual skips
 *  and Endless Set handle their own transitions. */
function maybeAutoCrossfade() {
  const xf = useSettings.getState().crossfade;
  if (xf <= 0) return;
  const st = usePlayer.getState();
  if (!st.playing || st.loop || st.repeat === "one") return;       // A–B loop / repeat-one must not advance
  if (st.index < 0 || st.index >= st.queue.length - 1) return;     // no next track to blend into
  if (crossfadeFiredFor === st.index) return;                       // already started for this track
  // Same-album gapless rule: don't start an early overlap into the next track when they're from the
  // same album and album-crossfade is off — let it play to the end and butt-join (Poweramp behaviour).
  const nextT = st.queue[st.index + 1];
  if (!useSettings.getState().crossfadeSameAlbum && playingTrack && nextT && sameAlbum(playingTrack, nextT)) return;
  const dur = engine.duration, pos = engine.currentTime;
  if (!dur || dur < xf * 2) return;                                 // too short to crossfade cleanly
  if (pos < dur - xf) return;                                       // not within the last `xf` seconds yet
  crossfadeFiredFor = st.index;
  void st.next(true);                                               // natural advance → playTrack runs the crossfade
}

/** React to a system audio-focus change (incoming call, another media app, a navigation prompt).
 *  Behaviour per Settings → Playback → Interruptions: duck the volume or pause on loss, and restore /
 *  auto-resume on regain. The native side reports these via `bindAudioFocus`. No-op when set to ignore. */
export function onAudioFocus(state: "loss" | "transient" | "duck" | "gain"): void {
  const cfg = useSettings.getState();
  if (cfg.audioFocus === "ignore") return;
  const st = usePlayer.getState();
  if (state === "gain") {
    if (duckPrevVol >= 0) { engine.setVolume(duckPrevVol); usePlayer.setState({ volume: duckPrevVol }); duckPrevVol = -1; }
    if (pausedByFocus) { pausedByFocus = false; if (cfg.audioFocusResume) { engine.play(); usePlayer.setState({ playing: true }); } }
    return;
  }
  // A transient "duck" request → lower the volume but keep playing; restored on the matching "gain".
  if (cfg.audioFocus === "duck" && (state === "duck" || state === "transient")) {
    if (duckPrevVol < 0) { duckPrevVol = st.volume; engine.setVolume(Math.max(0, st.volume * 0.2)); }
    return;
  }
  // Pause mode, or a permanent loss → pause and remember to resume once focus comes back.
  if (st.playing) { pausedByFocus = true; usePlayer.setState({ playing: false }); engine.pause(); }
}

/** Wire engine callbacks to the store (called once from App). */
export function bindEngine() {
  const offTime = engine.onTime(() => {
    usePlayer.getState()._syncTime();
    if (engine.currentTime > tasteMaxPos) tasteMaxPos = engine.currentTime; // track deepest listen point
    if (usePlayer.getState().endless) { void maybeAdvanceEndless(); return; } // Endless Set owns its own transitions
    maybeAutoCrossfade();                                                    // start a crossfade `xf`s before the track ends
  });
  const offState = engine.onState(() => usePlayer.getState()._syncTime());
  const offEnd = engine.onEnded(() => { tasteEnded = true; usePlayer.getState().next(true); }); // natural finish → FullPlay
  // apply the persisted EQ on first paint
  const s = usePlayer.getState();
  s.bandFreqs.forEach((hz, i) => engine.setEqFreq(i, hz));
  s.bandQs.forEach((q, i) => engine.setEqQ(i, q));
  engine.applyPreset(s.bands, s.preamp, s.eqEnabled);
  engine.setVolume(s.volume);
  return () => { offTime(); offState(); offEnd(); };
}

export { EQ_FREQS };
