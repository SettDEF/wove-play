//! Combined per-track analysis (Analysis v2 Stage B). One decode → one struct the
//! host caches: tempo/beat-grid + Camelot key (+ sections once A3 lands). The host
//! decodes the file and calls `analyze_full`; this crate stays decoder-free.

use crate::analysis::analyze_samples;
use crate::beatgrid::analyze_beats;
use crate::genre::{classify_genre, GenreResult};
use crate::key::detect_key;
use serde::{Deserialize, Serialize};

/// Bump when any analysis algorithm changes so cached results re-compute lazily.
pub const ANALYSIS_VERSION: u32 = 5; // v5: genre-driven BPM octave fix (fast-genre protos correct halved BPM)

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrackAnalysis {
    pub version: u32,
    #[serde(default)]
    pub duration: f32, // seconds (needed by the Endless Set transition planner)
    // tempo / beat grid
    pub bpm: f32,
    pub first_beat: f32,
    pub beat_confidence: f32,
    pub is_stable: bool,
    pub beats: Vec<f32>,
    // key
    pub key: String,
    pub camelot: String,
    pub key_confidence: f32,
    // sections: filled in by Stage A3 (structure detection); empty for now.
    #[serde(default)]
    pub sections: Vec<Section>,
    // genre / sub-genre (Phase 1 heuristic). Option so pre-v3 caches still deserialize (→ recompute).
    #[serde(default)]
    pub genre: Option<GenreResult>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Section {
    pub start: f32,
    pub end: f32,
    pub label: String,
    pub energy: f32,
}

/// Decode-free full analysis on mono samples at `sr`.
pub fn analyze_full(samples: &[f32], sr: u32) -> TrackAnalysis {
    let b = analyze_beats(samples, sr);
    let k = detect_key(samples, sr);
    let sections = crate::sections::detect_sections(samples, sr);
    // Genre from the absolute raw features (one extra DSP pass; cached with the rest). Camelot from the
    // key pass is attached so the DJ app gets genre + harmonic key in one struct.
    let raw = analyze_samples(samples, sr);
    let genre = Some(classify_genre(&raw, Some(k.camelot.clone())));
    // The genre pass may correct a halved BPM (fast genre matched at 2×) — trust that for the displayed BPM.
    let bpm = genre.as_ref().map(|g| g.bpm).filter(|&v| v > 0.0).unwrap_or(b.bpm);
    TrackAnalysis {
        version: ANALYSIS_VERSION,
        duration: if sr > 0 { samples.len() as f32 / sr as f32 } else { 0.0 },
        bpm,
        first_beat: b.first_beat,
        beat_confidence: b.confidence,
        is_stable: b.is_stable,
        beats: b.beats,
        key: k.key,
        camelot: k.camelot,
        key_confidence: k.confidence,
        sections,
        genre,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f32::consts::PI;

    #[test]
    fn analyze_full_returns_tempo_and_key() {
        // 120 BPM kick on a C note bed → tempo ~120, a defined key, version stamped.
        let sr = 44_100u32;
        let secs = 12.0;
        let n = (secs * sr as f32) as usize;
        let mut buf = vec![0.0f32; n];
        let beat = 0.5; // 120 BPM
        let mut t = 0.0;
        while t < secs {
            let s = (t * sr as f32) as usize;
            for i in 0..(0.12 * sr as f32) as usize {
                if s + i >= n { break; }
                let ts = i as f32 / sr as f32;
                buf[s + i] += (-ts * 30.0).exp() * (2.0 * PI * 55.0 * ts).sin();
            }
            t += beat;
        }
        let a = analyze_full(&buf, sr);
        assert_eq!(a.version, ANALYSIS_VERSION);
        assert!((a.bpm - 120.0).abs() < 3.0, "bpm {}", a.bpm);
        assert!(!a.key.is_empty() && !a.camelot.is_empty());
        assert!(a.sections.is_empty());
        // genre is computed + carries the camelot through for the DJ app
        let g = a.genre.expect("genre present");
        assert!(!g.subgenre.is_empty());
        assert_eq!(g.camelot, a.camelot);
    }
}
