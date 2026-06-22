//! Library-wide z-scoring (Section 2.4). Keeps running per-dimension mean/variance (Welford) so a
//! raw feature vector becomes a z-scored fingerprint comparable across the whole library.

use crate::fingerprint::{Fingerprint, DIMS};
use serde::{Deserialize, Serialize};
use serde_big_array::BigArray;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Normalizer {
    pub count: u64,
    #[serde(with = "BigArray")]
    pub mean: [f64; DIMS],
    #[serde(with = "BigArray")]
    pub m2: [f64; DIMS], // sum of squared deviations
}

impl Default for Normalizer {
    fn default() -> Self {
        Normalizer { count: 0, mean: [0.0; DIMS], m2: [0.0; DIMS] }
    }
}

impl Normalizer {
    pub fn new() -> Self {
        Self::default()
    }

    /// Incorporate one raw feature vector into the running statistics (Welford).
    pub fn observe(&mut self, raw: &[f32; DIMS]) {
        self.count += 1;
        let n = self.count as f64;
        for d in 0..DIMS {
            let x = raw[d] as f64;
            let delta = x - self.mean[d];
            self.mean[d] += delta / n;
            self.m2[d] += delta * (x - self.mean[d]);
        }
    }

    fn std(&self, d: usize) -> f64 {
        if self.count < 2 {
            return 1.0;
        }
        (self.m2[d] / (self.count as f64 - 1.0)).sqrt()
    }

    /// Z-score a raw vector → an L2-normalized fingerprint (`bpm` carried through for display).
    pub fn to_fingerprint(&self, raw: &[f32; DIMS], bpm: f32) -> Fingerprint {
        let mut z = [0.0f32; DIMS];
        for d in 0..DIMS {
            let s = self.std(d);
            z[d] = if s > 1e-9 { ((raw[d] as f64 - self.mean[d]) / s) as f32 } else { 0.0 };
        }
        Fingerprint::from_vec(z, bpm)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zscore_separates_two_clusters() {
        let mut nz = Normalizer::new();
        let mut a = [0.0f32; DIMS];
        a[0] = 10.0;
        let mut b = [0.0f32; DIMS];
        b[0] = -10.0;
        for _ in 0..20 {
            nz.observe(&a);
            nz.observe(&b);
        }
        let fa = nz.to_fingerprint(&a, 120.0);
        let fb = nz.to_fingerprint(&b, 120.0);
        // opposite sign on the discriminating dim after z-scoring
        assert!(fa.v[0] > 0.0 && fb.v[0] < 0.0, "{} {}", fa.v[0], fb.v[0]);
        assert!(crate::fingerprint::cosine(&fa.v, &fb.v) < 0.0, "clusters should be anti-correlated");
    }
}
