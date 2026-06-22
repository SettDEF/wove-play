//! Library-wide clustering (Section 6.1) — groups what the library CONTAINS (taste-independent),
//! for the "Your genres" shelves. Spherical k-means (fingerprints are L2-normalized → cosine),
//! auto-k by simplified silhouette, stable identity across reclusters, and auto-naming.

use crate::analysis::fold_bpm;
use crate::fingerprint::{cosine, l2_normalize, DIMS};
use serde::{Deserialize, Serialize};
use serde_big_array::BigArray;
use std::collections::HashMap;

const MATCH_THRESHOLD: f32 = 0.6; // centroid cosine above which a new cluster inherits an old id

/// One library cluster (an auto-detected "genre").
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Cluster {
    pub id: u32,
    pub name: String,
    #[serde(with = "BigArray")]
    pub centroid: [f32; DIMS],
    pub bpm: f32,
    pub size: usize,
    pub reps: Vec<String>, // top-9 representative track ids (closest to centroid) for art mosaics
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct ClusterModel {
    pub clusters: Vec<Cluster>,
    pub next_id: u32,
}

/// Input row for clustering: track id + its fingerprint vector + BPM + naming tokens (folder/tags).
pub struct ClusterInput<'a> {
    pub id: &'a str,
    pub v: &'a [f32; DIMS],
    pub bpm: f32,
    pub tokens: &'a [String],
}

fn rng(state: &mut u64) -> f32 {
    let mut x = if *state == 0 { 0x9E3779B97F4A7C15 } else { *state };
    x ^= x >> 12;
    x ^= x << 25;
    x ^= x >> 27;
    *state = x;
    ((x.wrapping_mul(0x2545F4914F6CDD1D) >> 40) as f32) / (1u32 << 24) as f32
}

/// Spherical k-means: assign by cosine, centroid = L2-normalized mean. Returns (centroids, labels).
fn skmeans(vecs: &[[f32; DIMS]], k: usize, seed: u64) -> (Vec<[f32; DIMS]>, Vec<usize>) {
    let n = vecs.len();
    let mut st = seed;
    // k-means++ init (cosine distance = 1 - cos)
    let mut centroids: Vec<[f32; DIMS]> = Vec::with_capacity(k);
    centroids.push(vecs[(rng(&mut st) * n as f32) as usize % n]);
    while centroids.len() < k {
        let mut d2: Vec<f32> = vecs
            .iter()
            .map(|v| {
                let best = centroids.iter().map(|c| cosine(v, c)).fold(f32::NEG_INFINITY, f32::max);
                let d = 1.0 - best;
                d * d
            })
            .collect();
        let sum: f32 = d2.iter().sum();
        if sum <= 0.0 {
            centroids.push(vecs[(rng(&mut st) * n as f32) as usize % n]);
            continue;
        }
        let mut r = rng(&mut st) * sum;
        let mut pick = n - 1;
        for (i, w) in d2.drain(..).enumerate() {
            r -= w;
            if r <= 0.0 {
                pick = i;
                break;
            }
        }
        centroids.push(vecs[pick]);
    }

    let mut labels = vec![0usize; n];
    for _iter in 0..40 {
        let mut changed = false;
        for (i, v) in vecs.iter().enumerate() {
            let mut best = 0;
            let mut bs = f32::NEG_INFINITY;
            for (c, ce) in centroids.iter().enumerate() {
                let s = cosine(v, ce);
                if s > bs {
                    bs = s;
                    best = c;
                }
            }
            if labels[i] != best {
                labels[i] = best;
                changed = true;
            }
        }
        // recompute centroids
        let mut sums = vec![[0.0f32; DIMS]; k];
        let mut counts = vec![0usize; k];
        for (i, v) in vecs.iter().enumerate() {
            let c = labels[i];
            for d in 0..DIMS {
                sums[c][d] += v[d];
            }
            counts[c] += 1;
        }
        for c in 0..k {
            if counts[c] == 0 {
                // reseed empty cluster to a random point
                centroids[c] = vecs[(rng(&mut st) * n as f32) as usize % n];
            } else {
                let mut m = sums[c];
                for d in 0..DIMS {
                    m[d] /= counts[c] as f32;
                }
                l2_normalize(&mut m);
                centroids[c] = m;
            }
        }
        if !changed && _iter > 0 {
            break;
        }
    }
    (centroids, labels)
}

/// Simplified silhouette (uses centroids, O(n·k)): mean of (b−a)/max(a,b), a=dist-to-own,
/// b=dist-to-nearest-other. Higher is better.
fn simplified_silhouette(vecs: &[[f32; DIMS]], labels: &[usize], centroids: &[[f32; DIMS]]) -> f32 {
    if centroids.len() < 2 {
        return -1.0;
    }
    let mut sum = 0.0f32;
    for (i, v) in vecs.iter().enumerate() {
        let own = labels[i];
        let a = 1.0 - cosine(v, &centroids[own]);
        let mut b = f32::INFINITY;
        for (c, ce) in centroids.iter().enumerate() {
            if c != own {
                b = b.min(1.0 - cosine(v, ce));
            }
        }
        let s = if a.max(b) > 1e-9 { (b - a) / a.max(b) } else { 0.0 };
        sum += s;
    }
    sum / vecs.len() as f32
}

fn titlecase(s: &str) -> String {
    s.split_whitespace()
        .map(|w| {
            let mut c = w.chars();
            match c.next() {
                Some(f) => f.to_uppercase().collect::<String>() + &c.as_str().to_lowercase(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

impl ClusterModel {
    pub fn new() -> Self {
        ClusterModel::default()
    }

    /// Re-cluster the whole library. Picks the best k in `[kmin, kmax]` by silhouette, builds
    /// clusters, keeps stable ids/names across runs, and auto-names each.
    pub fn recluster(&mut self, points: &[ClusterInput], kmin: usize, kmax: usize) {
        let n = points.len();
        if n < 2 {
            self.clusters.clear();
            return;
        }
        let vecs: Vec<[f32; DIMS]> = points.iter().map(|p| *p.v).collect();
        let kmax = kmax.min(n - 1).max(kmin.min(n - 1));

        let mut best: Option<(f32, Vec<[f32; DIMS]>, Vec<usize>)> = None;
        for k in kmin..=kmax {
            if k >= n {
                break;
            }
            let (cents, labels) = skmeans(&vecs, k, 0xC0FFEE ^ k as u64);
            let score = simplified_silhouette(&vecs, &labels, &cents);
            if best.as_ref().map(|(s, _, _)| score > *s).unwrap_or(true) {
                best = Some((score, cents, labels));
            }
        }
        let (_, centroids, labels) = best.unwrap();
        let k = centroids.len();

        // build clusters
        let old = std::mem::take(&mut self.clusters);
        let mut new_clusters: Vec<Cluster> = Vec::new();
        for c in 0..k {
            let members: Vec<usize> = (0..n).filter(|&i| labels[i] == c).collect();
            if members.is_empty() {
                continue;
            }
            let bpm = {
                let folded: Vec<f32> = members.iter().map(|&i| fold_bpm(points[i].bpm)).filter(|b| *b > 0.0).collect();
                if folded.is_empty() { 0.0 } else { folded.iter().sum::<f32>() / folded.len() as f32 }
            };
            // top-9 representatives by cosine to centroid
            let mut byrep: Vec<(usize, f32)> = members.iter().map(|&i| (i, cosine(&vecs[i], &centroids[c]))).collect();
            byrep.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
            let reps: Vec<String> = byrep.iter().take(9).map(|&(i, _)| points[i].id.to_string()).collect();
            let tokens: Vec<&[String]> = members.iter().map(|&i| points[i].tokens).collect();
            let name = name_cluster(&centroids[c], bpm, &tokens);
            new_clusters.push(Cluster { id: 0, name, centroid: centroids[c], bpm, size: members.len(), reps });
        }

        // stable identity: greedily match each new cluster to the closest unused old cluster
        let mut used = vec![false; old.len()];
        for nc in new_clusters.iter_mut() {
            let mut best_i: Option<usize> = None;
            let mut best_s = MATCH_THRESHOLD;
            for (oi, oc) in old.iter().enumerate() {
                if used[oi] {
                    continue;
                }
                let s = cosine(&nc.centroid, &oc.centroid);
                if s > best_s {
                    best_s = s;
                    best_i = Some(oi);
                }
            }
            if let Some(oi) = best_i {
                used[oi] = true;
                nc.id = old[oi].id; // keep card identity
            } else {
                nc.id = self.next_id;
                self.next_id += 1;
            }
        }
        new_clusters.sort_by_key(|c| c.id);
        self.clusters = new_clusters;
    }
}

/// Name a cluster (Section 6.1): folder/tag token majority (≥60%) → that token; else feature
/// deviations + dominant BPM ("Fast & heavy ~155").
fn name_cluster(centroid: &[f32; DIMS], bpm: f32, member_tokens: &[&[String]]) -> String {
    // 1) shared folder/tag token in ≥60% of tracks
    let mut counts: HashMap<&str, usize> = HashMap::new();
    for toks in member_tokens {
        let mut seen: Vec<&str> = Vec::new();
        for t in toks.iter() {
            let t = t.as_str();
            if !seen.contains(&t) {
                seen.push(t);
                *counts.entry(t).or_insert(0) += 1;
            }
        }
    }
    let mut best_tok: Option<(String, usize)> = None;
    for (tok, &c) in counts.iter() {
        if best_tok.as_ref().map(|(_, bc)| c > *bc).unwrap_or(true) {
            best_tok = Some((tok.to_string(), c));
        }
    }
    if let Some((tok, c)) = best_tok {
        if c as f32 >= 0.6 * member_tokens.len() as f32 && !tok.is_empty() {
            return titlecase(&tok);
        }
    }
    // 2) feature deviations + BPM
    let mut idx: Vec<usize> = (0..DIMS).collect();
    idx.sort_by(|&a, &b| centroid[b].abs().partial_cmp(&centroid[a].abs()).unwrap_or(std::cmp::Ordering::Equal));
    let mut words: Vec<String> = Vec::new();
    for &d in &idx {
        if let Some(w) = crate::fingerprint::describe(d, centroid[d]) {
            if !words.contains(&w) {
                words.push(w);
            }
        }
        if words.len() >= 2 {
            break;
        }
    }
    let base = if words.is_empty() {
        "Mixed".to_string()
    } else {
        titlecase(&words.join(" & "))
    };
    if bpm > 1.0 {
        format!("{base} ~{}", bpm.round() as i32)
    } else {
        base
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fingerprint::Fingerprint;

    fn lcg(state: &mut u64) -> f32 {
        *state = state.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        (((*state >> 33) as f32) / (1u32 << 31) as f32) * 2.0 - 1.0
    }
    fn blob(dims: &[usize], bpm: f32, seed: &mut u64) -> (Fingerprint, f32) {
        let mut v = [0.0f32; DIMS];
        for &d in dims {
            v[d] = 2.0;
        }
        for x in v.iter_mut() {
            *x += 0.1 * lcg(seed);
        }
        (Fingerprint::from_vec(v, bpm), bpm)
    }

    #[test]
    fn clusters_separate_two_groups_and_ids_persist() {
        // 6 real micro-genres: 3 in the "techno" family + 3 in the "ambient" family.
        let micro: [(&[usize], &str, f32, char); 6] = [
            (&[26, 30], "techno", 150.0, 't'),
            (&[34, 40], "techno", 150.0, 't'),
            (&[36, 39], "techno", 150.0, 't'),
            (&[14, 32], "ambient", 80.0, 'a'),
            (&[18, 43], "ambient", 80.0, 'a'),
            (&[20, 41], "ambient", 80.0, 'a'),
        ];
        let mut s = 1u64;
        let mut fps: Vec<(String, Fingerprint, Vec<String>)> = Vec::new();
        let gen = |fps: &mut Vec<(String, Fingerprint, Vec<String>)>, s: &mut u64, per: usize, off: usize| {
            for (m, (dims, tok, bpm, g)) in micro.iter().enumerate() {
                for i in 0..per {
                    let (f, _) = blob(dims, *bpm, s);
                    fps.push((format!("{g}{m}_{}", off + i), f, vec![tok.to_string()]));
                }
            }
        };
        gen(&mut fps, &mut s, 200, 0); // 1200 tracks

        let inputs: Vec<ClusterInput> = fps.iter().map(|(id, f, tk)| ClusterInput { id, v: &f.v, bpm: f.bpm, tokens: tk }).collect();
        let mut cm = ClusterModel::new();
        cm.recluster(&inputs, 6, 12);

        // every cluster pure by family (techno 't' vs ambient 'a')
        let fam = |id: &str| id.chars().next().unwrap();
        for c in &cm.clusters {
            let g0 = fam(&c.reps[0]);
            assert!(c.reps.iter().all(|r| fam(r) == g0), "cluster '{}' mixes families", c.name);
        }
        assert!(cm.clusters.iter().any(|c| c.name.contains("Techno")), "names: {:?}", cm.clusters.iter().map(|c| &c.name).collect::<Vec<_>>());
        assert!(cm.clusters.iter().any(|c| c.name.contains("Ambient")));

        let ids_before: std::collections::HashSet<u32> = cm.clusters.iter().map(|c| c.id).collect();
        let n_before = cm.clusters.len();

        // add more tracks of the same micro-genres → recluster → ids persist
        gen(&mut fps, &mut s, 20, 200);
        let inputs2: Vec<ClusterInput> = fps.iter().map(|(id, f, tk)| ClusterInput { id, v: &f.v, bpm: f.bpm, tokens: tk }).collect();
        cm.recluster(&inputs2, 6, 12);
        let kept = cm.clusters.iter().filter(|c| ids_before.contains(&c.id)).count();
        assert!(kept >= n_before - 1, "cluster ids should persist: kept {} of {} (was {})", kept, cm.clusters.len(), n_before);
    }
}
