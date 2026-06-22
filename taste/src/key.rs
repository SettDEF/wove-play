//! Musical key detection (Analysis v2 A2) — Krumhansl–Schmuckler key-profile
//! correlation over the averaged chroma, reported as a Camelot code for harmonic
//! mixing (Endless Set). Pure Rust, no deps: the chroma comes from `analysis.rs`'s
//! hand-rolled STFT.
//!
//! Method: correlate the track's 12-bin chroma against the 24 rotations of the
//! Krumhansl major/minor tonal-hierarchy profiles; the best-correlating rotation
//! is the key. Confidence = how far the winner stands above the runner-up.

use crate::analysis::chroma_vector;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeyResult {
    /// Human label, e.g. "A minor" / "C major".
    pub key: String,
    /// Camelot wheel code, e.g. "8A" (A minor) / "8B" (C major).
    pub camelot: String,
    /// Tonic pitch class, 0 = C … 11 = B.
    pub root: u8,
    pub major: bool,
    /// 0..1 — separation of the winning key from the runner-up.
    pub confidence: f32,
}

// Krumhansl–Kessler tonal-hierarchy profiles (probe-tone ratings).
const MAJOR: [f32; 12] = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR: [f32; 12] = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

const NOTES: [&str; 12] = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
// Camelot wheel number per pitch class: B-ring = major, A-ring = minor.
const CAMELOT_MAJOR: [u8; 12] = [8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6, 1];
const CAMELOT_MINOR: [u8; 12] = [5, 12, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10];

/// Pearson correlation of two length-12 vectors.
fn corr(a: &[f32; 12], b: &[f32; 12]) -> f32 {
    let ma = a.iter().sum::<f32>() / 12.0;
    let mb = b.iter().sum::<f32>() / 12.0;
    let mut num = 0.0f32;
    let (mut da, mut db) = (0.0f32, 0.0f32);
    for i in 0..12 {
        let (x, y) = (a[i] - ma, b[i] - mb);
        num += x * y;
        da += x * x;
        db += y * y;
    }
    let den = (da * db).sqrt();
    if den > 1e-9 {
        num / den
    } else {
        0.0
    }
}

/// Detect the key from an already-computed 12-bin chroma vector.
pub fn key_from_chroma(chroma: &[f32; 12]) -> KeyResult {
    // Score all 24 keys (12 roots × major/minor) by correlation with the profile
    // rotated to that root.
    let mut best = (f32::MIN, 0usize, true);
    let mut second = f32::MIN;
    for root in 0..12 {
        let mut prof_maj = [0.0f32; 12];
        let mut prof_min = [0.0f32; 12];
        for i in 0..12 {
            prof_maj[i] = MAJOR[(i + 12 - root) % 12];
            prof_min[i] = MINOR[(i + 12 - root) % 12];
        }
        for (score, major) in [(corr(chroma, &prof_maj), true), (corr(chroma, &prof_min), false)] {
            if score > best.0 {
                second = best.0;
                best = (score, root, major);
            } else if score > second {
                second = score;
            }
        }
    }
    let (score, root, major) = best;
    let camelot_n = if major { CAMELOT_MAJOR[root] } else { CAMELOT_MINOR[root] };
    // Confidence: gap to the runner-up, scaled — well-defined keys separate clearly.
    let conf = if second > f32::MIN {
        ((score - second) * 3.0).clamp(0.0, 1.0)
    } else {
        0.0
    };
    KeyResult {
        key: format!("{} {}", NOTES[root], if major { "major" } else { "minor" }),
        camelot: format!("{}{}", camelot_n, if major { "B" } else { "A" }),
        root: root as u8,
        major,
        confidence: conf,
    }
}

/// Decode-free key detection on mono samples.
pub fn detect_key(samples: &[f32], sample_rate: u32) -> KeyResult {
    key_from_chroma(&chroma_vector(samples, sample_rate))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f32::consts::PI;

    const SR: u32 = 22_050;

    /// Sum of sustained sine tones at the given MIDI notes (a held chord).
    fn chord(midis: &[i32], secs: f32) -> Vec<f32> {
        let n = (SR as f32 * secs) as usize;
        let mut buf = vec![0.0f32; n];
        for &m in midis {
            let f = 440.0 * 2f32.powf((m as f32 - 69.0) / 12.0);
            for i in 0..n {
                buf[i] += (2.0 * PI * f * i as f32 / SR as f32).sin();
            }
        }
        let g = 1.0 / midis.len() as f32;
        for s in buf.iter_mut() {
            *s *= g;
        }
        buf
    }

    #[test]
    fn c_major_triad_reads_c_major() {
        // C4 E4 G4 + the major scale degrees, so the profile correlates cleanly.
        let buf = chord(&[60, 64, 67, 72, 62, 65, 69, 71], 4.0);
        let k = detect_key(&buf, SR);
        assert_eq!(k.key, "C major", "got {} ({})", k.key, k.camelot);
        assert_eq!(k.camelot, "8B");
    }

    #[test]
    fn a_minor_triad_reads_a_minor() {
        // A minor: A C E + natural-minor scale tones.
        let buf = chord(&[57, 60, 64, 69, 59, 62, 65, 67], 4.0);
        let k = detect_key(&buf, SR);
        assert_eq!(k.key, "A minor", "got {} ({})", k.key, k.camelot);
        assert_eq!(k.camelot, "8A");
    }

    #[test]
    fn camelot_tables_are_consistent() {
        // relative major/minor share a Camelot number (e.g. C major 8B ↔ A minor 8A).
        assert_eq!(CAMELOT_MAJOR[0], CAMELOT_MINOR[9]); // C major ↔ A minor = 8
        assert_eq!(CAMELOT_MAJOR[7], CAMELOT_MINOR[4]); // G major ↔ E minor = 9
    }
}
