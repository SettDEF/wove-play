import type { Track } from "./types";

/** True inside the Tauri webview (desktop or Android). False in a plain browser dev tab. */
export const hasTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** Running on an Android device (vs desktop). Folder scans work on desktop; Android uses the file picker. */
export const isAndroid =
  typeof navigator !== "undefined" && /android/i.test(navigator.userAgent);

/** Linux desktop webview (webkit2gtk). It silences Web Audio AND blocks the main thread HARD on
 *  decodeAudioData of whole files (multi-second freezes) — so heavy decode work must avoid it (use the
 *  native Rust decoder, or skip). False on Android (Chromium), macOS (WKWebView) and Windows (WebView2). */
export const isWebkitGtk =
  typeof navigator !== "undefined" && /linux/i.test(navigator.userAgent)
  && /applewebkit/i.test(navigator.userAgent) && !/chrome|chromium|android/i.test(navigator.userAgent);

type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

let _invoke: InvokeFn | null = null;
async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!_invoke) {
    const core = await import("@tauri-apps/api/core");
    _invoke = core.invoke as InvokeFn;
  }
  return _invoke<T>(cmd, args);
}

/** Native per-track analysis (Analysis v2 Stage B) — tempo/beat-grid + Camelot key.
 *  snake_case to match the Rust serde payload. */
export interface NativeAnalysis {
  version: number;
  duration: number;
  bpm: number;
  first_beat: number;
  beat_confidence: number;
  is_stable: boolean;
  beats: number[];
  key: string;
  camelot: string;
  key_confidence: number;
  sections: { start: number; end: number; label: string; energy: number }[];
  /** Genre / sub-genre classification (Phase 1 heuristic). Null on pre-v3 caches until re-analyzed. */
  genre: GenreResult | null;
}

/** Genre/sub-genre result (mirrors `taste::GenreResult`). The DJ app consumes this too. */
export interface GenreResult {
  genre: string;     // top-level, e.g. "Electronic"
  subgenre: string;  // e.g. "Tech House"
  confidence: number; // 0..1
  bpm: number;
  camelot: string;
  energy: number;    // 0..1
  tags: string[];
}

/** Cached analysis for a track, or null if not analyzed yet (no decode). */
export async function cachedAnalysis(path: string): Promise<NativeAnalysis | null> {
  if (!hasTauri) return null;
  try {
    return await invoke<NativeAnalysis | null>("track_analysis", { path });
  } catch {
    return null;
  }
}

/** Analyze one track now (returns the cache if fresh); decodes natively off-thread. */
export async function analyzeTrackNative(path: string): Promise<NativeAnalysis | null> {
  if (!hasTauri) return null;
  try {
    return await invoke<NativeAnalysis>("analyze_track", { path });
  } catch {
    return null;
  }
}

/** Real downsampled waveform peaks (0..1) computed natively (off the GTK main thread) → drives the
 *  segment-bar seekbar on Linux desktop, where the webview full-file decode is skipped (it stalled). */
export async function waveformNative(path: string, buckets = 480): Promise<number[] | null> {
  if (!hasTauri) return null;
  try {
    return await invoke<number[]>("track_waveform", { path, buckets });
  } catch {
    return null;
  }
}

/** Background-analyze a batch of paths (skips cached); streams {done,total}. Returns count newly analyzed. */
export async function analyzeTracksNative(
  paths: string[],
  onProgress?: (done: number, total: number) => void,
): Promise<number> {
  if (!hasTauri || !paths.length) return 0;
  const core = await import("@tauri-apps/api/core");
  const ch = new core.Channel<{ kind: string; done?: number; total?: number; analyzed?: number }>();
  ch.onmessage = (m) => {
    if (m.kind === "progress" && onProgress) onProgress(m.done ?? 0, m.total ?? 0);
  };
  return await invoke<number>("analyze_tracks", { paths, onEvent: ch });
}

// ── Endless Set (beatmatched/key-aware auto-DJ; Tier-1 #1) ───────────────────
export interface EndlessTransition {
  out_at: number;
  in_at: number;
  overlap_secs: number;
  tempo_ratio: number;
  beatmatch: boolean;
  key_distance: number;
  harmonic: boolean;
  score: number;
}
export interface EndlessStop {
  id: string; // the track path
  transition: EndlessTransition | null;
}
export interface EndlessSetResult {
  set: { stops: EndlessStop[]; flow: number };
  skipped: number; // paths that weren't analyzed yet, left out of the set
}

/**
 * Build an Endless Set over `paths` (only already-analyzed tracks are used),
 * optionally anchored at `start` (a path). Returns the ordered stops with the
 * planned transition out of each, plus how many paths were skipped (unanalyzed).
 */
export async function buildEndlessSet(
  paths: string[],
  start?: string,
  overlapBeats = 16,
): Promise<EndlessSetResult | null> {
  if (!hasTauri || !paths.length) return null;
  try {
    return await invoke<EndlessSetResult>("endless_set", { paths, start: start ?? null, overlapBeats });
  } catch {
    return null;
  }
}

// ── DJ set (genre + harmonic + BPM-ramp + energy-curve ordering; genre engine Phase 3) ───────────
export type DjCurve = "rise" | "descend" | "peak" | "plateau" | "wave";
export interface DjStop {
  id: string; // the track path
  bpm: number; camelot: string; energy: number;
  key_distance: number; bpm_delta: number; harmonic: boolean;
}
export interface DjSet { stops: DjStop[]; flow: number; subgenre: string | null }
export interface DjSetResult { set: DjSet; skipped: number; analyzed: number }
export interface DjSetOpts {
  genre?: string; subgenre?: string; curve?: DjCurve;
  max_len?: number; harmonic?: boolean; max_bpm_jump?: number;
}

/** Order `paths` into a DJ set (only already-analyzed + classified tracks are used). Stop ids are the
 *  input paths, so the caller maps them back to library tracks and builds a playlist. */
export async function djSet(paths: string[], opts: DjSetOpts): Promise<DjSetResult> {
  const empty: DjSetResult = { set: { stops: [], flow: 0, subgenre: opts.subgenre ?? null }, skipped: paths.length, analyzed: 0 };
  if (!hasTauri || !paths.length) return empty;
  try {
    return await invoke<DjSetResult>("dj_set", { paths, opts });
  } catch {
    return empty;
  }
}

// ── Native audio engine (NATIVE_ENGINE_PLAN S2; desktop only) ────────────────
export interface NaState { position: number; duration: number; playing: boolean }
export async function naLoad(path: string): Promise<number> {
  if (!hasTauri) return 0;
  try { return await invoke<number>("na_load", { path }); } catch { return 0; }
}
export async function naPlay(): Promise<void> { if (hasTauri) try { await invoke("na_play"); } catch { /* */ } }
export async function naPause(): Promise<void> { if (hasTauri) try { await invoke("na_pause"); } catch { /* */ } }
export async function naSeek(sec: number): Promise<void> { if (hasTauri) try { await invoke("na_seek", { sec }); } catch { /* */ } }
export async function naSetVolume(v: number): Promise<void> { if (hasTauri) try { await invoke("na_set_volume", { v }); } catch { /* */ } }
export async function naSetBalance(balance: number): Promise<void> { if (hasTauri) try { await invoke("na_set_balance", { balance }); } catch { /* */ } }
export async function naSetMono(mono: boolean): Promise<void> { if (hasTauri) try { await invoke("na_set_mono", { mono }); } catch { /* */ } }
export async function naState(): Promise<NaState> {
  if (!hasTauri) return { position: 0, duration: 0, playing: false };
  try { return await invoke<NaState>("na_state"); } catch { return { position: 0, duration: 0, playing: false }; }
}
export async function naSetEq(enabled: boolean, preamp: number, bands: number[], freqs: number[], qs: number[]): Promise<void> {
  if (hasTauri) try { await invoke("na_set_eq", { enabled, preamp, bands, freqs, qs }); } catch { /* */ }
}
export async function naSetTone(bass: number, treble: number): Promise<void> { if (hasTauri) try { await invoke("na_set_tone", { bass, treble }); } catch { /* */ } }
export async function naSetVocal(k: number): Promise<void> { if (hasTauri) try { await invoke("na_set_vocal", { k }); } catch { /* */ } }
export async function naSetReplaygain(db: number): Promise<void> { if (hasTauri) try { await invoke("na_set_replaygain", { db }); } catch { /* */ } }
export async function naSetOutput(clipPrevent: boolean, ditherBits: number): Promise<void> { if (hasTauri) try { await invoke("na_set_output", { clipPrevent, ditherBits }); } catch { /* */ } }
export async function naLoadNext(path: string): Promise<void> { if (hasTauri) try { await invoke("na_load_next", { path }); } catch { /* */ } }
export async function naCrossfade(ms: number): Promise<void> { if (hasTauri) try { await invoke("na_crossfade", { ms }); } catch { /* */ } }
export async function naSetLoop(start: number, end: number): Promise<void> { if (hasTauri) try { await invoke("na_set_loop", { start, end }); } catch { /* */ } }
export async function naClearLoop(): Promise<void> { if (hasTauri) try { await invoke("na_clear_loop"); } catch { /* */ } }

/** Streamable loopback URL for a real filesystem path (range-seekable, no whole-file read).
 *  Returns null for content:// / http inputs or if the server isn't running → caller falls back. */
export async function streamUrl(path: string): Promise<string | null> {
  if (!hasTauri) return null;
  try { return await invoke<string | null>("stream_url", { path }); } catch { return null; }
}
/** Re-bind the media server to the LAN (Cast / nearby devices) or back to loopback only. */
export async function streamSetLan(on: boolean): Promise<void> {
  if (hasTauri) try { await invoke("stream_set_lan", { on }); } catch { /* */ }
}

/** A cast device discovered on the LAN. */
export interface CastDevice { id: string; name: string; kind: "dlna" | "chromecast"; address: string }
/** Scan the local network for cast targets (DLNA TVs + Chromecasts). ~2.5s. */
export async function castDiscover(): Promise<CastDevice[]> {
  if (!hasTauri) return [];
  try { return await invoke<CastDevice[]>("cast_discover"); } catch { return []; }
}
/** Cast a track (by its file path) to a discovered device. Throws with a message on failure. */
export async function castPlay(id: string, path: string, title: string): Promise<void> {
  if (!hasTauri) throw new Error("Casting needs the desktop app");
  const url = await invoke<string | null>("cast_url", { path });
  if (!url) throw new Error("Couldn't reach the network — is LAN sharing on?");
  await invoke("cast_play", { id, url, title });
}
/** Stop playback on a cast device. */
export async function castStop(id: string): Promise<void> {
  if (hasTauri) try { await invoke("cast_stop", { id }); } catch { /* */ }
}

/** Raw track returned by the Rust `scan_library` / cache commands. */
interface ScannedTrack {
  path: string;
  title: string | null;
  artist: string | null;
  album: string | null;
  album_artist: string | null;
  genre: string | null;
  year: number | null;
  track_no: number | null;
  disc_no: number | null;
  duration: number | null;
  mtime: number | null;
  folder?: string | null;
}

function fileName(path: string): string {
  const base = path.split(/[\\/]/).pop() || path;
  return base.replace(/\.[^.]+$/, "");
}

// content:// blobs can't be streamed by the WebView, so we read the bytes natively. That read is the
// main play-latency cost on Android, so we keep a small LRU of resolved blob URLs (path → objectURL):
// skipping back to a recent track — or to a track we prefetched — is then instant (no re-read). Bounded
// + revoked on eviction so memory stays in check (a few songs).
const BLOB_MAX = 4;
const blobCache = new Map<string, string>(); // insertion-ordered = LRU
const blobInflight = new Map<string, Promise<string>>(); // de-dupe concurrent reads of the same path

function putBlob(path: string, b64: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([bytes]));
  blobCache.set(path, url);
  while (blobCache.size > BLOB_MAX) {
    const oldest = blobCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    const old = blobCache.get(oldest);
    blobCache.delete(oldest);
    if (old) { try { URL.revokeObjectURL(old); } catch { /* ignore */ } }
  }
  return url;
}

async function contentBlob(path: string): Promise<string> {
  const hit = blobCache.get(path);
  if (hit) { blobCache.delete(path); blobCache.set(path, hit); return hit; } // bump to MRU
  const pending = blobInflight.get(path);
  if (pending) return pending;
  const p = (async () => {
    const r = await invoke<{ data: string }>("read_bytes", { uri: path });
    if (!r?.data) throw new Error("no data");
    return putBlob(path, r.data);
  })().finally(() => blobInflight.delete(path));
  blobInflight.set(path, p);
  return p;
}

/** Loopback streaming URL for an Android content:// URI (range-seekable, served by the native
 *  ContentServer). null if unavailable → caller falls back to the base64 blob read. */
async function contentStreamUrl(path: string): Promise<string | null> {
  if (!isAndroid) return null;
  try { return (await invoke<{ url: string | null }>("media_content_stream_url", { uri: path }))?.url ?? null; }
  catch { return null; }
}

// The WebView may block cleartext http://127.0.0.1 (release network policy) → an unplayable URL. Probe
// the loopback server ONCE per session with a tiny range request; if it isn't reachable we stick to
// the (slower but always-works) blob read. Cached so it costs one fetch, on the first content track.
let streamProbe: Promise<boolean> | null = null;
function streamingReachable(sampleUrl: string): Promise<boolean> {
  if (!streamProbe) {
    streamProbe = (async () => {
      try { const r = await fetch(sampleUrl, { headers: { Range: "bytes=0-0" } }); return r.status === 206 || r.status === 200; }
      catch { return false; }
    })();
  }
  return streamProbe;
}

/** Turn a native path/URI into a URL the <audio> element can load.
 *  Android SAF gives `content://` URIs the WebView CAN'T load directly → stream them over the native
 *  ContentServer (range-seekable, instant start); if that's unavailable, read the bytes into a
 *  (cached) Blob URL. Real filesystem paths stream over the local range-server / asset protocol. */
// Resolved loopback stream URLs, keyed by content:// URI. The token stays valid for the session, so
// caching it means a re-played / pre-warmed track skips the media_content_stream_url IPC round-trip
// entirely — that round-trip (once per skip) was the bulk of the skip latency on SAF/content libraries.
const streamUrlCache = new Map<string, string>();

export async function fileUrl(path: string): Promise<string> {
  if (/^https?:\/\//i.test(path)) return path; // online stream URL → play it directly
  if (!hasTauri) return path; // already a URL in browser/demo mode
  if (path.startsWith("content://")) {
    const cached = streamUrlCache.get(path);
    if (cached) return cached;                     // already resolved this session → instant skip
    const streamed = await contentStreamUrl(path); // instant first byte + seek, no whole-file read
    if (streamed && await streamingReachable(streamed)) { streamUrlCache.set(path, streamed); return streamed; }
    try { return await contentBlob(path); } catch { /* fall through to convertFileSrc */ }
  }
  // Real filesystem path: Tauri's asset protocol is instant + range-seekable and needs NO IPC round-
  // trip, so playback starts faster than routing through the loopback stream server (which we keep
  // only for casting, where a network-reachable URL is required).
  const core = await import("@tauri-apps/api/core");
  return core.convertFileSrc(path);
}

/** Warm a track that's likely to play next so the actual skip is instant. For content:// this either
 *  registers the stream token (cheap) or warms the blob cache when streaming is unavailable. Fire-and-
 *  forget; no-op for non-content paths and ones already cached/in-flight. */
export function prefetchFileUrl(path: string): void {
  if (!hasTauri || !path.startsWith("content://")) return;
  if (streamUrlCache.has(path) || blobCache.has(path) || blobInflight.has(path)) return; // already warm
  void fileUrl(path).catch(() => { /* prefetch is best-effort */ });
}

/** Let the user pick a music folder (native dialog). Returns the chosen path or null. */
export async function pickMusicFolder(): Promise<string | null> {
  if (!hasTauri) return null;
  const dialog = await import("@tauri-apps/plugin-dialog");
  const picked = await dialog.open({ directory: true, multiple: false, title: "Choose your music folder" });
  return typeof picked === "string" ? picked : null;
}

function scannedToTrack(r: ScannedTrack): Track {
  return {
    id: r.path,
    path: r.path,
    title: r.title || fileName(r.path),
    // fall back to the album artist before giving up — many albums/compilations only tag the
    // ALBUMARTIST frame, leaving the per-track ARTIST blank (otherwise shows "Unknown artist").
    artist: r.artist || r.album_artist || "Unknown artist",
    album: r.album || "Unknown album",
    albumArtist: r.album_artist || undefined,
    genre: r.genre || undefined,
    year: r.year ?? undefined,
    trackNo: r.track_no ?? undefined,
    discNo: r.disc_no ?? undefined,
    mtime: r.mtime ?? undefined,
    folder: r.folder || undefined,
    duration: r.duration || 0,
  };
}

/** Recursively scan a folder for audio files (native only). */
export async function scanLibrary(folder: string): Promise<Track[]> {
  if (!hasTauri) return [];
  const rows = await invoke<ScannedTrack[]>("scan_library", { folder });
  return rows.map(scannedToTrack);
}

interface ScanDiffRaw { changed: ScannedTrack[]; removed: string[]; unchanged: string[] }
export interface LibraryDiff { changed: Track[]; removed: string[]; unchangedCount: number }

/**
 * Incremental scan over one or more folders: pass the paths+mtimes already cached; only new/modified
 * files get a tag read. Re-scans stay fast and never require a full re-index; reports adds & removals.
 */
export async function scanLibraryDiff(folders: string[], known: { path: string; mtime: number | null }[]): Promise<LibraryDiff> {
  if (!hasTauri || !folders.length) return { changed: [], removed: [], unchangedCount: 0 };
  const d = await invoke<ScanDiffRaw>("scan_library_diff", { folders, known });
  return { changed: d.changed.map(scannedToTrack), removed: d.removed, unchangedCount: d.unchanged.length };
}

/** Streaming scan events (mapped to Tracks where applicable). Mirrors the Rust `ScanEvent` enum. */
export type ScanEvent =
  | { kind: "progress"; files: number; folders: number }
  | { kind: "batch"; changed: Track[]; unchanged: string[] }
  | { kind: "done"; removed: string[]; files: number; folders: number };
type ScanEventRaw =
  | { kind: "progress"; files: number; folders: number }
  | { kind: "batch"; changed: ScannedTrack[]; unchanged: string[] }
  | { kind: "done"; removed: string[]; files: number; folders: number };

/**
 * Streaming incremental scan (#138): results arrive as events *while the walk runs*, so a huge
 * library (e.g. a 1TB SD card) fills the UI progressively and the caller can show live file/folder
 * counts. Returns true if the native streaming path ran; false in the browser (caller should fall back).
 */
export async function scanLibraryStream(
  folders: string[],
  known: { path: string; mtime: number | null }[],
  onEvent: (e: ScanEvent) => void,
): Promise<boolean> {
  if (!hasTauri || !folders.length) return false;
  const core = await import("@tauri-apps/api/core");
  const ch = new core.Channel<ScanEventRaw>();
  ch.onmessage = (m) => {
    if (m.kind === "batch") onEvent({ kind: "batch", changed: m.changed.map(scannedToTrack), unchanged: m.unchanged });
    else onEvent(m);
  };
  await invoke<void>("scan_library_stream", { folders, known, onEvent: ch });
  return true;
}

const AUDIO_PICK_EXTS = ["mp3", "flac", "wav", "ogg", "oga", "m4a", "aac", "opus", "wma", "aiff", "aif"];

/**
 * Let the user pick individual audio files via the system picker. On Android this uses the
 * Storage Access Framework (ACTION_OPEN_DOCUMENT) — per-file access, NO runtime storage
 * permission required. Returns playable tracks (tags read on desktop; filename fallback on Android).
 */
export async function pickAudioFiles(): Promise<Track[]> {
  if (!hasTauri) return [];
  const dialog = await import("@tauri-apps/plugin-dialog");
  const picked = await dialog.open({ multiple: true, directory: false, filters: [{ name: "Audio", extensions: AUDIO_PICK_EXTS }] });
  const paths = Array.isArray(picked) ? picked : picked ? [picked] : [];
  if (!paths.length) return [];
  // best-effort tag read (works for real filesystem paths; Android content URIs fall back to filename)
  let meta: ScannedTrack[] = [];
  try { meta = await invoke<ScannedTrack[]>("tracks_meta", { paths }); } catch { /* fall back below */ }
  return paths.map((p, i) => {
    const m = meta[i];
    if (m && (m.title || m.artist)) return scannedToTrack(m);
    return { ...scannedToTrack({ path: p, title: null, artist: null, album: null, album_artist: null, genre: null, year: null, track_no: null, disc_no: null, duration: null, mtime: null }), album: "Added files" };
  });
}

export interface SystemColors { available: boolean; accent?: string; accent2?: string; neutralDark?: string; neutralLight?: string; }
/** Read the OS Material You palette (Android 12+ wallpaper colors). `available:false` elsewhere. */
export async function loadSystemColors(): Promise<SystemColors | null> {
  if (!hasTauri) return null;
  try { return await invoke<SystemColors>("system_colors"); } catch { return null; }
}

/** Open the native Android folder picker (SAF document tree). Returns the picked tree URI, or null. */
export async function pickFolderNative(): Promise<string | null> {
  if (!hasTauri) return null;
  try { const r = await invoke<{ uri?: string }>("pick_folder"); return r?.uri ?? null; } catch { return null; }
}

/** Map a SAF {uri,name} entry to a Track (filename-derived "Artist - Title" metadata). */
function folderTrackToTrack(t: { uri: string; name: string }): Track {
  const base = t.name.replace(/\.[^.]+$/, "");
  const parts = base.split(" - ");
  const ha = parts.length >= 2;
  return {
    id: t.uri, path: t.uri,
    title: (ha ? parts.slice(1).join(" - ") : base).trim(),
    artist: (ha ? parts[0] : "Unknown artist").trim(),
    album: "Folder", duration: 0,
  } as Track;
}

/** Recursively list audio files in a picked Android folder (content URIs). Filename-derived metadata. */
export async function listFolderNative(uri: string): Promise<Track[]> {
  if (!hasTauri) return [];
  try {
    const r = await invoke<{ tracks: { uri: string; name: string }[] }>("list_folder", { uri });
    return (r?.tracks ?? []).map(folderTrackToTrack);
  } catch { return []; }
}

/** Streaming folder events from the native Android SAF walker (Poweramp-style live indexing). */
export type FolderScanEvent =
  | { kind: "progress"; files: number; folders: number }
  | { kind: "batch"; tracks: Track[] }
  | { kind: "done"; files: number; folders: number };
type FolderScanEventRaw =
  | { kind: "progress"; files: number; folders: number }
  | { kind: "batch"; tracks: { uri: string; name: string }[] }
  | { kind: "done"; files: number; folders: number };

/**
 * Streaming native folder read (Android): emits live file/folder counts + track batches *while*
 * walking the SAF tree, so the UI shows the count ticking up instead of a frozen "Reading…".
 * Returns true if the native streaming path ran; false in the browser/desktop (caller falls back).
 */
export async function listFolderNativeStream(uri: string, onEvent: (e: FolderScanEvent) => void): Promise<boolean> {
  if (!hasTauri) return false;
  const core = await import("@tauri-apps/api/core");
  const ch = new core.Channel<FolderScanEventRaw>();
  ch.onmessage = (m) => {
    if (m.kind === "batch") onEvent({ kind: "batch", tracks: m.tracks.map(folderTrackToTrack) });
    else onEvent(m);
  };
  await invoke<void>("list_folder_stream", { uri, onEvent: ch });
  return true;
}

// ── background indexing service (Android): keeps scanning when the app is closed ──────────
export interface IndexStatus { exists: boolean; files: number; folders: number; done: boolean; ts: number; }

/** Start the Android foreground IndexingService scanning a picked SAF tree. True if it launched. */
export async function startIndexing(uri: string): Promise<boolean> {
  if (!hasTauri) return false;
  try { await invoke<void>("start_indexing", { uri }); return true; } catch { return false; }
}
/** Ask the indexing service to stop. */
export async function stopIndexing(): Promise<void> {
  if (!hasTauri) return;
  try { await invoke<void>("stop_indexing"); } catch { /* ignore */ }
}
/** Delete the on-disk index (the incremental `wavr-index.jsonl` + status heartbeat) so the next
 *  scan starts truly from zero — not an incremental top-up of a stale index. */
export async function clearIndex(): Promise<void> {
  if (!hasTauri) return;
  try { await invoke<void>("clear_index"); } catch { /* ignore */ }
}
/** Wipe the on-disk cover-thumbnail cache (Android + desktop use different cache dirs). */
export async function coverCacheClear(): Promise<void> {
  if (!hasTauri) return;
  try { await invoke<void>(isAndroid ? "clear_cover_cache" : "cover_cache_clear"); } catch { /* ignore */ }
}
/** Read a sidecar `.lrc`/`.txt` lyrics file next to a track (desktop only; SAF content URIs can't). */
export async function loadLyrics(path: string): Promise<string | null> {
  if (!hasTauri || path.startsWith("content://")) return null;
  try { return await invoke<string | null>("read_lyrics", { path }); } catch { return null; }
}

/** Real tag row read natively (Android) for a content:// URI. Empty fields = tag absent. */
export interface MetaRow { uri: string; title?: string; artist?: string; albumArtist?: string; album?: string; genre?: string; year?: string; durationMs?: number }
/** Batch-read real tags for Android content:// URIs via MediaMetadataRetriever (lofty can't read SAF). */
export async function tracksMetaUris(uris: string[]): Promise<MetaRow[]> {
  if (!hasTauri || !isAndroid) return [];
  try { const r = await invoke<{ tracks: MetaRow[] }>("read_tags_uris", { uris }); return r?.tracks ?? []; } catch { return []; }
}
/** Poll the service's on-disk progress (live counts + done flag). null if unavailable. */
export async function indexStatus(): Promise<IndexStatus | null> {
  if (!hasTauri) return null;
  try { return await invoke<IndexStatus>("index_status"); } catch { return null; }
}
/** Load indexed tracks from line `skip` onward (incremental — cheap to poll while scanning). */
/** One MediaStore row (full tags, from the Kotlin fast scanner). */
interface MediaRow { uri: string; title?: string; artist?: string; album?: string; albumArtist?: string; art?: string; folder?: string; durationMs?: number; year?: string; track?: number }
function mediaRowToTrack(r: MediaRow): Track {
  const clean = (s?: string) => (s && s.trim() && s !== "<unknown>" ? s.trim() : undefined);
  const folder = clean(r.folder)?.replace(/\/+$/, ""); // strip trailing slash ("Music/HipHop/" → "Music/HipHop")
  return {
    id: r.uri, path: r.uri,
    title: clean(r.title) || "Unknown title",
    artist: clean(r.artist) || clean(r.albumArtist) || "Unknown artist",
    album: clean(r.album) || "Unknown album",
    albumArtist: clean(r.albumArtist),
    folder,
    year: r.year ? (parseInt(r.year, 10) || undefined) : undefined,
    trackNo: r.track || undefined,
    duration: r.durationMs && r.durationMs > 0 ? r.durationMs / 1000 : 0,
  } as Track;
}
/** Fast Android library scan via MediaStore (full tags, paged). `folder` (a RELATIVE_PATH prefix like
 *  "Music/HipHop") scopes the scan to one folder + its subfolders. `needsPermission` = the user must
 *  grant music access first. Desktop returns empty. */
export async function mediaStoreScan(offset = 0, limit = 0, folder?: string, volume?: string): Promise<{ tracks: Track[]; total: number; needsPermission: boolean }> {
  if (!hasTauri) return { tracks: [], total: 0, needsPermission: false };
  try {
    const r = await invoke<{ tracks: MediaRow[]; total: number; needsPermission?: boolean }>("media_store_scan", { offset, limit, folder: folder ?? null, volume: volume ?? null });
    return { tracks: (r?.tracks ?? []).map(mediaRowToTrack), total: r?.total ?? 0, needsPermission: !!r?.needsPermission };
  } catch { return { tracks: [], total: 0, needsPermission: false }; }
}
/** Convert a SAF tree URI to a MediaStore RELATIVE_PATH prefix, or null if it's not on primary shared
 *  storage (e.g. an SD card — those live on a different MediaStore volume; caller falls back).
 *  `content://…/tree/primary%3AMusic%2FHipHop` → "Music/HipHop". Root of primary → "". */
export function safTreeToRelPath(uri: string): string | null {
  try {
    const m = uri.match(/\/tree\/([^/]+)/);
    if (!m) return null;
    const docId = decodeURIComponent(m[1]); // "primary:Music/HipHop"
    const colon = docId.indexOf(":");
    const vol = colon >= 0 ? docId.slice(0, colon) : docId;
    if (vol !== "primary") return null;     // SD card / USB → not on the external-audio volume
    return colon >= 0 ? docId.slice(colon + 1) : "";
  } catch { return null; }
}
/** Is the media-read permission already granted? (so we can silently auto-scan only when allowed.) */
export async function hasMediaPermission(): Promise<boolean> {
  if (!hasTauri || !isAndroid) return false;
  try { const r = await invoke<{ granted?: boolean }>("has_media_permission"); return !!r?.granted; } catch { return false; }
}
/** Pop the system media-access dialog (the UI re-scans after the user accepts). */
export async function requestMediaPermission(): Promise<void> {
  if (!hasTauri || !isAndroid) return;
  try { await invoke<void>("request_media_permission"); } catch { /* ignore */ }
}
export interface MusicFolder { path: string; count: number; volume?: string; storage?: string }
/** List the device's music folders (from MediaStore) for the in-app folder picker. */
export async function mediaStoreFolders(): Promise<{ folders: MusicFolder[]; needsPermission: boolean }> {
  if (!hasTauri || !isAndroid) return { folders: [], needsPermission: false };
  try {
    const r = await invoke<{ folders: MusicFolder[]; needsPermission?: boolean }>("media_store_folders");
    return { folders: r?.folders ?? [], needsPermission: !!r?.needsPermission };
  } catch { return { folders: [], needsPermission: false }; }
}
export async function readIndex(skip = 0, limit = 0): Promise<Track[]> {
  if (!hasTauri) return [];
  try {
    const r = await invoke<{ tracks: { uri: string; name: string }[] }>("read_index", { skip, limit });
    return (r?.tracks ?? []).map(folderTrackToTrack);
  } catch { return []; }
}

/** Open a URL in the system default app (browser / a lyrics app on Android). Browser → new tab.
 *  Android uses a plain ACTION_VIEW, so the OS shows its native "Open with… (Just once / Always)"
 *  dialog when no default handler is set. */
export async function openUrl(url: string): Promise<void> {
  if (!hasTauri) { try { window.open(url, "_blank", "noopener"); } catch { /* ignore */ } return; }
  try { await invoke<void>("open_url", { url }); }
  catch { try { window.open(url, "_blank", "noopener"); } catch { /* ignore */ } }
}

/** Progress events from the native taste analyzer. */
export type TasteAnalyzeEvent =
  | { kind: "progress"; done: number; total: number; added: number }
  | { kind: "done"; added: number };

/** Analyze a batch of files natively (parallel symphonia decode in Rust). Skips already-analyzed
 *  tracks, persists after the batch (resumable), streams progress. Returns # newly analyzed. */
export async function tasteAnalyzePaths(paths: string[], onEvent: (e: TasteAnalyzeEvent) => void): Promise<number> {
  if (!hasTauri || !paths.length) return 0;
  const core = await import("@tauri-apps/api/core");
  const ch = new core.Channel<TasteAnalyzeEvent>();
  ch.onmessage = onEvent;
  try { return await invoke<number>("taste_analyze_paths", { paths, onEvent: ch }); } catch { return 0; }
}

/** Embedded album-art thumbnail (data URL) for a file, lazily. null if none / browser.
 *  Skips content:// URIs (the native tag reader can't open them — avoids an IPC storm on scroll). */
// ── SQLite library index (PERF_PLAN P2.9, phase 1) ────────────────────────────
// Paged / sorted / filtered / searched browsing of huge libraries straight from SQLite, so the whole
// array needn't live in JS. The Rust side keeps this in sync whenever the JSONL cache is saved.
export interface LibFilter { search?: string; genre?: string; decade?: number; folder?: string; artist?: string; album?: string }
export interface LibPageReq { offset: number; limit: number; sort?: string; dir?: "asc" | "desc"; filter?: LibFilter }
export interface LibAlbum { album: string; artist: string; count: number; cover: string }
export interface LibArtist { artist: string; count: number; cover: string }
/** A page of tracks (already mapped to the app's Track shape). */
export async function libPage(req: LibPageReq): Promise<Track[]> {
  if (!hasTauri) return [];
  try { return (await invoke<ScannedTrack[]>("libdb_page", { req: { sort: "title", dir: "asc", filter: {}, ...req } })).map(scannedToTrack); } catch { return []; }
}
export async function libCount(filter: LibFilter = {}): Promise<number> {
  if (!hasTauri) return 0;
  try { return await invoke<number>("libdb_count", { filter }); } catch { return 0; }
}
export async function libAlbums(filter: LibFilter = {}): Promise<LibAlbum[]> {
  if (!hasTauri) return [];
  try { return await invoke<LibAlbum[]>("libdb_albums", { filter }); } catch { return []; }
}
export async function libArtists(filter: LibFilter = {}): Promise<LibArtist[]> {
  if (!hasTauri) return [];
  try { return await invoke<LibArtist[]>("libdb_artists", { filter }); } catch { return []; }
}
/** Empty the SQLite index (called alongside Delete-index, which leaves the library empty with no re-read). */
export async function libClear(): Promise<void> {
  if (!hasTauri) return;
  try { await invoke<void>("libdb_clear"); } catch { /* ignore */ }
}

export async function coverArt(path: string): Promise<string | null> {
  if (!hasTauri) return null;
  // Android SAF URIs can't be read by the desktop cover_art path — use MediaMetadataRetriever natively.
  if (path.startsWith("content://")) {
    try { const r = await invoke<{ data?: string | null }>("cover_uri", { uri: path }); return r?.data ?? null; } catch { return null; }
  }
  try { return await invoke<string | null>("cover_art", { path }); } catch { return null; }
}

export interface TagEdit {
  title?: string; artist?: string; album?: string; album_artist?: string;
  genre?: string; year?: number; track_no?: number;
}
/** Write metadata back to a file (desktop). Returns true on success. */
export async function writeTags(path: string, edit: TagEdit): Promise<boolean> {
  if (!hasTauri) return false;
  try { await invoke<void>("write_tags", { path, edit }); return true; } catch { return false; }
}

/** Embed cover-art bytes into a file's tag (desktop). Returns true on success. */
export async function setCover(path: string, data: Uint8Array, mime: string): Promise<boolean> {
  if (!hasTauri) return false;
  try { await invoke<void>("set_cover", { path, data: Array.from(data), mime }); return true; } catch { return false; }
}

/** Lowercase hex MD5 (Subsonic token auth). Empty string if unavailable. */
export async function md5Hex(input: string): Promise<string> {
  if (!hasTauri) return "";
  try { return await invoke<string>("md5_hex", { input }); } catch { return ""; }
}

/** Proxy HTTP GET via Rust (no WebView CORS) → bytes + mime. null if unavailable/failed. */
export async function httpGetBytes(url: string): Promise<{ data: Uint8Array; mime: string } | null> {
  if (!hasTauri) return null;
  try {
    const [data, mime] = await invoke<[number[], string]>("http_get_bytes", { url });
    return { data: new Uint8Array(data), mime };
  } catch { return null; }
}

/** Persisted library cache (native) so re-launches are instant. */
export async function cacheLoad(): Promise<{ folder: string; tracks: Track[] } | null> {
  if (!hasTauri) return null;
  try {
    const c = await invoke<{ folder: string; tracks: ScannedTrack[] } | null>("library_cache_load");
    return c ? { folder: c.folder, tracks: c.tracks.map(scannedToTrack) } : null;
  } catch { return null; }
}
/** Stream the cached library in batches so the list paints before the whole 40k file is parsed.
 *  Resolves once the full cache has been delivered. */
export function cacheLoadStream(onMeta: (folder: string) => void, onBatch: (tracks: Track[]) => void): Promise<void> {
  if (!hasTauri) return Promise.resolve();
  return new Promise<void>((resolve) => {
    (async () => {
      try {
        const core = await import("@tauri-apps/api/core");
        const ch = new core.Channel<{ kind: string; folder?: string; tracks?: ScannedTrack[] }>();
        ch.onmessage = (m) => {
          if (m.kind === "meta") onMeta(m.folder ?? "");
          else if (m.kind === "batch" && m.tracks) onBatch(m.tracks.map(scannedToTrack));
          else if (m.kind === "done") resolve();
        };
        await core.invoke("library_cache_stream", { onEvent: ch });
      } catch { resolve(); }
    })();
  });
}
export async function cacheSave(folder: string, tracks: Track[]): Promise<void> {
  if (!hasTauri) return;
  // store back in the Rust struct shape (snake_case fields)
  const rows: ScannedTrack[] = tracks.map((t) => ({
    path: t.path, title: t.title, artist: t.artist, album: t.album,
    album_artist: t.albumArtist ?? null, genre: t.genre ?? null, year: t.year ?? null,
    track_no: t.trackNo ?? null, disc_no: t.discNo ?? null, duration: t.duration || null, mtime: t.mtime ?? null,
    folder: t.folder ?? null,
  }));
  try { await invoke<void>("library_cache_save", { folder, tracks: rows }); } catch { /* ignore */ }
}
/** Wipe the on-disk library cache (used by a full rebuild so nothing stale survives). */
export async function cacheClear(): Promise<void> {
  if (!hasTauri) return;
  try { await invoke<void>("library_cache_save", { folder: "", tracks: [] }); } catch { /* ignore */ }
}

/** Write bytes to an absolute path (native export save target). */
export async function saveFile(path: string, bytes: Uint8Array): Promise<void> {
  if (!hasTauri) return;
  await invoke<void>("save_file", { path, bytes: Array.from(bytes) });
}

/** Native save dialog → returns the chosen path or null. */
export async function pickSavePath(defaultName: string, extensions: string[] = ["webm"]): Promise<string | null> {
  if (!hasTauri) return null;
  const dialog = await import("@tauri-apps/plugin-dialog");
  const p = await dialog.save({ defaultPath: defaultName, filters: [{ name: "File", extensions }] });
  return typeof p === "string" ? p : null;
}

/** Save text to a file: native save dialog on desktop, browser download elsewhere. */
export async function saveTextFile(name: string, text: string, mime = "text/plain"): Promise<void> {
  if (hasTauri && !isAndroid) {
    const ext = (name.split(".").pop() || "txt");
    const path = await pickSavePath(name, [ext]);
    if (path) await saveFile(path, new TextEncoder().encode(text));
    return;
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: mime }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const AUDIO_RE = /\.(mp3|flac|wav|ogg|oga|m4a|aac|opus|wma|aiff?|aif)$/i;

/** Turn picked/dropped File objects into playable tracks (object URLs). Works in any browser/webview,
 *  so you can add music without the native folder scan. Title/artist parsed from "Artist - Title". */
export function filesToTracks(files: File[]): Track[] {
  return files
    .filter((f) => AUDIO_RE.test(f.name))
    .map((f) => {
      const base = f.name.replace(/\.[^.]+$/, "");
      const parts = base.split(" - ");
      const hasArtist = parts.length >= 2;
      // when a whole folder was picked, group tracks under their containing folder name
      const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || "";
      const segs = rel.split("/").filter(Boolean);
      const album = segs.length >= 2 ? segs[segs.length - 2] : "Added files";
      return {
        id: `file:${rel || f.name}:${f.size}`,
        path: URL.createObjectURL(f),
        title: (hasArtist ? parts.slice(1).join(" - ") : base).trim(),
        artist: (hasArtist ? parts[0] : "Unknown artist").trim(),
        album,
        duration: 0,
      } as Track;
    });
}

/** A couple of royalty-free demo tracks so the player is alive in browser dev with no library. */
export function demoTracks(): Track[] {
  const base = "https://upload.wikimedia.org/wikipedia/commons";
  return [
    {
      id: "demo-1",
      path: `${base}/c/c8/Example.ogg`,
      title: "Demo Tone",
      artist: "Wove",
      album: "Browser Demo",
      duration: 0,
    },
  ];
}
