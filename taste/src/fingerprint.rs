//! Audio fingerprint: a 45-dim, L2-normalized feature vector + a few human-facing scalars.
//! (Section 2 of the spec. The audio→vector extraction lives in `analysis` — a later phase; this
//! module owns the *type*, the cosine math, and the human-readable feature names for explainability.)

use serde::{Deserialize, Serialize};
use serde_big_array::BigArray;

/// Length of the final fingerprint vector (44 raw dims + 1 octave-folded BPM).
pub const DIMS: usize = 45;

/// Human names for each of the 45 dimensions (used by `explain`). Order matches the spec table.
pub const FEATURE_NAMES: [&str; DIMS] = [
    // MFCC 1..13 mean (timbre)
    "mfcc1_mean", "mfcc2_mean", "mfcc3_mean", "mfcc4_mean", "mfcc5_mean", "mfcc6_mean",
    "mfcc7_mean", "mfcc8_mean", "mfcc9_mean", "mfcc10_mean", "mfcc11_mean", "mfcc12_mean", "mfcc13_mean",
    // MFCC 1..13 std
    "mfcc1_std", "mfcc2_std", "mfcc3_std", "mfcc4_std", "mfcc5_std", "mfcc6_std",
    "mfcc7_std", "mfcc8_std", "mfcc9_std", "mfcc10_std", "mfcc11_std", "mfcc12_std", "mfcc13_std",
    // spectral descriptors (mean, std)
    "centroid_mean", "centroid_std",   // brightness
    "rolloff_mean", "rolloff_std",     // high-freq content
    "flux_mean", "flux_std",           // aggression / change
    "flatness_mean", "flatness_std",   // noisiness
    "rms_mean", "rms_std",             // loudness / punch
    "zcr_mean", "zcr_std",             // distortion / hats
    // track-level scalars
    "tempo_z",        // z-scored BPM
    "onset_density",  // percussiveness
    "low_end",        // bass weight (<150 Hz ratio)
    "mid_hoover",     // synth-lead weight (500 Hz–2 kHz ratio)
    "crest",          // dynamics (peak/RMS dB)
    "chroma_entropy", // harmonic vs atonal
    // octave-folded tempo
    "tempo_folded",
];

/// One analyzed track. `v` is L2-normalized for cosine math; `bpm` is kept raw for display/strings.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Fingerprint {
    #[serde(with = "BigArray")]
    pub v: [f32; DIMS],
    pub bpm: f32,
}

impl Fingerprint {
    /// Build from a 45-dim feature vector (assumed already z-scored); L2-normalizes it.
    pub fn from_vec(mut v: [f32; DIMS], bpm: f32) -> Self {
        l2_normalize(&mut v);
        Fingerprint { v, bpm }
    }
}

/// Cosine similarity of two equal-length vectors. Returns 0 if either is degenerate.
pub fn cosine(a: &[f32; DIMS], b: &[f32; DIMS]) -> f32 {
    let mut dot = 0.0f32;
    let mut na = 0.0f32;
    let mut nb = 0.0f32;
    for i in 0..DIMS {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    if na <= f32::EPSILON || nb <= f32::EPSILON {
        return 0.0;
    }
    dot / (na.sqrt() * nb.sqrt())
}

/// L2-normalize in place (no-op for a zero vector).
pub fn l2_normalize(v: &mut [f32; DIMS]) {
    let mut n = 0.0f32;
    for x in v.iter() {
        n += x * x;
    }
    n = n.sqrt();
    if n > f32::EPSILON {
        for x in v.iter_mut() {
            *x /= n;
        }
    }
}

/// Turn a (dimension, deviation) pair into a short human phrase, or None if not meaningful.
/// `dev` is the centroid component in z-score space (≈ std-devs from the library mean).
pub fn describe(dim: usize, dev: f32) -> Option<String> {
    let hi = dev > 0.0;
    let s = match FEATURE_NAMES[dim] {
        "centroid_mean" => if hi { "bright" } else { "dark" },
        "rolloff_mean" => if hi { "airy highs" } else { "rolled-off highs" },
        "flux_mean" => if hi { "aggressive" } else { "smooth" },
        "flatness_mean" => if hi { "noisy" } else { "tonal" },
        "rms_mean" => if hi { "loud" } else { "quiet" },
        "rms_std" => if hi { "punchy" } else { "compressed" },
        "zcr_mean" => if hi { "distorted/hats" } else { "clean" },
        "onset_density" => if hi { "dense percussion" } else { "sparse percussion" },
        "low_end" => if hi { "bass-heavy" } else { "light low-end" },
        "mid_hoover" => if hi { "synth-forward mids" } else { "scooped mids" },
        "crest" => if hi { "dynamic" } else { "low dynamics" },
        "chroma_entropy" => if hi { "atonal" } else { "harmonic" },
        "tempo_z" | "tempo_folded" => return None, // BPM is reported separately as a number
        name if name.starts_with("mfcc") => if hi { "rich timbre" } else { "plain timbre" },
        _ => return None,
    };
    Some(s.to_string())
}
