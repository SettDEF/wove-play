//! Local, content-based music **taste engine** (no UI deps, CPU-only). See the spec.
//!
//! Phase 1 (this file): the engine brain — fingerprint store, listening signals, the weighted-
//! centroid taste model, scoring, similarity, mood stations, smart-shuffle queueing, explainability,
//! recipes, and local storage. Audio→fingerprint extraction (`analysis`) and library clustering /
//! generated mixes / home shelves are later phases (clearly marked TODO).

pub mod analysis;
pub mod beatgrid;
pub mod cluster;
pub mod dj;
pub mod endless;
pub mod events;
pub mod fingerprint;
pub mod full;
pub mod genre;
pub mod key;
pub mod mixes;
pub mod model;
pub mod normalize;
pub mod sections;

pub use analysis::{analyze_samples, RawFeatures};
pub use beatgrid::{analyze_beats, detect_beatgrid, BeatAnalysis, BeatGrid};
pub use cluster::{Cluster, ClusterModel};
pub use dj::{plan_dj_set, DjSet, DjSetOptions, DjStop, DjTrack, EnergyCurve};
pub use endless::{build_endless_set, camelot_distance, plan_transition, EndlessSet, SetStop, Transition};
pub use events::{Event, EventKind};
pub use fingerprint::{cosine, l2_normalize, Fingerprint, FEATURE_NAMES, DIMS};
pub use full::{analyze_full, Section, TrackAnalysis, ANALYSIS_VERSION};
pub use genre::{classify_genre, GenreFeatures, GenreResult};
pub use key::{detect_key, key_from_chroma, KeyResult};
pub use sections::detect_sections;
pub use mixes::{flow_order, transition_cost, GeneratedMix, MixKind};
pub use model::{Explanation, TasteModel};
pub use normalize::Normalizer;

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Below this many events the UI shows no scores; we navigate by similarity + uniform shuffle.
pub const COLD_START_EVENTS: usize = 30;
const RECENCY_HOURS: i64 = 8;
const SOFTMAX_T: f32 = 0.3;
const EPSILON: f32 = 0.12;

/// A mood station = one positive taste centroid surfaced as an auto-named radio.
#[derive(Clone, Debug, Serialize)]
pub struct Station {
    pub id: usize,
    pub name: String,
    pub bpm: f32,
}

/// A custom-mix recipe (Section 6.3) — stored, regenerated on open. (Generation = Phase 3.)
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Recipe {
    pub name: String,
    #[serde(default)]
    pub seeds: Vec<String>,
    #[serde(default)]
    pub size: usize,
    #[serde(default)]
    pub order: String, // "flow" | "score" | "shuffle"
}

/// Context for `next_for_queue`.
#[derive(Clone, Debug, Default)]
pub struct QueueContext {
    pub now: i64,
    pub last_track: Option<String>,
}

#[derive(Default)]
pub struct TasteEngine {
    fps: HashMap<String, Fingerprint>,
    raws: HashMap<String, ([f32; DIMS], f32)>, // raw features (for re-z-scoring on library growth)
    norm: Normalizer,
    normed_at: usize,
    model: TasteModel,
    clusters: ClusterModel,
    events: Vec<Event>,
    last_played: HashMap<String, i64>,
    recipes: Vec<Recipe>,
    rng: u64,
}

fn next_rand(state: &mut u64) -> f32 {
    // xorshift64* → [0,1)
    let mut x = if *state == 0 { 0x9E3779B97F4A7C15 } else { *state };
    x ^= x >> 12;
    x ^= x << 25;
    x ^= x >> 27;
    *state = x;
    ((x.wrapping_mul(0x2545F4914F6CDD1D) >> 40) as f32) / (1u32 << 24) as f32
}

impl TasteEngine {
    pub fn new() -> Self {
        TasteEngine { rng: 0x1234_5678, ..Default::default() }
    }

    // ── fingerprints ────────────────────────────────────────────────────────
    /// Store a precomputed (already z-scored) fingerprint.
    pub fn add_fingerprint(&mut self, id: impl Into<String>, fp: Fingerprint) {
        self.fps.insert(id.into(), fp);
    }

    /// Add a track from RAW analysis features — z-scores against the library and stores the
    /// fingerprint. Re-z-scores the whole library lazily once it has grown >10% (Section 2.4).
    pub fn add_track(&mut self, id: impl Into<String>, raw: RawFeatures) {
        let id = id.into();
        self.norm.observe(&raw.v);
        let fp = self.norm.to_fingerprint(&raw.v, raw.bpm);
        self.raws.insert(id.clone(), (raw.v, raw.bpm));
        self.fps.insert(id, fp);
        if self.raws.len() as f64 > self.normed_at as f64 * 1.1 {
            self.renormalize();
        }
    }

    /// Analyze mono samples and add the track (the audio→fingerprint pipeline, Section 2).
    pub fn analyze_and_add(&mut self, id: impl Into<String>, samples: &[f32], sr: u32) {
        let raw = analyze_samples(samples, sr);
        self.add_track(id, raw);
    }

    /// Re-z-score every stored track against the current library statistics.
    pub fn renormalize(&mut self) {
        let norm = &self.norm;
        let updates: Vec<(String, Fingerprint)> =
            self.raws.iter().map(|(id, (rv, bpm))| (id.clone(), norm.to_fingerprint(rv, *bpm))).collect();
        for (id, fp) in updates {
            self.fps.insert(id, fp);
        }
        self.normed_at = self.raws.len();
    }
    pub fn fingerprint(&self, id: &str) -> Option<&Fingerprint> {
        self.fps.get(id)
    }
    pub fn track_count(&self) -> usize {
        self.fps.len()
    }
    pub fn event_count(&self) -> usize {
        self.events.len()
    }

    // ── learning ────────────────────────────────────────────────────────────
    pub fn record_event(&mut self, ev: Event) {
        if let Some(fp) = self.fps.get(&ev.track).cloned() {
            self.model.update(&fp, ev.kind.base_weight(), ev.ts); // online: at event time decay≈1
        }
        // recency: any "played" event marks the track as recently heard
        if !matches!(ev.kind, EventKind::Like | EventKind::Dislike | EventKind::AddedManually) {
            self.last_played.insert(ev.track.clone(), ev.ts);
        }
        self.events.push(ev);
        if self.events.len() > events::MAX_EVENTS {
            let drop = self.events.len() - events::MAX_EVENTS;
            self.events.drain(0..drop);
        }
    }

    /// Weekly mass decay + prune (call periodically, e.g. on launch).
    pub fn maintain(&mut self, now: i64) {
        self.model.maintain(now);
    }

    // ── scoring / recs ──────────────────────────────────────────────────────
    /// Taste score in ~[-1,1]. `None` during cold start (Section 7) so the UI hides scores.
    pub fn score(&self, id: &str) -> Option<f32> {
        if self.events.len() < COLD_START_EVENTS {
            return None;
        }
        self.fps.get(id).map(|fp| self.model.score(&fp.v))
    }
    /// Raw score ignoring cold-start gating (for internal ranking / tests).
    pub fn raw_score(&self, id: &str) -> f32 {
        self.fps.get(id).map(|fp| self.model.score(&fp.v)).unwrap_or(0.0)
    }

    /// Content-similar tracks (Section 5.2): cosine to the seed, recency-excluded, top `n`.
    pub fn similar(&self, id: &str, n: usize, now: i64) -> Vec<(String, f32)> {
        let Some(seed) = self.fps.get(id) else { return Vec::new() };
        let mut out: Vec<(String, f32)> = self
            .fps
            .iter()
            .filter(|(k, _)| k.as_str() != id && !self.recently_played(k, now))
            .map(|(k, fp)| (k.clone(), cosine(&seed.v, &fp.v)))
            .collect();
        out.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        out.truncate(n);
        out
    }

    /// **Vibe search** — rank tracks by how well they match a *described* sound rather than a seed
    /// track. `weights` maps fingerprint feature names (see `FEATURE_NAMES`) to signed strengths in
    /// z-score space (e.g. `centroid_mean → -1.0` = "dark", `onset_density → +1.0` = "busy drums").
    /// The query is assembled in the same z-scored/L2-normalized space as the stored fingerprints,
    /// so cosine measures alignment with the desired descriptor directions. `bpm_min`/`bpm_max`
    /// (≤0 = unbounded) gate by tempo. Returns the top `n` `(track, score)` pairs, best first.
    pub fn vibe_search(&self, weights: &[(String, f32)], bpm_min: f32, bpm_max: f32, n: usize) -> Vec<(String, f32)> {
        let mut q = [0f32; DIMS];
        for (name, w) in weights {
            if let Some(i) = FEATURE_NAMES.iter().position(|f| *f == name.as_str()) {
                q[i] = *w;
            }
        }
        l2_normalize(&mut q);
        // a zero query (no recognized terms) would score everything 0 — bail to avoid noise.
        if q.iter().all(|&x| x == 0.0) { return Vec::new(); }
        let mut out: Vec<(String, f32)> = self
            .fps
            .iter()
            .filter(|(_, fp)| (bpm_min <= 0.0 || fp.bpm >= bpm_min) && (bpm_max <= 0.0 || fp.bpm <= bpm_max))
            .map(|(k, fp)| (k.clone(), cosine(&q, &fp.v)))
            .filter(|(_, s)| *s > 0.0)
            .collect();
        out.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        out.truncate(n);
        out
    }

    fn recently_played(&self, id: &str, now: i64) -> bool {
        self.last_played.get(id).map(|&t| now - t < RECENCY_HOURS * 3600).unwrap_or(false)
    }

    /// One station per positive centroid (Section 5.4).
    pub fn stations(&self) -> Vec<Station> {
        self.model
            .pos
            .iter()
            .enumerate()
            .map(|(i, c)| {
                let expl = model::TasteModel { pos: vec![c.clone()], neg: vec![], last_decay: 0 }
                    .explain(&Fingerprint { v: c.v, bpm: c.bpm });
                Station { id: i, name: expl.text, bpm: c.bpm }
            })
            .collect()
    }

    /// Tracks for a station (centroid), ranked by that centroid's similarity alone.
    pub fn station_tracks(&self, station: usize, n: usize, now: i64) -> Vec<String> {
        let Some(c) = self.model.pos.get(station) else { return Vec::new() };
        let mut v: Vec<(String, f32)> = self
            .fps
            .iter()
            .filter(|(k, _)| !self.recently_played(k, now))
            .map(|(k, fp)| (k.clone(), cosine(&c.v, &fp.v)))
            .collect();
        v.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        v.into_iter().take(n).map(|(k, _)| k).collect()
    }

    /// Explain a track's score (Section 4.3).
    pub fn explain(&self, id: &str) -> Option<Explanation> {
        self.fps.get(id).map(|fp| self.model.explain(fp))
    }

    // ── library clustering (Section 6.1, taste-independent "genres") ──────────
    /// Re-cluster the whole library. `tokens` maps track id → folder/tag tokens for auto-naming.
    pub fn recluster(&mut self, tokens: &HashMap<String, Vec<String>>) {
        let empty: Vec<String> = Vec::new();
        let inputs: Vec<cluster::ClusterInput> = self
            .fps
            .iter()
            .map(|(id, fp)| cluster::ClusterInput {
                id: id.as_str(),
                v: &fp.v,
                bpm: fp.bpm,
                tokens: tokens.get(id).map(|t| t.as_slice()).unwrap_or(&empty),
            })
            .collect();
        let mut cm = std::mem::take(&mut self.clusters);
        cm.recluster(&inputs, 6, 16);
        drop(inputs);
        self.clusters = cm;
    }
    pub fn clusters(&self) -> &[Cluster] {
        &self.clusters.clusters
    }
    pub fn clusters_json(&self) -> String {
        serde_json::to_string(&self.clusters).unwrap_or_default()
    }
    pub fn load_clusters_json(&mut self, s: &str) {
        if let Ok(c) = serde_json::from_str::<ClusterModel>(s) {
            self.clusters = c;
        }
    }

    /// Smart-shuffle next track (Section 5.1 + 7): recency-excluded; cold-start = uniform; with
    /// probability ε pick from the least-similar third (exploration); else softmax(score/T).
    pub fn next_for_queue(&mut self, ctx: &QueueContext) -> Option<String> {
        let cands: Vec<&String> = self
            .fps
            .keys()
            .filter(|k| !self.recently_played(k, ctx.now))
            .collect();
        if cands.is_empty() {
            return None;
        }
        // cold start → uniform shuffle
        if self.events.len() < COLD_START_EVENTS {
            let i = (next_rand(&mut self.rng) * cands.len() as f32) as usize;
            return Some(cands[i.min(cands.len() - 1)].clone());
        }
        // exploration: pick from the least-similar third relative to the last track
        if next_rand(&mut self.rng) < EPSILON {
            if let Some(seed) = ctx.last_track.as_ref().and_then(|t| self.fps.get(t)) {
                let mut ranked: Vec<(&String, f32)> =
                    cands.iter().map(|&k| (k, cosine(&seed.v, &self.fps[k].v))).collect();
                ranked.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));
                let third = (ranked.len() / 3).max(1);
                let i = (next_rand(&mut self.rng) * third as f32) as usize;
                return Some(ranked[i.min(third - 1)].0.clone());
            }
        }
        // softmax(score / T) sampling
        let scores: Vec<f32> = cands.iter().map(|&k| self.model.score(&self.fps[k].v)).collect();
        let max = scores.iter().cloned().fold(f32::NEG_INFINITY, f32::max);
        let exps: Vec<f32> = scores.iter().map(|s| ((s - max) / SOFTMAX_T).exp()).collect();
        let sum: f32 = exps.iter().sum();
        let mut r = next_rand(&mut self.rng) * sum;
        for (i, &e) in exps.iter().enumerate() {
            r -= e;
            if r <= 0.0 {
                return Some(cands[i].clone());
            }
        }
        Some(cands[cands.len() - 1].clone())
    }

    // ── recipes & generated mixes (Section 6.2 / 6.3) ─────────────────────────
    pub fn save_recipe(&mut self, recipe: Recipe) {
        if let Some(slot) = self.recipes.iter_mut().find(|r| r.name == recipe.name) {
            *slot = recipe;
        } else {
            self.recipes.push(recipe);
        }
    }
    pub fn recipes(&self) -> &[Recipe] {
        &self.recipes
    }

    /// Order a candidate id set per a recipe `order` ("flow" | "score" | "shuffle").
    /// "flow" walks a smooth DJ-style path (see `mixes::flow_order`) starting from `start_id`.
    fn order_tracks(&mut self, ids: Vec<String>, order: &str, start_id: Option<&str>) -> Vec<String> {
        match order {
            "score" => {
                let mut v: Vec<(String, f32)> =
                    ids.into_iter().map(|id| {
                        let s = self.fps.get(&id).map(|fp| self.model.score(&fp.v)).unwrap_or(0.0);
                        (id, s)
                    }).collect();
                v.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
                v.into_iter().map(|(id, _)| id).collect()
            }
            "shuffle" => {
                // Fisher–Yates with the engine's seedable rng (deterministic for tests/replay).
                let mut v = ids;
                for i in (1..v.len()).rev() {
                    let j = (next_rand(&mut self.rng) * (i as f32 + 1.0)) as usize;
                    v.swap(i, j.min(i));
                }
                v
            }
            _ => {
                // "flow": greedy nearest-neighbour through fingerprint space.
                let present: Vec<String> = ids.into_iter().filter(|id| self.fps.contains_key(id)).collect();
                if present.len() < 3 {
                    return present;
                }
                let vs: Vec<[f32; DIMS]> = present.iter().map(|id| self.fps[id].v).collect();
                let bpms: Vec<f32> = present.iter().map(|id| self.fps[id].bpm).collect();
                let start = start_id.and_then(|s| present.iter().position(|id| id == s)).unwrap_or(0);
                mixes::flow_order(&vs, &bpms, start).into_iter().map(|i| present[i].clone()).collect()
            }
        }
    }

    /// Generate the ordered tracklist for a custom-mix recipe (Section 6.3). Candidates are
    /// content-similar to the seeds (or to the strongest taste centroid when seedless),
    /// recency-excluded, ranked by seed affinity blended with taste, then ordered per `recipe.order`.
    pub fn generate_recipe(&mut self, recipe: &Recipe, now: i64) -> Vec<String> {
        let size = recipe.size.max(1);
        let mut seed_vecs: Vec<[f32; DIMS]> =
            recipe.seeds.iter().filter_map(|s| self.fps.get(s).map(|fp| fp.v)).collect();
        if seed_vecs.is_empty() {
            // seedless recipe → seed from the strongest positive taste centroid
            if let Some(c) = self.model.pos.iter().max_by(|a, b| {
                a.mass.partial_cmp(&b.mass).unwrap_or(std::cmp::Ordering::Equal)
            }) {
                seed_vecs.push(c.v);
            }
        }
        if seed_vecs.is_empty() {
            return Vec::new();
        }

        let seeds: std::collections::HashSet<&String> = recipe.seeds.iter().collect();
        let mut ranked: Vec<(String, f32)> = self
            .fps
            .iter()
            .filter(|(k, _)| !self.recently_played(k, now))
            .map(|(k, fp)| {
                let aff = seed_vecs.iter().map(|s| cosine(s, &fp.v)).fold(f32::NEG_INFINITY, f32::max);
                let taste = (self.model.score(&fp.v) + 1.0) * 0.5; // → [0,1]
                let mut rank = 0.75 * aff + 0.25 * taste;
                if seeds.contains(k) {
                    rank += 1.0; // seeds anchor the mix
                }
                (k.clone(), rank)
            })
            .collect();
        ranked.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        ranked.truncate(size);
        let ids: Vec<String> = ranked.into_iter().map(|(k, _)| k).collect();
        let start = recipe.seeds.iter().find(|s| ids.contains(s)).cloned();
        self.order_tracks(ids, &recipe.order, start.as_deref())
    }

    /// Save a recipe and return its freshly generated tracklist (convenience for the UI).
    pub fn create_recipe(&mut self, recipe: Recipe, now: i64) -> Vec<String> {
        let tracks = self.generate_recipe(&recipe, now);
        self.save_recipe(recipe);
        tracks
    }

    /// All auto-generated mixes for the Home view (Section 6.2): one "genre" mix per library
    /// cluster (membership is taste-INDEPENDENT — nearest centroid — only the *order* is
    /// taste-ranked), a personalized "Daily Blend" across the positive taste centroids, and a
    /// "Discover" mix of never-played tracks. `per_mix` caps each mix's length.
    pub fn generated_mixes(&mut self, per_mix: usize, now: i64) -> Vec<GeneratedMix> {
        let per = per_mix.max(1);
        let cold = self.events.len() < COLD_START_EVENTS;
        let mut out: Vec<GeneratedMix> = Vec::new();

        // 1) genre mixes — bucket every track to its nearest cluster centroid.
        let cents: Vec<[f32; DIMS]> = self.clusters.clusters.iter().map(|c| c.centroid).collect();
        if !cents.is_empty() {
            let mut buckets: Vec<Vec<String>> = vec![Vec::new(); cents.len()];
            for (id, fp) in self.fps.iter() {
                let mut best = 0usize;
                let mut bs = f32::NEG_INFINITY;
                for (i, c) in cents.iter().enumerate() {
                    let s = cosine(&fp.v, c);
                    if s > bs {
                        bs = s;
                        best = i;
                    }
                }
                buckets[best].push(id.clone());
            }
            for (ci, cl) in self.clusters.clusters.iter().enumerate() {
                let mut members = std::mem::take(&mut buckets[ci]);
                members.retain(|id| !self.recently_played(id, now));
                if members.is_empty() {
                    continue;
                }
                let cen = cents[ci];
                members.sort_by(|a, b| {
                    let sa = if cold { cosine(&self.fps[a].v, &cen) } else { self.model.score(&self.fps[a].v) };
                    let sb = if cold { cosine(&self.fps[b].v, &cen) } else { self.model.score(&self.fps[b].v) };
                    sb.partial_cmp(&sa).unwrap_or(std::cmp::Ordering::Equal)
                });
                members.truncate(per);
                let reps: Vec<String> = members.iter().take(9).cloned().collect();
                out.push(GeneratedMix {
                    id: format!("genre:{}", cl.id),
                    kind: MixKind::Genre,
                    name: cl.name.clone(),
                    tracks: members,
                    reps,
                });
            }
        }

        // 2) Daily Blend — round-robin the closest tracks of each positive centroid for variety.
        if !cold && !self.model.pos.is_empty() {
            let cand: Vec<String> =
                self.fps.keys().filter(|k| !self.recently_played(k, now)).cloned().collect();
            let mut lists: Vec<std::collections::VecDeque<String>> = self
                .model
                .pos
                .iter()
                .map(|c| {
                    let mut v: Vec<(String, f32)> =
                        cand.iter().map(|k| (k.clone(), cosine(&c.v, &self.fps[k].v))).collect();
                    v.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
                    v.into_iter().take(per).map(|(k, _)| k).collect()
                })
                .collect();
            let mut seen = std::collections::HashSet::new();
            let mut tracks: Vec<String> = Vec::new();
            let mut progress = true;
            while tracks.len() < per && progress {
                progress = false;
                for l in lists.iter_mut() {
                    while let Some(t) = l.pop_front() {
                        if seen.insert(t.clone()) {
                            tracks.push(t);
                            progress = true;
                            break;
                        }
                    }
                    if tracks.len() >= per {
                        break;
                    }
                }
            }
            if !tracks.is_empty() {
                let reps = tracks.iter().take(9).cloned().collect();
                out.push(GeneratedMix {
                    id: "blend".into(),
                    kind: MixKind::Blend,
                    name: "Daily Blend".into(),
                    tracks,
                    reps,
                });
            }
        }

        // 3) Discover — never-played tracks, taste-ranked (when warm) and flow-ordered.
        let mut unheard: Vec<String> =
            self.fps.keys().filter(|k| !self.last_played.contains_key(*k)).cloned().collect();
        if !unheard.is_empty() {
            if !cold {
                unheard.sort_by(|a, b| {
                    self.model
                        .score(&self.fps[b].v)
                        .partial_cmp(&self.model.score(&self.fps[a].v))
                        .unwrap_or(std::cmp::Ordering::Equal)
                });
            }
            unheard.truncate(per);
            let tracks = self.order_tracks(unheard, "flow", None);
            let reps = tracks.iter().take(9).cloned().collect();
            out.push(GeneratedMix {
                id: "discover".into(),
                kind: MixKind::Discover,
                name: "Discover".into(),
                tracks,
                reps,
            });
        }

        out
    }

    /// `generated_mixes` serialized to JSON for the frontend (Phase 5 wiring uses this).
    pub fn generated_mixes_json(&mut self, per_mix: usize, now: i64) -> String {
        serde_json::to_string(&self.generated_mixes(per_mix, now)).unwrap_or_default()
    }

    // ── storage (Section 8) ───────────────────────────────────────────────────
    pub fn model_json(&self) -> String {
        serde_json::to_string(&self.model).unwrap_or_default()
    }
    pub fn load_model_json(&mut self, s: &str) {
        if let Ok(m) = serde_json::from_str::<TasteModel>(s) {
            self.model = m;
        }
    }
    pub fn events_json(&self) -> String {
        serde_json::to_string(&self.events).unwrap_or_default()
    }
    pub fn load_events_json(&mut self, s: &str) {
        if let Ok(evs) = serde_json::from_str::<Vec<Event>>(s) {
            for e in &evs {
                if !matches!(e.kind, EventKind::Like | EventKind::Dislike | EventKind::AddedManually) {
                    self.last_played.insert(e.track.clone(), e.ts);
                }
            }
            self.events = evs;
        }
    }
    pub fn fingerprints_json(&self) -> String {
        serde_json::to_string(&self.fps).unwrap_or_default()
    }
    pub fn load_fingerprints_json(&mut self, s: &str) {
        if let Ok(m) = serde_json::from_str::<HashMap<String, Fingerprint>>(s) {
            self.fps = m;
        }
    }
    pub fn recipes_json(&self) -> String {
        serde_json::to_string(&self.recipes).unwrap_or_default()
    }
    pub fn load_recipes_json(&mut self, s: &str) {
        if let Ok(r) = serde_json::from_str::<Vec<Recipe>>(s) {
            self.recipes = r;
        }
    }

    /// "Reset taste" — wipe the learned model + events, KEEP fingerprints & recipes (Section 8).
    pub fn reset_taste(&mut self) {
        self.model = TasteModel::new();
        self.events.clear();
        self.last_played.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lcg(state: &mut u64) -> f32 {
        *state = state.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        (((*state >> 33) as f32) / (1u32 << 31) as f32) * 2.0 - 1.0 // ~[-1,1]
    }

    // Two near-orthogonal "style" directions in 45-d space.
    fn techno_center() -> [f32; DIMS] {
        let mut c = [0.0f32; DIMS];
        for d in [26, 30, 34, 35, 38, 39, 40, 44] { c[d] = 2.0; } // bright, aggressive, loud/punchy, fast, dense, bass
        c
    }
    fn ambient_center() -> [f32; DIMS] {
        let mut c = [0.0f32; DIMS];
        for d in [14, 16, 18, 20, 32, 43] { c[d] = 2.0; } // varied mfcc, flat/noisy-tonal, atonal harmony
        c[38] = -1.0; // slow
        c
    }
    fn mk(center: &[f32; DIMS], bpm: f32, seed: &mut u64) -> Fingerprint {
        let mut v = *center;
        for x in v.iter_mut() { *x += 0.12 * lcg(seed); }
        Fingerprint::from_vec(v, bpm)
    }

    #[test]
    fn ac2_techno_liked_ambient_skipped() {
        let mut e = TasteEngine::new();
        let mut s = 1u64;
        for i in 0..50 {
            let id = format!("t{i}");
            e.add_fingerprint(&id, mk(&techno_center(), 155.0, &mut s));
            e.record_event(Event { track: id, kind: EventKind::FullPlay, ts: 1000 });
        }
        for i in 0..30 {
            let id = format!("a{i}");
            e.add_fingerprint(&id, mk(&ambient_center(), 75.0, &mut s));
            e.record_event(Event { track: id, kind: EventKind::SkipEarly, ts: 1000 });
        }
        e.add_fingerprint("unseen_techno", mk(&techno_center(), 152.0, &mut s));
        e.add_fingerprint("unseen_ambient", mk(&ambient_center(), 80.0, &mut s));
        let st = e.raw_score("unseen_techno");
        let sa = e.raw_score("unseen_ambient");
        assert!(st > 0.4, "unseen techno should score > 0.4, got {st}");
        assert!(sa < 0.0, "unseen ambient should score < 0, got {sa}");
    }

    #[test]
    fn ac3_two_liked_styles_two_centroids() {
        let mut e = TasteEngine::new();
        let mut s = 7u64;
        for i in 0..20 {
            let id = format!("k{i}");
            e.add_fingerprint(&id, mk(&techno_center(), 155.0, &mut s));
            e.record_event(Event { track: id, kind: EventKind::Like, ts: 1000 });
        }
        for i in 0..20 {
            let id = format!("d{i}");
            e.add_fingerprint(&id, mk(&ambient_center(), 90.0, &mut s));
            e.record_event(Event { track: id, kind: EventKind::Like, ts: 1000 });
        }
        assert!(e.model.pos.len() >= 2, "expected >=2 positive centroids, got {}", e.model.pos.len());

        e.add_fingerprint("techno_core", mk(&techno_center(), 155.0, &mut s));
        e.add_fingerprint("ambient_core", mk(&ambient_center(), 90.0, &mut s));
        // a track between the two clusters
        let mut between = techno_center();
        let amb = ambient_center();
        for d in 0..DIMS { between[d] = 0.5 * (between[d] + amb[d]); }
        e.add_fingerprint("between", Fingerprint::from_vec(between, 120.0));

        let core_t = e.raw_score("techno_core");
        let core_a = e.raw_score("ambient_core");
        let mid = e.raw_score("between");
        assert!(core_t > 0.0 && core_a > 0.0, "both styles positive ({core_t}, {core_a})");
        assert!(mid < core_t && mid < core_a, "between ({mid}) should be < either core ({core_t},{core_a})");
    }

    #[test]
    fn ac4_scoring_10k_is_fast() {
        let mut e = TasteEngine::new();
        let mut s = 3u64;
        for i in 0..40 {
            let id = format!("seed{i}");
            e.add_fingerprint(&id, mk(&techno_center(), 150.0, &mut s));
            e.record_event(Event { track: id, kind: EventKind::FullPlay, ts: 1000 });
        }
        let ids: Vec<String> = (0..10_000)
            .map(|i| {
                let id = format!("lib{i}");
                e.add_fingerprint(&id, mk(&techno_center(), 150.0, &mut s));
                id
            })
            .collect();
        let t = std::time::Instant::now();
        let mut acc = 0.0f32;
        for id in &ids {
            acc += e.raw_score(id);
        }
        let ms = t.elapsed().as_secs_f64() * 1000.0;
        assert!(acc.is_finite());
        // release target is <5ms; debug is slower — keep a generous ceiling so CI/debug passes.
        assert!(ms < 120.0, "scoring 10k took {ms:.2} ms (release target <5ms)");
        println!("scored 10k in {ms:.3} ms (debug)");
    }

    #[test]
    fn ac5_explainable() {
        let mut e = TasteEngine::new();
        let mut s = 9u64;
        for i in 0..40 {
            let id = format!("x{i}");
            e.add_fingerprint(&id, mk(&techno_center(), 155.0, &mut s));
            e.record_event(Event { track: id, kind: EventKind::FullPlay, ts: 1000 });
        }
        let ex = e.explain("x0").unwrap();
        assert!(!ex.text.is_empty());
        assert!(ex.text.contains("BPM"), "explanation should mention BPM: {}", ex.text);
        assert!(!e.stations().is_empty(), "should expose at least one station");
    }

    #[test]
    fn ac6_reset_keeps_fingerprints() {
        let mut e = TasteEngine::new();
        let mut s = 5u64;
        for i in 0..40 {
            let id = format!("r{i}");
            e.add_fingerprint(&id, mk(&techno_center(), 150.0, &mut s));
            e.record_event(Event { track: id, kind: EventKind::FullPlay, ts: 1000 });
        }
        let fps_json = e.fingerprints_json();
        assert!(e.event_count() > 0 && !e.model.pos.is_empty());
        e.reset_taste();
        assert_eq!(e.event_count(), 0);
        assert!(e.model.pos.is_empty() && e.model.neg.is_empty());
        assert_eq!(e.track_count(), 40, "fingerprints survive a taste reset");
        // and they round-trip
        let mut e2 = TasteEngine::new();
        e2.load_fingerprints_json(&fps_json);
        assert_eq!(e2.track_count(), 40);
    }

    #[test]
    fn decay_weight_halves_at_90_days() {
        let ev = Event { track: "t".into(), kind: EventKind::Like, ts: 0 };
        let now = 90 * 86_400;
        let w = ev.weight_at(now);
        assert!((w - 0.75).abs() < 0.02, "1.5 * 0.5 at 90d = 0.75, got {w}");
    }

    fn osc(freq: f32, secs: f32) -> Vec<f32> {
        let sr = analysis::TARGET_SR;
        let n = (sr as f32 * secs) as usize;
        (0..n).map(|i| (2.0 * std::f32::consts::PI * freq * i as f32 / sr as f32).sin()).collect()
    }
    fn hiss(seed: u64, secs: f32) -> Vec<f32> {
        let sr = analysis::TARGET_SR;
        let n = (sr as f32 * secs) as usize;
        let mut st = seed;
        (0..n).map(|_| { st = st.wrapping_mul(6364136223846793005).wrapping_add(1); (((st >> 33) as f32) / (1u32 << 31) as f32) * 2.0 - 1.0 }).collect()
    }

    #[test]
    fn full_pipeline_audio_to_score() {
        // analyze real synthetic audio through the whole stack, learn, then score unseen audio.
        let mut e = TasteEngine::new();
        for i in 0..20 {
            e.analyze_and_add(format!("tone{i}"), &osc(220.0 + i as f32, 3.0), analysis::TARGET_SR);
            e.record_event(Event { track: format!("tone{i}"), kind: EventKind::FullPlay, ts: 1000 });
        }
        for i in 0..18 {
            e.analyze_and_add(format!("hiss{i}"), &hiss(7 + i as u64, 3.0), analysis::TARGET_SR);
            e.record_event(Event { track: format!("hiss{i}"), kind: EventKind::SkipEarly, ts: 1000 });
        }
        e.renormalize();
        e.analyze_and_add("unseen_tone", &osc(260.0, 3.0), analysis::TARGET_SR);
        e.analyze_and_add("unseen_hiss", &hiss(999, 3.0), analysis::TARGET_SR);
        let st = e.raw_score("unseen_tone");
        let sh = e.raw_score("unseen_hiss");
        assert!(st > sh, "liked tone ({st}) should outscore skipped noise ({sh})");
    }

    #[test]
    fn recipe_json_roundtrip() {
        let mut e = TasteEngine::new();
        e.save_recipe(Recipe { name: "Flow".into(), seeds: vec!["a".into(), "b".into()], size: 40, order: "flow".into() });
        let j = e.recipes_json();
        let mut e2 = TasteEngine::new();
        e2.load_recipes_json(&j);
        assert_eq!(e2.recipes().len(), 1);
        assert_eq!(e2.recipes()[0].order, "flow");
    }

    // Build a library of `n` techno + `n` ambient tracks; optionally Like them to warm taste.
    fn two_style_lib(n: usize, like: bool, seed: u64) -> (TasteEngine, HashMap<String, Vec<String>>) {
        let mut e = TasteEngine::new();
        let mut s = seed;
        let mut tokens = HashMap::new();
        for i in 0..n {
            let id = format!("t{i}");
            e.add_fingerprint(&id, mk(&techno_center(), 150.0, &mut s));
            tokens.insert(id.clone(), vec!["techno".to_string()]);
            if like {
                e.record_event(Event { track: id, kind: EventKind::Like, ts: 1000 });
            }
        }
        for i in 0..n {
            let id = format!("a{i}");
            e.add_fingerprint(&id, mk(&ambient_center(), 80.0, &mut s));
            tokens.insert(id.clone(), vec!["ambient".to_string()]);
            if like {
                e.record_event(Event { track: id, kind: EventKind::Like, ts: 1000 });
            }
        }
        (e, tokens)
    }

    #[test]
    fn recipe_generation_score_flow_shuffle() {
        let (mut e, _) = two_style_lib(40, true, 11);
        let now = 1000 + 100 * 86_400; // far past the 8h recency window
        let base = Recipe { name: "Mix".into(), seeds: vec!["t0".into()], size: 12, order: "score".into() };

        let scored = e.generate_recipe(&base, now);
        assert_eq!(scored.len(), 12, "recipe honours size");
        let techno = scored.iter().filter(|t| t.starts_with('t')).count();
        assert!(techno >= 10, "seed-similar tracks dominate the mix ({techno}/12 techno)");
        assert!(scored.contains(&"t0".to_string()), "the seed anchors its own mix");

        // flow keeps the same membership, only reorders it
        let flowed = e.generate_recipe(&Recipe { order: "flow".into(), ..base.clone() }, now);
        let a: std::collections::HashSet<_> = scored.iter().collect();
        let b: std::collections::HashSet<_> = flowed.iter().collect();
        assert_eq!(a, b, "flow reorders the same set of tracks");

        // shuffle: same length, deterministic under the seeded rng
        let shuffled = e.generate_recipe(&Recipe { order: "shuffle".into(), ..base.clone() }, now);
        assert_eq!(shuffled.len(), 12);
    }

    #[test]
    fn seedless_recipe_uses_taste() {
        let (mut e, _) = two_style_lib(40, true, 13); // techno + ambient both Liked
        // Like techno harder so it owns the strongest centroid
        for i in 0..40 {
            e.record_event(Event { track: format!("t{i}"), kind: EventKind::Like, ts: 1000 });
        }
        let now = 1000 + 100 * 86_400;
        let r = Recipe { name: "Auto".into(), seeds: vec![], size: 10, order: "score".into() };
        let tracks = e.generate_recipe(&r, now);
        assert_eq!(tracks.len(), 10, "seedless recipe still fills to size from taste");
        let techno = tracks.iter().filter(|t| t.starts_with('t')).count();
        assert!(techno >= 7, "seedless mix leans to the strongest taste centroid ({techno}/10)");
    }

    #[test]
    fn generated_mixes_cover_genres_blend_discover() {
        let (mut e, tokens) = two_style_lib(40, true, 21);
        e.recluster(&tokens);
        let now = 1000 + 100 * 86_400;
        let ms = e.generated_mixes(8, now);

        // genre mixes: ≥2, each non-empty, ≤9 reps, pure by family
        let genres: Vec<&GeneratedMix> = ms.iter().filter(|m| m.kind == MixKind::Genre).collect();
        assert!(genres.len() >= 2, "expected >=2 genre mixes, got {}", genres.len());
        for g in &genres {
            assert!(!g.tracks.is_empty(), "genre mix '{}' is empty", g.name);
            assert!(g.reps.len() <= 9 && g.tracks.len() <= 8);
            let fam = g.tracks[0].chars().next().unwrap();
            let pure = g.tracks.iter().filter(|t| t.chars().next().unwrap() == fam).count();
            assert!(pure as f32 >= 0.8 * g.tracks.len() as f32, "genre '{}' mixes families", g.name);
        }

        // personalized blend + discover shelves are present, and JSON serializes
        assert!(ms.iter().any(|m| m.kind == MixKind::Blend), "expected a Daily Blend");
        assert!(ms.iter().any(|m| m.kind == MixKind::Discover), "expected a Discover mix");
        let json = e.generated_mixes_json(8, now);
        assert!(json.contains("\"genre\"") && json.contains("\"blend\""), "mixes serialize with kinds: {json:.0}");
    }

    #[test]
    fn generated_mixes_work_during_cold_start() {
        // No events → cold start. Genre mixes (cluster-based) should still appear, ordered by
        // centroid similarity rather than taste; no Blend (needs taste) but Discover is fine.
        let (mut e, tokens) = two_style_lib(20, false, 31);
        e.recluster(&tokens);
        let now = 1000 + 100 * 86_400;
        let ms = e.generated_mixes(6, now);
        assert!(ms.iter().any(|m| m.kind == MixKind::Genre), "genre mixes work cold");
        assert!(!ms.iter().any(|m| m.kind == MixKind::Blend), "no blend before taste exists");
        assert!(ms.iter().any(|m| m.kind == MixKind::Discover), "discover works cold (uniform)");
    }

    #[test]
    fn vibe_search_matches_described_sound() {
        // A library split between two near-orthogonal styles. A vibe describing the techno
        // direction (bright + aggressive + dense drums + bass) should rank techno tracks first.
        let mut e = TasteEngine::new();
        let mut s = 3u64;
        for i in 0..30 { e.add_fingerprint(format!("t{i}"), mk(&techno_center(), 152.0, &mut s)); }
        for i in 0..30 { e.add_fingerprint(format!("a{i}"), mk(&ambient_center(), 78.0, &mut s)); }

        let weights = vec![
            ("centroid_mean".to_string(), 1.0),  // bright
            ("flux_mean".to_string(), 1.0),      // aggressive
            ("onset_density".to_string(), 1.0),  // busy drums
            ("low_end".to_string(), 1.0),        // bass
        ];
        let res = e.vibe_search(&weights, 0.0, 0.0, 10);
        assert_eq!(res.len(), 10, "should return n results");
        assert!(res.iter().all(|(id, _)| id.starts_with('t')), "techno vibe ranks techno first: {res:?}");
        // best score must beat any ambient track's score for the same query
        let best_amb = e.vibe_search(&weights, 0.0, 0.0, 60).into_iter()
            .filter(|(id, _)| id.starts_with('a')).map(|(_, s)| s).next_back().unwrap_or(0.0);
        assert!(res[0].1 > best_amb, "techno match {} should beat ambient {}", res[0].1, best_amb);

        // BPM gate excludes the fast techno → only the (slow) ambient tracks survive.
        let slow = e.vibe_search(&weights, 0.0, 100.0, 10);
        assert!(slow.iter().all(|(id, _)| id.starts_with('a')), "bpm<=100 keeps only ambient: {slow:?}");

        // an empty / unrecognized query yields nothing rather than noise.
        assert!(e.vibe_search(&[("nonsense".to_string(), 1.0)], 0.0, 0.0, 10).is_empty());
    }
}
