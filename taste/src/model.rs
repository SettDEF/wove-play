//! Taste model: K positive + K negative weighted centroids in fingerprint space (Section 4).
//! Multi-centroid is required — taste is multi-modal, a single average destroys it.

use crate::fingerprint::{cosine, describe, l2_normalize, Fingerprint, DIMS, FEATURE_NAMES};
use serde::{Deserialize, Serialize};
use serde_big_array::BigArray;

pub const K: usize = 6;
const ETA: f32 = 0.08;
const SPAWN_BELOW: f32 = 0.55; // similarity under which we spawn a new centroid
const SATURATE_K: f32 = 3.0;
const MIN_MASS: f32 = 0.2;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Centroid {
    #[serde(with = "BigArray")]
    pub v: [f32; DIMS],
    pub mass: f32,
    pub bpm: f32,
    pub created_at: i64,
}

/// young centroids count less — `m / (m + 3)`.
fn saturate(m: f32) -> f32 {
    m / (m + SATURATE_K)
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct TasteModel {
    pub pos: Vec<Centroid>,
    pub neg: Vec<Centroid>,
    #[serde(default)]
    pub last_decay: i64,
}

/// A human-readable reason for a score (Section 4.3).
#[derive(Clone, Debug)]
pub struct Explanation {
    pub score: f32,
    pub side: &'static str,        // "positive" | "negative" | "neutral"
    pub centroid: Option<usize>,   // index into the winning side
    pub descriptors: Vec<String>,  // top deviating features as words
    pub bpm: f32,
    pub text: String,              // e.g. "fast (~155 BPM), bass-heavy, bright, dense percussion"
}

impl TasteModel {
    pub fn new() -> Self {
        TasteModel::default()
    }

    fn nearest(list: &[Centroid], v: &[f32; DIMS]) -> Option<(usize, f32)> {
        list.iter()
            .enumerate()
            .map(|(i, c)| (i, cosine(v, &c.v)))
            .max_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal))
    }

    /// Online update after one event with signed weight `w` (Section 4.1).
    pub fn update(&mut self, fp: &Fingerprint, w: f32, ts: i64) {
        if w == 0.0 {
            return; // skip-after-50% etc. carry no signal
        }
        let strength = w.abs();
        let side = if w > 0.0 { &mut self.pos } else { &mut self.neg };

        if let Some((idx, sim)) = Self::nearest(side, &fp.v) {
            if sim >= SPAWN_BELOW {
                // move the centroid toward v, renormalize, grow its mass
                let c = &mut side[idx];
                for i in 0..DIMS {
                    c.v[i] += ETA * strength * (fp.v[i] - c.v[i]);
                }
                l2_normalize(&mut c.v);
                let m0 = c.mass;
                c.mass += strength;
                c.bpm = (c.bpm * m0 + fp.bpm * strength) / (m0 + strength); // mass-weighted BPM
                return;
            }
        }
        // spawn a fresh centroid (merge the two closest first if the side is full)
        if side.len() >= K {
            Self::merge_closest(side);
        }
        side.push(Centroid { v: fp.v, mass: strength, bpm: fp.bpm, created_at: ts });
    }

    /// Merge the two most-similar centroids into one (mass-weighted) — keeps `len <= K`.
    fn merge_closest(side: &mut Vec<Centroid>) {
        if side.len() < 2 {
            return;
        }
        let (mut bi, mut bj, mut best) = (0usize, 1usize, f32::NEG_INFINITY);
        for i in 0..side.len() {
            for j in (i + 1)..side.len() {
                let s = cosine(&side[i].v, &side[j].v);
                if s > best {
                    best = s;
                    bi = i;
                    bj = j;
                }
            }
        }
        let cj = side.remove(bj);
        let ci = &mut side[bi];
        let (mi, mj) = (ci.mass, cj.mass);
        let tot = mi + mj;
        for d in 0..DIMS {
            ci.v[d] = (ci.v[d] * mi + cj.v[d] * mj) / tot;
        }
        l2_normalize(&mut ci.v);
        ci.bpm = (ci.bpm * mi + cj.bpm * mj) / tot;
        ci.mass = tot;
        ci.created_at = ci.created_at.min(cj.created_at);
    }

    /// Best (centroid index, weighted similarity) on a side.
    fn best(list: &[Centroid], v: &[f32; DIMS]) -> Option<(usize, f32)> {
        list.iter()
            .enumerate()
            .map(|(i, c)| (i, cosine(v, &c.v) * saturate(c.mass)))
            .max_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal))
    }

    /// Score a fingerprint in roughly [-1, 1] (Section 4.2).
    pub fn score(&self, v: &[f32; DIMS]) -> f32 {
        let pos = Self::best(&self.pos, v).map(|(_, s)| s).unwrap_or(0.0);
        let neg = Self::best(&self.neg, v).map(|(_, s)| s).unwrap_or(0.0);
        pos - 0.8 * neg
    }

    /// Explain a score: winning centroid + its top deviating features as words (Section 4.3).
    pub fn explain(&self, fp: &Fingerprint) -> Explanation {
        let score = self.score(&fp.v);
        let pos = Self::best(&self.pos, &fp.v);
        let neg = Self::best(&self.neg, &fp.v);
        let (side, idx, cvec) = match (pos, neg) {
            (Some((pi, ps)), n) if ps >= n.map(|(_, s)| s).unwrap_or(0.0) => ("positive", Some(pi), Some(self.pos[pi].v)),
            (_, Some((ni, _))) => ("negative", Some(ni), Some(self.neg[ni].v)),
            _ => ("neutral", None, None),
        };
        let bpm = match (side, idx) {
            ("positive", Some(i)) => self.pos[i].bpm,
            ("negative", Some(i)) => self.neg[i].bpm,
            _ => fp.bpm,
        };
        let descriptors = cvec.map(|c| centroid_descriptors(&c)).unwrap_or_default();
        let mut parts: Vec<String> = Vec::new();
        if bpm > 1.0 {
            let speed = if bpm >= 140.0 { "fast" } else if bpm >= 100.0 { "mid-tempo" } else { "slow" };
            parts.push(format!("{speed} (~{} BPM)", bpm.round() as i32));
        }
        parts.extend(descriptors.iter().cloned());
        let text = if parts.is_empty() { "no strong character yet".to_string() } else { parts.join(", ") };
        Explanation { score, side, centroid: idx, descriptors, bpm, text }
    }

    /// Weekly mass decay + prune (Section 4.1.5). Idempotent; safe to call any time.
    pub fn maintain(&mut self, now: i64) {
        if self.last_decay == 0 {
            self.last_decay = now;
            return;
        }
        let days = ((now - self.last_decay).max(0) as f64) / 86_400.0;
        if days < 7.0 {
            return;
        }
        let factor = 0.5f32.powf((days / 90.0) as f32);
        for side in [&mut self.pos, &mut self.neg] {
            for c in side.iter_mut() {
                c.mass *= factor;
            }
            side.retain(|c| c.mass >= MIN_MASS);
        }
        self.last_decay = now;
    }
}

/// Top-5 deviating dimensions of a centroid, as words (skips BPM dims — reported separately).
fn centroid_descriptors(c: &[f32; DIMS]) -> Vec<String> {
    let mut idx: Vec<usize> = (0..DIMS).collect();
    idx.sort_by(|&a, &b| c[b].abs().partial_cmp(&c[a].abs()).unwrap_or(std::cmp::Ordering::Equal));
    let mut out = Vec::new();
    for &d in &idx {
        if let Some(s) = describe(d, c[d]) {
            if !out.contains(&s) {
                out.push(s);
            }
        }
        if out.len() >= 5 {
            break;
        }
    }
    let _ = FEATURE_NAMES; // names referenced via describe()
    out
}
