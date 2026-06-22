// Library → taste-engine ingest (Phase 6). The browser decodes each track via Web Audio (reusing
// the platform's codecs), downmixes to mono and resamples to 22.05 kHz so the IPC payload stays
// small, then hands it to the Rust analyzer. Used by the Settings → For You "Analyze library" action.

import { fileUrl, hasTauri, isAndroid, tasteAnalyzePaths } from "./backend";
import { timed } from "./lagMonitor";
import { analyzeSamples, hasFingerprint, persist } from "./taste";
import type { Track } from "./types";

const TARGET_SR = 22_050;
const MAX_SECS = 100; // bound the IPC payload; the engine only analyzes a 90 s centre window

/** Analysis quality profiles. Decoded mono samples are shipped to the Rust engine as a plain array,
 *  so the payload (= sr × secs floats) dominates cost on mobile — `low` slashes it ~3× and caps the
 *  number of tracks a manual pass will touch, so a 65k-song phone library doesn't melt. */
export interface TasteOpts { sr: number; secs: number; cap: number }
export function tasteOpts(perf: "low" | "high"): TasteOpts {
  return perf === "low" ? { sr: 16_000, secs: 45, cap: 400 } : { sr: 22_050, secs: 90, cap: 2_000 };
}

type Ctor<T> = { new (...args: never[]): T };
// ONE shared decode context, reused for every track. Browsers hard-cap concurrent AudioContexts
// (~6 in Chromium/WebKit); creating one per track silently fails after a handful and stalls a
// whole-library analysis. decodeAudioData is safe to call repeatedly on a single context.
let _decodeCtx: AudioContext | null = null;
function audioCtx(): AudioContext {
  if (_decodeCtx) return _decodeCtx;
  const W = window as unknown as { AudioContext?: Ctor<AudioContext>; webkitAudioContext?: Ctor<AudioContext> };
  const C = W.AudioContext ?? W.webkitAudioContext;
  if (!C) throw new Error("no AudioContext");
  _decodeCtx = new C();
  return _decodeCtx;
}
function offlineCtx(channels: number, length: number, sr: number): OfflineAudioContext {
  const W = window as unknown as { OfflineAudioContext?: Ctor<OfflineAudioContext>; webkitOfflineAudioContext?: Ctor<OfflineAudioContext> };
  const C = W.OfflineAudioContext ?? W.webkitOfflineAudioContext;
  if (!C) throw new Error("no OfflineAudioContext");
  return new C(channels as never, length as never, sr as never);
}

/** Decode a file → mono Float32 at `sr` Hz, trimmed to a `secs`-long window around the centre. */
async function decodeMono(path: string, sr = TARGET_SR, secs = MAX_SECS): Promise<Float32Array | null> {
  try {
    const url = await fileUrl(path);
    const bytes = await (await fetch(url)).arrayBuffer();
    const ac = audioCtx();
    const decoded = await timed("taste-decode", () => ac.decodeAudioData(bytes)); // shared context — do NOT close it per track
    // resample + downmix to mono via an offline render at the target rate
    const frames = Math.max(1, Math.ceil(decoded.duration * sr));
    const off = offlineCtx(1, frames, sr);
    const src = off.createBufferSource();
    src.buffer = decoded;
    src.connect(off.destination); // stereo→mono downmix happens automatically into the 1-ch destination
    src.start();
    const rendered = await off.startRendering();
    const mono = rendered.getChannelData(0);
    const maxLen = secs * sr;
    if (mono.length <= maxLen) return new Float32Array(mono);
    const start = Math.floor((mono.length - maxLen) / 2); // centre window (skips intro/outro)
    return new Float32Array(mono.subarray(start, start + maxLen));
  } catch {
    return null;
  }
}

/** Fingerprint ONE track (decode → analyze → persist) if it isn't already done. Used by analyze-on-play
 *  so the taste profile builds from what you actually listen to — incremental, no whole-library grind. */
export async function analyzeOne(track: Track, opts: TasteOpts): Promise<boolean> {
  if (!hasTauri) return false;
  try {
    if (await hasFingerprint(track.id)) return false;
    // Desktop: decode + fingerprint in RUST, off the main thread. The webview path (decodeMono →
    // decodeAudioData of a whole file) blocks the UI ~1–2s per track on webkit2gtk — that was the big
    // library stalls caught by the lag monitor, firing on every analyze-on-play / idle-analysis step.
    // Android keeps the webview path (content:// URIs the Rust side can't open directly).
    if (!isAndroid) {
      const added = await tasteAnalyzePaths([track.id], () => { /* no progress UI for a single track */ });
      return added > 0;
    }
    const mono = await decodeMono(track.path, opts.sr, opts.secs);
    if (!mono || mono.length < opts.sr) return false; // need ≥1 s of audio
    await analyzeSamples(track.id, mono, opts.sr);
    await persist();
    return true;
  } catch { return false; }
}

/** Order tracks for a manual analysis pass: the ones you actually engage with first (liked > played
 *  > recently added), then cap so a huge library finishes in minutes instead of never. */
export function selectForAnalysis(
  tracks: Track[],
  statOf: (id: string) => { rating: number; plays: number; lastPlayed: number },
  cap: number,
): Track[] {
  const score = (t: Track) => { const s = statOf(t.id); return (s.rating >= 4 ? 1e6 : 0) + s.plays * 1000 + (s.lastPlayed ? 100 : 0); };
  const ranked = [...tracks].sort((a, b) => score(b) - score(a) || (b.mtime ?? 0) - (a.mtime ?? 0));
  return cap > 0 ? ranked.slice(0, cap) : ranked;
}

export interface IngestProgress { done: number; total: number; added: number }

/**
 * Analyze every library track that doesn't already have a fingerprint, then persist. Sequential
 * (decoding is heavy) with progress callbacks; safe to abort by navigating away. Returns #added.
 */
export async function analyzeLibrary(
  tracks: Track[],
  opts: TasteOpts,
  onProgress?: (p: IngestProgress) => void,
  shouldStop?: () => boolean,
): Promise<number> {
  if (!hasTauri) return 0;
  let done = 0;
  let added = 0;
  for (const t of tracks) {
    if (shouldStop?.()) break;
    try {
      if (!(await hasFingerprint(t.id))) {
        const mono = await decodeMono(t.path, opts.sr, opts.secs);
        if (mono && mono.length >= opts.sr) { // need ≥1 s of audio
          await analyzeSamples(t.id, mono, opts.sr);
          added++;
          if (added % 25 === 0) await persist(); // checkpoint so a mid-run stop keeps progress
        }
      }
    } catch { /* skip unreadable / unsupported file */ }
    done++;
    onProgress?.({ done, total: tracks.length, added });
  }
  await persist();
  return added;
}

/** Analyze a specific set of tracks (e.g. a multi-selection), picking the right backend per platform:
 *  Android decodes in the WebView (content:// URIs), desktop uses the fast native Rust decoder.
 *  Returns the number of NEW fingerprints added. */
export async function analyzeTrackSet(
  tracks: Track[],
  opts: TasteOpts,
  onProgress?: (p: IngestProgress) => void,
  shouldStop?: () => boolean,
): Promise<number> {
  if (!hasTauri || !tracks.length) return 0;
  if (isAndroid) return analyzeLibrary(tracks, opts, onProgress, shouldStop);
  // Desktop: native parallel decode, chunked so Stop works + progress reports.
  const paths = tracks.map((t) => t.id);
  const CHUNK = 400;
  let added = 0, base = 0;
  for (let i = 0; i < paths.length && !shouldStop?.(); i += CHUNK) {
    const slice = paths.slice(i, i + CHUNK);
    added += await tasteAnalyzePaths(slice, (e) => {
      if (e.kind === "progress") onProgress?.({ done: base + e.done, total: paths.length, added });
    });
    base += slice.length;
  }
  return added;
}

/** Folder + genre tokens per track id, for cluster auto-naming ("Techno", a folder name, …). */
export function libraryTokens(tracks: Track[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const t of tracks) {
    const toks: string[] = [];
    if (t.genre) toks.push(t.genre.toLowerCase());
    const segs = t.path.split(/[\\/]/).filter(Boolean);
    if (segs.length >= 2) toks.push(segs[segs.length - 2].toLowerCase()); // parent folder name
    out[t.id] = toks;
  }
  return out;
}
