//! Phase 5 — host wiring for the `taste` engine: a Tauri-managed `TasteEngine` behind a Mutex,
//! disk persistence under `app_data_dir/taste/`, and the command surface the player calls
//! (event hooks, ingest, scoring, mixes, recipes). `now` is always supplied by the frontend
//! (`Date.now()/1000`) so the engine stays time-source-free, matching the crate's API.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::Serialize;
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use tauri::State;
use tauri::Manager; // for app.state() inside the spawn_blocking worker
use taste::{Event, EventKind, Fingerprint, GeneratedMix, QueueContext, Recipe, Station, TasteEngine, DIMS};

/// Managed state: the engine plus the directory its JSON stores live in.
pub struct TasteState {
    engine: Mutex<TasteEngine>,
    dir: PathBuf,
    /// Fingerprint count at the last successful (re)cluster — lets a rescan skip the expensive
    /// from-scratch k-means when nothing new has been analyzed since. [perf P2]
    last_cluster_n: std::sync::atomic::AtomicUsize,
}

impl TasteState {
    /// Build the engine, restoring any persisted stores from `dir` (Section 8 layout: one JSON
    /// file per sub-state so "reset taste" can drop model+events while keeping fingerprints).
    pub fn load(dir: PathBuf) -> Self {
        let mut e = TasteEngine::new();
        let _ = std::fs::create_dir_all(&dir);
        let read = |name: &str| std::fs::read_to_string(dir.join(name)).ok();
        if let Some(s) = read("fingerprints.json") { e.load_fingerprints_json(&s); }
        if let Some(s) = read("model.json") { e.load_model_json(&s); }
        if let Some(s) = read("events.json") { e.load_events_json(&s); }
        if let Some(s) = read("clusters.json") { e.load_clusters_json(&s); }
        if let Some(s) = read("recipes.json") { e.load_recipes_json(&s); }
        // If clusters were restored, treat the current fingerprint count as "already clustered" so a
        // startup rescan with no new analysis won't pointlessly re-run k-means.
        let last = if e.clusters().is_empty() { 0 } else { e.track_count() };
        TasteState { engine: Mutex::new(e), dir, last_cluster_n: std::sync::atomic::AtomicUsize::new(last) }
    }

    fn write(&self, name: &str, json: &str) -> Result<(), String> {
        std::fs::write(self.dir.join(name), json).map_err(|e| e.to_string())
    }
}

fn lock<'r>(state: &State<'r, TasteState>) -> Result<std::sync::MutexGuard<'r, TasteEngine>, String> {
    state.inner().engine.lock().map_err(|e| e.to_string())
}

// ── DTOs (engine types that aren't `Serialize`, or that we trim for the wire) ─────────────
#[derive(Serialize)]
pub struct ExplanationDto {
    pub score: f32,
    pub side: String,
    pub centroid: Option<usize>,
    pub descriptors: Vec<String>,
    pub bpm: f32,
    pub text: String,
}

/// A library cluster without its 45-dim centroid (the UI only needs identity + art).
#[derive(Serialize)]
pub struct ClusterDto {
    pub id: u32,
    pub name: String,
    pub bpm: f32,
    pub size: usize,
    pub reps: Vec<String>,
}

#[derive(Serialize)]
pub struct TasteStats {
    pub tracks: usize,
    pub events: usize,
}

// ── event hooks (the training signal) ─────────────────────────────────────────────────────
/// Record one listening signal (play/skip/like/…) and persist. Returns the track's new score
/// (None during cold start). `kind` is the `EventKind` variant name, e.g. "FullPlay" / "Like".
#[tauri::command]
pub fn taste_record_event(state: State<TasteState>, track: String, kind: EventKind, ts: i64) -> Result<Option<f32>, String> {
    let mut e = lock(&state)?;
    e.record_event(Event { track: track.clone(), kind, ts });
    state.write("model.json", &e.model_json())?;
    state.write("events.json", &e.events_json())?;
    Ok(e.score(&track))
}

// ── ingest (fingerprints) ────────────────────────────────────────────────────────────────
/// Analyze mono samples (any sample rate — resampled to 22.05 kHz internally) and add the track.
/// Not auto-persisted — call `taste_persist` once after a batch to flush the fingerprint store.
#[tauri::command]
pub fn taste_analyze_samples(state: State<TasteState>, track: String, samples: Vec<f32>, sr: u32) -> Result<(), String> {
    lock(&state)?.analyze_and_add(track, &samples, sr);
    Ok(())
}

/// Same as [`taste_analyze_samples`] but the mono samples arrive as base64 of their little-endian f32
/// bytes. A 90 s @ 22 kHz window is ~2M floats; sent as a JSON number array that's a ~20 MB string
/// which chokes the Android IPC bridge (→ analysis silently failed there). base64 of the raw bytes is
/// ~5× smaller and decodes trivially, so large libraries can actually be fingerprinted on mobile.
#[tauri::command]
pub fn taste_analyze_samples_b64(state: State<TasteState>, track: String, b64: String, sr: u32) -> Result<(), String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64.as_bytes())
        .map_err(|e| e.to_string())?;
    let mut samples = Vec::with_capacity(bytes.len() / 4);
    for c in bytes.chunks_exact(4) {
        samples.push(f32::from_le_bytes([c[0], c[1], c[2], c[3]]));
    }
    lock(&state)?.analyze_and_add(track, &samples, sr);
    Ok(())
}

/// Add a precomputed fingerprint (e.g. restored from an external cache). `v` must be `DIMS` long;
/// it is L2-normalized on insert. Not auto-persisted.
#[tauri::command]
pub fn taste_add_fingerprint(state: State<TasteState>, track: String, v: Vec<f32>, bpm: f32) -> Result<(), String> {
    if v.len() != DIMS {
        return Err(format!("fingerprint must be {DIMS} dims, got {}", v.len()));
    }
    let mut arr = [0.0f32; DIMS];
    arr.copy_from_slice(&v);
    lock(&state)?.add_fingerprint(track, Fingerprint::from_vec(arr, bpm));
    Ok(())
}

/// Whether a track already has a fingerprint (lets the frontend skip re-analysis on rescan).
#[tauri::command]
pub fn taste_has_fingerprint(state: State<TasteState>, track: String) -> Result<bool, String> {
    Ok(lock(&state)?.fingerprint(&track).is_some())
}

/// Flush every store to disk (call after a bulk ingest / reanalysis).
#[tauri::command]
pub fn taste_persist(state: State<TasteState>) -> Result<(), String> {
    let e = lock(&state)?;
    state.write("fingerprints.json", &e.fingerprints_json())?;
    state.write("model.json", &e.model_json())?;
    state.write("events.json", &e.events_json())?;
    state.write("clusters.json", &e.clusters_json())?;
    state.write("recipes.json", &e.recipes_json())?;
    Ok(())
}

// ── scoring / recs ───────────────────────────────────────────────────────────────────────
#[tauri::command]
pub fn taste_score(state: State<TasteState>, track: String) -> Result<Option<f32>, String> {
    Ok(lock(&state)?.score(&track))
}

/// Batch scores aligned to the input order (None per track during cold start / unknown).
#[tauri::command]
pub fn taste_scores(state: State<TasteState>, tracks: Vec<String>) -> Result<Vec<Option<f32>>, String> {
    let e = lock(&state)?;
    Ok(tracks.iter().map(|t| e.score(t)).collect())
}

#[tauri::command]
pub fn taste_similar(state: State<TasteState>, track: String, n: usize, now: i64) -> Result<Vec<(String, f32)>, String> {
    Ok(lock(&state)?.similar(&track, n, now))
}

/// Vibe search — rank fingerprinted tracks against a *described* sound. `weights` is a list of
/// `(feature_name, signed_strength)` assembled by the frontend's vibe lexicon; `bpm_min`/`bpm_max`
/// (≤0 = unbounded) gate by tempo.
#[tauri::command]
pub fn taste_vibe(state: State<TasteState>, weights: Vec<(String, f32)>, bpm_min: f32, bpm_max: f32, n: usize) -> Result<Vec<(String, f32)>, String> {
    Ok(lock(&state)?.vibe_search(&weights, bpm_min, bpm_max, n))
}

#[tauri::command]
pub fn taste_explain(state: State<TasteState>, track: String) -> Result<Option<ExplanationDto>, String> {
    Ok(lock(&state)?.explain(&track).map(|x| ExplanationDto {
        score: x.score,
        side: x.side.to_string(),
        centroid: x.centroid,
        descriptors: x.descriptors,
        bpm: x.bpm,
        text: x.text,
    }))
}

/// Smart-shuffle: the next track for the queue (recency-excluded; cold-start = uniform).
#[tauri::command]
pub fn taste_next(state: State<TasteState>, now: i64, last_track: Option<String>) -> Result<Option<String>, String> {
    Ok(lock(&state)?.next_for_queue(&QueueContext { now, last_track }))
}

// ── stations ─────────────────────────────────────────────────────────────────────────────
#[tauri::command]
pub fn taste_stations(state: State<TasteState>) -> Result<Vec<Station>, String> {
    Ok(lock(&state)?.stations())
}

#[tauri::command]
pub fn taste_station_tracks(state: State<TasteState>, station: usize, n: usize, now: i64) -> Result<Vec<String>, String> {
    Ok(lock(&state)?.station_tracks(station, n, now))
}

// ── clustering ("Your genres") ───────────────────────────────────────────────────────────
/// Re-cluster the library; `tokens` maps track id → folder/tag tokens for auto-naming. Persists.
/// Skips the (expensive, from-scratch) k-means when nothing new has been analyzed since the last
/// cluster, unless `force` is set (the manual "Regroup genres" button). [perf P2]
#[tauri::command]
pub fn taste_recluster(state: State<TasteState>, tokens: HashMap<String, Vec<String>>, force: Option<bool>) -> Result<(), String> {
    use std::sync::atomic::Ordering;
    let mut e = lock(&state)?;
    let n = e.track_count();
    let have_clusters = !e.clusters().is_empty();
    if !force.unwrap_or(false) && have_clusters && state.last_cluster_n.load(Ordering::Relaxed) == n {
        return Ok(()); // unchanged since last clustering → nothing to do
    }
    e.recluster(&tokens);
    state.last_cluster_n.store(n, Ordering::Relaxed);
    state.write("clusters.json", &e.clusters_json())
}

#[tauri::command]
pub fn taste_clusters(state: State<TasteState>) -> Result<Vec<ClusterDto>, String> {
    let e = lock(&state)?;
    Ok(e.clusters()
        .iter()
        .map(|c| ClusterDto { id: c.id, name: c.name.clone(), bpm: c.bpm, size: c.size, reps: c.reps.clone() })
        .collect())
}

// ── generated mixes + recipes (Phase 4 surface) ──────────────────────────────────────────
#[tauri::command]
pub fn taste_generated_mixes(state: State<TasteState>, per_mix: usize, now: i64) -> Result<Vec<GeneratedMix>, String> {
    Ok(lock(&state)?.generated_mixes(per_mix, now))
}

#[tauri::command]
pub fn taste_generate_recipe(state: State<TasteState>, recipe: Recipe, now: i64) -> Result<Vec<String>, String> {
    Ok(lock(&state)?.generate_recipe(&recipe, now))
}

/// Save a recipe and return its freshly generated tracklist. Persists.
#[tauri::command]
pub fn taste_create_recipe(state: State<TasteState>, recipe: Recipe, now: i64) -> Result<Vec<String>, String> {
    let mut e = lock(&state)?;
    let tracks = e.create_recipe(recipe, now);
    state.write("recipes.json", &e.recipes_json())?;
    Ok(tracks)
}

#[tauri::command]
pub fn taste_recipes(state: State<TasteState>) -> Result<Vec<Recipe>, String> {
    Ok(lock(&state)?.recipes().to_vec())
}

// ── maintenance / lifecycle ──────────────────────────────────────────────────────────────
/// Weekly decay + prune (call on launch). Persists the model.
#[tauri::command]
pub fn taste_maintain(state: State<TasteState>, now: i64) -> Result<(), String> {
    let mut e = lock(&state)?;
    e.maintain(now);
    state.write("model.json", &e.model_json())
}

/// "Reset taste": wipe the learned model + events, KEEP fingerprints & recipes. Persists.
#[tauri::command]
pub fn taste_reset(state: State<TasteState>) -> Result<(), String> {
    let mut e = lock(&state)?;
    e.reset_taste();
    state.write("model.json", &e.model_json())?;
    state.write("events.json", &e.events_json())
}

#[tauri::command]
pub fn taste_stats(state: State<TasteState>) -> Result<TasteStats, String> {
    let e = lock(&state)?;
    Ok(TasteStats { tracks: e.track_count(), events: e.event_count() })
}

// ── native library analysis (symphonia decode + rayon) ───────────────────────────────────
const ANALYZE_CAP_SECS: usize = 240; // bound memory/time on very long files (DJ mixes etc.)

/// Decode an audio file to mono f32 + its sample rate (capped at ~240 s). `None` if undecodable.
/// This replaces the Web-Audio decode path for big libraries — no per-track AudioContexts, no huge
/// sample arrays over IPC.
pub(crate) fn decode_mono(path: &str) -> Option<(Vec<f32>, u32)> {
    let file = std::fs::File::open(path).ok()?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = std::path::Path::new(path).extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }
    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &FormatOptions::default(), &MetadataOptions::default())
        .ok()?;
    let mut format = probed.format;
    let track = format.tracks().iter().find(|t| t.codec_params.codec != CODEC_TYPE_NULL)?;
    let track_id = track.id;
    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .ok()?;
    let mut sr = track.codec_params.sample_rate.unwrap_or(44_100);
    let mut mono: Vec<f32> = Vec::new();
    let mut sbuf: Option<SampleBuffer<f32>> = None;
    while let Ok(packet) = format.next_packet() {
        if packet.track_id() != track_id {
            continue;
        }
        let decoded = match decoder.decode(&packet) {
            Ok(d) => d,
            Err(_) => continue, // skip a bad packet, keep going
        };
        let spec = *decoded.spec();
        sr = spec.rate;
        let ch = spec.channels.count().max(1);
        let need = decoded.capacity() as u64 * ch as u64;
        if sbuf.as_ref().map(|b| (b.capacity() as u64) < need).unwrap_or(true) {
            sbuf = Some(SampleBuffer::<f32>::new(decoded.capacity() as u64, spec));
        }
        let sb = sbuf.as_mut().unwrap();
        sb.copy_interleaved_ref(decoded);
        let s = sb.samples();
        let mut i = 0;
        while i + ch <= s.len() {
            let mut acc = 0.0f32;
            for c in 0..ch {
                acc += s[i + c];
            }
            mono.push(acc / ch as f32);
            i += ch;
        }
        if mono.len() >= sr as usize * ANALYZE_CAP_SECS {
            break;
        }
    }
    if mono.is_empty() { None } else { Some((mono, sr)) }
}

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum AnalyzeEvent {
    Progress { done: usize, total: usize, added: usize },
    Done { added: usize },
}

/// Analyze a batch of files NATIVELY: parallel symphonia decode + taste analysis. Skips
/// already-fingerprinted tracks and persists after the batch, so the caller can chunk the library
/// for stop/resume. Streams progress on `on_event`; returns the number newly analyzed.
// The heavy rayon decode runs on a BLOCKING thread pool via spawn_blocking — GUARANTEED off the GTK main
// thread. (An `async fn` body alone still froze the UI here; the idle analyzer firing this every ~5s was
// the recurring multi-second "main-thread blocked" stalls. spawn_blocking owns everything '\''static and
// re-acquires the managed state inside the worker.)
#[tauri::command]
pub async fn taste_analyze_paths(
    app: tauri::AppHandle,
    paths: Vec<String>,
    on_event: tauri::ipc::Channel<AnalyzeEvent>,
) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<usize, String> {
        use rayon::prelude::*;
        use std::sync::atomic::{AtomicUsize, Ordering};
        let state = app.state::<TasteState>();

        let todo: Vec<String> = {
            let e = lock(&state)?;
            paths.into_iter().filter(|p| e.fingerprint(p).is_none()).collect()
        };
        let total = todo.len();
        if total == 0 {
            let _ = on_event.send(AnalyzeEvent::Done { added: 0 });
            return Ok(0);
        }
        let done = AtomicUsize::new(0);
        let added = AtomicUsize::new(0);
        let results: Vec<(String, taste::RawFeatures)> = todo
            .par_iter()
            .filter_map(|p| {
                let out = decode_mono(p).and_then(|(s, sr)| (s.len() >= sr as usize).then(|| taste::analyze_samples(&s, sr)));
                let d = done.fetch_add(1, Ordering::Relaxed) + 1;
                if out.is_some() {
                    added.fetch_add(1, Ordering::Relaxed);
                }
                if d % 32 == 0 || d == total {
                    let _ = on_event.send(AnalyzeEvent::Progress { done: d, total, added: added.load(Ordering::Relaxed) });
                }
                out.map(|raw| (p.clone(), raw))
            })
            .collect();
        {
            let mut e = lock(&state)?;
            for (id, raw) in results {
                e.add_track(id, raw);
            }
            state.write("fingerprints.json", &e.fingerprints_json())?;
        }
        let n = added.load(Ordering::Relaxed);
        let _ = on_event.send(AnalyzeEvent::Done { added: n });
        Ok(n)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn load_creates_dir_and_persists_roundtrip() {
        let dir = std::env::temp_dir().join(format!("wavr_taste_test_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let st = TasteState::load(dir.clone());
        assert!(dir.exists(), "load() creates the store dir");
        {
            let mut e = st.engine.lock().unwrap();
            let mut v = [0.0f32; DIMS];
            v[0] = 1.0;
            e.add_fingerprint("song1", Fingerprint::from_vec(v, 128.0));
            st.write("fingerprints.json", &e.fingerprints_json()).unwrap();
        }
        // a fresh state restores the persisted fingerprint
        let st2 = TasteState::load(dir.clone());
        assert_eq!(st2.engine.lock().unwrap().track_count(), 1, "fingerprints restore from disk");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
