// Frontend client for the Rust `taste` engine (Phase 5 wiring). Every call is guarded by
// `hasTauri` so the browser dev build degrades to a no-op instead of throwing. `now` is sent as
// unix-seconds; the engine is deliberately time-source-free. See src-tauri/src/taste.rs.

import { hasTauri } from "./backend";

type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
let _invoke: InvokeFn | null = null;
async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!_invoke) {
    const core = await import("@tauri-apps/api/core");
    _invoke = core.invoke as InvokeFn;
  }
  return _invoke<T>(cmd, args);
}

/** Listening signals (must match the Rust `EventKind` variant names exactly). */
export type EventKind =
  | "SkipEarly" | "SkipMid" | "SkipLate" | "FullPlay" | "Replay"
  | "AddedManually" | "Like" | "Dislike" | "SeekReplaySection";

export interface Station { id: number; name: string; bpm: number }
export interface Recipe { name: string; seeds: string[]; size: number; order: "flow" | "score" | "shuffle" }
export interface ClusterDto { id: number; name: string; bpm: number; size: number; reps: string[] }
export type MixKind = "genre" | "blend" | "discover" | "recipe";
export interface GeneratedMix { id: string; kind: MixKind; name: string; tracks: string[]; reps: string[] }
export interface Explanation { score: number; side: string; centroid: number | null; descriptors: string[]; bpm: number; text: string }
export interface TasteStats { tracks: number; events: number }

const nowSec = () => Math.floor(Date.now() / 1000);

// ── event hooks ───────────────────────────────────────────────────────────────────────────
/** Record a listening signal. Returns the track's new score (null during cold start). */
export async function recordEvent(track: string, kind: EventKind, ts = nowSec()): Promise<number | null> {
  if (!hasTauri) return null;
  try { return await invoke<number | null>("taste_record_event", { track, kind, ts }); } catch { return null; }
}

// ── ingest ──────────────────────────────────────────────────────────────────────────────
/** Float32 PCM → base64 of its little-endian bytes (≈5× smaller over IPC than a JSON number array). */
function f32ToB64(samples: Float32Array): string {
  const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  let bin = "";
  const CH = 0x8000; // chunk so String.fromCharCode doesn't blow the arg-count limit
  for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode(...bytes.subarray(i, i + CH));
  return btoa(bin);
}

/** Analyze mono samples (any sample rate) and add the track. Call `persist()` after a batch.
 *  Ships the samples as base64 (compact) — a JSON number array of ~2M floats chokes the Android IPC
 *  bridge. Falls back to the legacy array command if the base64 one isn't present (pre-rebuild). */
export async function analyzeSamples(track: string, samples: Float32Array, sr: number): Promise<void> {
  if (!hasTauri) return;
  try {
    await invoke<void>("taste_analyze_samples_b64", { track, b64: f32ToB64(samples), sr });
  } catch {
    try { await invoke<void>("taste_analyze_samples", { track, samples: Array.from(samples), sr }); } catch { /* ignore */ }
  }
}
export async function addFingerprint(track: string, v: number[], bpm: number): Promise<void> {
  if (!hasTauri) return;
  try { await invoke<void>("taste_add_fingerprint", { track, v, bpm }); } catch { /* ignore */ }
}
export async function hasFingerprint(track: string): Promise<boolean> {
  if (!hasTauri) return false;
  try { return await invoke<boolean>("taste_has_fingerprint", { track }); } catch { return false; }
}
export async function persist(): Promise<void> {
  if (!hasTauri) return;
  try { await invoke<void>("taste_persist"); } catch { /* ignore */ }
}

// ── scoring / recs ─────────────────────────────────────────────────────────────────────
export async function score(track: string): Promise<number | null> {
  if (!hasTauri) return null;
  try { return await invoke<number | null>("taste_score", { track }); } catch { return null; }
}
export async function scores(tracks: string[]): Promise<(number | null)[]> {
  if (!hasTauri || !tracks.length) return tracks.map(() => null);
  try { return await invoke<(number | null)[]>("taste_scores", { tracks }); } catch { return tracks.map(() => null); }
}
export async function similar(track: string, n = 25, now = nowSec()): Promise<[string, number][]> {
  if (!hasTauri) return [];
  try { return await invoke<[string, number][]>("taste_similar", { track, n, now }); } catch { return []; }
}
/** Vibe search — rank tracks against a *described* sound. `weights` = [featureName, signedStrength]
 *  pairs (built by `lib/vibeSearch.parseVibe`); `bpmMin`/`bpmMax` (≤0 = unbounded) gate by tempo. */
export async function vibe(weights: [string, number][], bpmMin = 0, bpmMax = 0, n = 60): Promise<[string, number][]> {
  if (!hasTauri || !weights.length) return [];
  try { return await invoke<[string, number][]>("taste_vibe", { weights, bpmMin, bpmMax, n }); } catch { return []; }
}
export async function explain(track: string): Promise<Explanation | null> {
  if (!hasTauri) return null;
  try { return await invoke<Explanation | null>("taste_explain", { track }); } catch { return null; }
}
/** Smart-shuffle next track (recency-excluded; cold-start = uniform). */
export async function nextTrack(lastTrack: string | null, now = nowSec()): Promise<string | null> {
  if (!hasTauri) return null;
  try { return await invoke<string | null>("taste_next", { now, lastTrack }); } catch { return null; }
}

// ── stations / clusters / mixes ──────────────────────────────────────────────────────────
export async function stations(): Promise<Station[]> {
  if (!hasTauri) return [];
  try { return await invoke<Station[]>("taste_stations"); } catch { return []; }
}
export async function stationTracks(station: number, n = 50, now = nowSec()): Promise<string[]> {
  if (!hasTauri) return [];
  try { return await invoke<string[]>("taste_station_tracks", { station, n, now }); } catch { return []; }
}
/** Re-cluster "Your genres". `force` (the manual Regroup button) re-runs even if nothing changed;
 *  automatic calls let the backend skip when no new tracks were analyzed since last time. */
export async function recluster(tokens: Record<string, string[]>, force = false): Promise<void> {
  if (!hasTauri) return;
  try { await invoke<void>("taste_recluster", { tokens, force }); } catch { /* ignore */ }
}
export async function clusters(): Promise<ClusterDto[]> {
  if (!hasTauri) return [];
  try { return await invoke<ClusterDto[]>("taste_clusters"); } catch { return []; }
}
export async function generatedMixes(perMix = 50, now = nowSec()): Promise<GeneratedMix[]> {
  if (!hasTauri) return [];
  try { return await invoke<GeneratedMix[]>("taste_generated_mixes", { perMix, now }); } catch { return []; }
}

// ── recipes ──────────────────────────────────────────────────────────────────────────────
export async function generateRecipe(recipe: Recipe, now = nowSec()): Promise<string[]> {
  if (!hasTauri) return [];
  try { return await invoke<string[]>("taste_generate_recipe", { recipe, now }); } catch { return []; }
}
export async function createRecipe(recipe: Recipe, now = nowSec()): Promise<string[]> {
  if (!hasTauri) return [];
  try { return await invoke<string[]>("taste_create_recipe", { recipe, now }); } catch { return []; }
}
export async function recipes(): Promise<Recipe[]> {
  if (!hasTauri) return [];
  try { return await invoke<Recipe[]>("taste_recipes"); } catch { return []; }
}

// ── lifecycle ────────────────────────────────────────────────────────────────────────────
export async function maintain(now = nowSec()): Promise<void> {
  if (!hasTauri) return;
  try { await invoke<void>("taste_maintain", { now }); } catch { /* ignore */ }
}
export async function reset(): Promise<void> {
  if (!hasTauri) return;
  try { await invoke<void>("taste_reset"); } catch { /* ignore */ }
}
export async function stats(): Promise<TasteStats> {
  if (!hasTauri) return { tracks: 0, events: 0 };
  try { return await invoke<TasteStats>("taste_stats"); } catch { return { tracks: 0, events: 0 }; }
}

/**
 * Map a finished listening span to an `EventKind` and record it (the core playback hook).
 * `ended` = the track played out naturally. Otherwise the play fraction grades the skip.
 */
export function reportPlayback(track: string, playedSec: number, durationSec: number, ended: boolean): void {
  let kind: EventKind;
  if (ended) {
    kind = "FullPlay";
  } else if (durationSec <= 0) {
    kind = playedSec >= 30 ? "FullPlay" : "SkipMid"; // unknown length → treat 30s+ as a real listen
  } else {
    const frac = playedSec / durationSec;
    if (frac >= 0.9) kind = "FullPlay";
    else if (playedSec < 15) kind = "SkipEarly";
    else if (frac < 0.5) kind = "SkipMid";
    else kind = "SkipLate";
  }
  void recordEvent(track, kind);
}
