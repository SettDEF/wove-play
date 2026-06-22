//! Per-track audio analysis (Analysis v2 Stage B): decode → `taste::analyze_full`
//! (tempo/beat-grid + Camelot key) → a version-keyed disk cache under
//! `app_data_dir/analysis/analysis.json`. Re-analyzes lazily when the file's
//! mtime changes or the analysis algorithm version bumps. Reuses the native
//! symphonia decode from `taste.rs`.

use crate::taste::decode_mono;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::State;
use taste::{EndlessSet, TrackAnalysis};

#[derive(Clone, Serialize, Deserialize)]
struct CachedEntry {
    mtime: u64,
    analysis: TrackAnalysis,
}

pub struct AnalysisCache {
    map: Mutex<HashMap<String, CachedEntry>>,
    dir: PathBuf,
}

impl AnalysisCache {
    pub fn load(dir: PathBuf) -> Self {
        let _ = std::fs::create_dir_all(&dir);
        let map = std::fs::read_to_string(dir.join("analysis.json"))
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        AnalysisCache { map: Mutex::new(map), dir }
    }

    fn persist(&self) {
        if let Ok(m) = self.map.lock() {
            if let Ok(s) = serde_json::to_string(&*m) {
                let _ = std::fs::write(self.dir.join("analysis.json"), s);
            }
        }
    }
}

fn file_mtime(path: &str) -> u64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Lowest cache version whose beat/key/SECTION data is still valid. Genre (v3) was ADDITIVE — the
/// beat/key/section algorithms didn't change — so a v2 cache must NOT be invalidated (that re-ran the
/// slow section analysis on every track just to attach genre). Genre simply stays absent on a v2 entry
/// until the track is re-analyzed for another reason. Bump this only when beats/key/sections change.
/// v4: the tempo octave-error fix (118/0.6 prior + whitened ensemble) CHANGES bpm values → invalidate
/// v2/v3 so tracks (e.g. halved gabber) re-detect.
const MIN_VALID_VERSION: u32 = 5;

/// Cached analysis if present AND still valid (same mtime + a compatible algorithm version).
fn cached(cache: &AnalysisCache, path: &str) -> Option<TrackAnalysis> {
    let mt = file_mtime(path);
    let m = cache.map.lock().ok()?;
    let e = m.get(path)?;
    (e.mtime == mt && e.analysis.version >= MIN_VALID_VERSION).then(|| e.analysis.clone())
}

/// Read-only: the cached analysis for a track, or null if not analyzed yet.
#[tauri::command]
pub fn track_analysis(cache: State<AnalysisCache>, path: String) -> Option<TrackAnalysis> {
    cached(&cache, &path)
}

/// Analyze one track now (returns cached if fresh). Decodes on a blocking-friendly
/// command thread; the frontend should call this off the render path.
#[tauri::command]
pub async fn analyze_track(cache: State<'_, AnalysisCache>, path: String) -> Result<TrackAnalysis, String> {
    if let Some(a) = cached(&cache, &path) {
        return Ok(a);
    }
    let (samples, sr) = decode_mono(&path).ok_or_else(|| "decode failed".to_string())?;
    if samples.len() < sr as usize {
        return Err("track too short to analyze".into());
    }
    let a = taste::analyze_full(&samples, sr);
    {
        let mut m = cache.map.lock().map_err(|e| e.to_string())?;
        m.insert(path.clone(), CachedEntry { mtime: file_mtime(&path), analysis: a.clone() });
    }
    cache.persist();
    Ok(a)
}

/// Build an **Endless Set** (beatmatched/key-aware auto-DJ) over the given track
/// paths, using ONLY tracks already analyzed (fresh in the cache). `start` (a path)
/// anchors the first track; `overlap_beats` is the desired crossfade length. The
/// returned set's stop ids are the input paths, so the frontend maps them straight
/// back to library tracks. Unanalyzed paths are silently skipped (the UI analyzes
/// first), and `skipped` reports how many were left out.
#[derive(Clone, Serialize)]
pub struct EndlessSetResult {
    pub set: EndlessSet,
    pub skipped: usize,
}

#[tauri::command]
pub fn endless_set(
    cache: State<AnalysisCache>,
    paths: Vec<String>,
    start: Option<String>,
    overlap_beats: Option<f32>,
) -> EndlessSetResult {
    let total = paths.len();
    let pool: Vec<(String, TrackAnalysis)> = paths
        .into_iter()
        .filter_map(|p| cached(&cache, &p).map(|a| (p, a)))
        .collect();
    let skipped = total - pool.len();
    let set = taste::build_endless_set(&pool, start.as_deref(), overlap_beats.unwrap_or(16.0));
    EndlessSetResult { set, skipped }
}

/// Build a **DJ set** (genre + harmonic + BPM-ramp + energy-curve ordering) over the given paths,
/// using ONLY tracks already analyzed AND classified (a genre present, i.e. cache ≥ v3). Stop ids are
/// the input paths so the frontend maps them straight back to library tracks + makes a playlist.
#[derive(Deserialize)]
pub struct DjSetArgs {
    pub genre: Option<String>,
    pub subgenre: Option<String>,
    pub curve: Option<String>, // "rise" | "descend" | "peak" | "plateau" | "wave"
    pub max_len: Option<usize>,
    pub harmonic: Option<bool>,
    pub max_bpm_jump: Option<f32>,
}

#[derive(Clone, Serialize)]
pub struct DjSetResult {
    pub set: taste::DjSet,
    pub skipped: usize,  // paths with no fresh analysis / no genre
    pub analyzed: usize, // paths that contributed to the pool
}

#[tauri::command]
pub fn dj_set(cache: State<AnalysisCache>, paths: Vec<String>, opts: DjSetArgs) -> DjSetResult {
    let total = paths.len();
    let pool: Vec<taste::DjTrack> = paths
        .into_iter()
        .filter_map(|p| {
            let a = cached(&cache, &p)?;
            let g = a.genre?; // needs classification (analysis v3+)
            Some(taste::DjTrack { id: p, bpm: a.bpm, camelot: a.camelot, energy: g.energy, genre: g.genre, subgenre: g.subgenre })
        })
        .collect();
    let analyzed = pool.len();
    let curve = match opts.curve.as_deref() {
        Some("rise") => taste::EnergyCurve::Rise,
        Some("descend") => taste::EnergyCurve::Descend,
        Some("peak") => taste::EnergyCurve::Peak,
        Some("wave") => taste::EnergyCurve::Wave,
        _ => taste::EnergyCurve::Plateau,
    };
    let options = taste::DjSetOptions {
        genre: opts.genre,
        subgenre: opts.subgenre,
        curve,
        max_len: opts.max_len.unwrap_or(20),
        harmonic: opts.harmonic.unwrap_or(true),
        max_bpm_jump: opts.max_bpm_jump.unwrap_or(8.0),
    };
    let set = taste::plan_dj_set(&pool, &options);
    DjSetResult { set, skipped: total - analyzed, analyzed }
}

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum AnalysisProgress {
    Progress { done: usize, total: usize },
    Done { analyzed: usize },
}

/// Background batch: analyze a library's worth of paths in parallel (rayon),
/// skipping already-cached/fresh tracks, streaming progress, persisting once.
/// The caller chunks the library for stop/resume (like the taste analyzer).
#[tauri::command]
pub async fn analyze_tracks(
    cache: State<'_, AnalysisCache>,
    paths: Vec<String>,
    on_event: tauri::ipc::Channel<AnalysisProgress>,
) -> Result<usize, String> {
    use rayon::prelude::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    let todo: Vec<String> = paths.into_iter().filter(|p| cached(&cache, p).is_none()).collect();
    let total = todo.len();
    if total == 0 {
        let _ = on_event.send(AnalysisProgress::Done { analyzed: 0 });
        return Ok(0);
    }
    let done = AtomicUsize::new(0);
    let results: Vec<(String, u64, TrackAnalysis)> = todo
        .par_iter()
        .filter_map(|p| {
            let out = decode_mono(p)
                .filter(|(s, sr)| s.len() >= *sr as usize)
                .map(|(s, sr)| taste::analyze_full(&s, sr));
            let d = done.fetch_add(1, Ordering::Relaxed) + 1;
            if d % 16 == 0 || d == total {
                let _ = on_event.send(AnalysisProgress::Progress { done: d, total });
            }
            out.map(|a| (p.clone(), file_mtime(p), a))
        })
        .collect();
    let n = results.len();
    {
        let mut m = cache.map.lock().map_err(|e| e.to_string())?;
        for (p, mt, a) in results {
            m.insert(p, CachedEntry { mtime: mt, analysis: a });
        }
    }
    cache.persist();
    let _ = on_event.send(AnalysisProgress::Done { analyzed: n });
    Ok(n)
}
