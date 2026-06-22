//! Phase 4 — generated mixes + recipe ordering (spec Section 6.2 / 6.3).
//!
//! Pure, dependency-free helpers: the "flow" transition model and the greedy nearest-neighbour
//! ordering used by both auto-generated mixes and custom recipes. The `TasteEngine` methods that
//! gather candidates and drive these live in `lib.rs` (they need the model + fingerprint store).

use crate::analysis::fold_bpm;
use crate::fingerprint::{cosine, DIMS};
use serde::Serialize;

/// What produced a generated mix — drives the Home-view shelf grouping and cover-art style.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MixKind {
    /// One auto-detected library cluster ("genre"), taste-ranked in order only.
    Genre,
    /// Personalized blend across the positive taste centroids ("Daily Blend").
    Blend,
    /// Good-taste tracks the user has never played — for exploration.
    Discover,
    /// A user custom-mix recipe.
    Recipe,
}

/// A ready-to-play generated mix: an ordered track-id list plus art reps and a stable id.
#[derive(Clone, Debug, Serialize)]
pub struct GeneratedMix {
    pub id: String,
    pub kind: MixKind,
    pub name: String,
    pub tracks: Vec<String>,
    pub reps: Vec<String>, // up to 9 track ids for the cover-art mosaic
}

/// Transition cost for "flow" ordering: timbral distance plus a tempo-jump penalty.
/// `1 - cosine` lives in `[0, 2]`; the tempo term saturates so a strong timbral/energy match
/// still dominates a small BPM difference. BPM is octave-folded so 75↔150 reads as adjacent.
pub fn transition_cost(va: &[f32; DIMS], bpma: f32, vb: &[f32; DIMS], bpmb: f32) -> f32 {
    let timbral = 1.0 - cosine(va, vb);
    let (fa, fb) = (fold_bpm(bpma), fold_bpm(bpmb));
    let tempo = if fa > 0.0 && fb > 0.0 { ((fa - fb).abs() / 8.0).min(1.5) } else { 0.0 };
    timbral + tempo
}

/// Greedy nearest-neighbour ("flow") ordering: start at `start`, then repeatedly append the
/// unused track with the lowest [`transition_cost`] from the current tail. O(n²) — fine for the
/// few-dozen-track mixes this serves. Returns indices into the input slices.
pub fn flow_order(vs: &[[f32; DIMS]], bpms: &[f32], start: usize) -> Vec<usize> {
    let n = vs.len();
    if n == 0 {
        return Vec::new();
    }
    let start = start.min(n - 1);
    let mut used = vec![false; n];
    let mut order = Vec::with_capacity(n);
    let mut cur = start;
    used[cur] = true;
    order.push(cur);
    for _ in 1..n {
        let mut best: Option<(usize, f32)> = None;
        for j in 0..n {
            if used[j] {
                continue;
            }
            let c = transition_cost(&vs[cur], bpms[cur], &vs[j], bpms[j]);
            if best.map(|(_, bc)| c < bc).unwrap_or(true) {
                best = Some((j, c));
            }
        }
        match best {
            Some((j, _)) => {
                used[j] = true;
                order.push(j);
                cur = j;
            }
            None => break,
        }
    }
    order
}

#[cfg(test)]
mod tests {
    use super::*;

    fn onehot(dims: &[usize]) -> [f32; DIMS] {
        let mut v = [0.0f32; DIMS];
        for &d in dims {
            v[d] = 1.0;
        }
        v
    }

    #[test]
    fn flow_orders_a_chain() {
        // A overlaps B overlaps C overlaps D; A and D share nothing → the only smooth path is
        // the chain A→B→C→D. Greedy NN from A must reproduce it.
        let vs = [onehot(&[0, 1]), onehot(&[1, 2]), onehot(&[2, 3]), onehot(&[3, 4])];
        let bpms = [120.0; 4];
        assert_eq!(flow_order(&vs, &bpms, 0), vec![0, 1, 2, 3]);
        // starting in the middle, NN still follows the chain outward then back is impossible,
        // so it walks one direction first.
        let ord = flow_order(&vs, &bpms, 1);
        assert_eq!(ord[0], 1);
        assert_eq!(ord.len(), 4);
    }

    #[test]
    fn tempo_penalizes_big_jumps() {
        let a = onehot(&[0]);
        let near = transition_cost(&a, 120.0, &a, 124.0); // same timbre, tiny BPM jump
        let far = transition_cost(&a, 120.0, &a, 150.0); // same timbre, big BPM jump
        assert!(far > near, "a larger BPM jump must cost more ({far} vs {near})");
    }

    #[test]
    fn folded_tempo_treats_octaves_as_close() {
        let a = onehot(&[0]);
        // 300 folds to 150 → identical tempo; cost should match a same-tempo transition.
        let folded = transition_cost(&a, 150.0, &a, 300.0);
        let same = transition_cost(&a, 150.0, &a, 150.0);
        assert!((folded - same).abs() < 1e-6, "octave-folded tempo should read as same-tempo");
    }
}
