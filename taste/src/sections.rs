//! Song structure detection (Analysis v2 A3) — boundaries from MUSIC structure,
//! not just loudness. Classic MIR, pure Rust over the existing STFT: a per-bar
//! feature matrix (MFCC timbre + chroma harmony + RMS energy) → self-similarity
//! matrix → Foote novelty kernel → boundaries snapped to bars → energy-tier
//! labels. This finds where the song actually CHANGES (verse↔drop↔break), which
//! the old energy-only heuristic could not, and feeds the section-painted seekbar,
//! skip-to-drop and Endless Set's transition placement.

use crate::analysis::frame_features;
use crate::beatgrid::detect_beatgrid;
use crate::full::Section;

/// Detect labelled structural sections (seconds). Empty if no tempo/too short.
pub fn detect_sections(samples: &[f32], sample_rate: u32) -> Vec<Section> {
    let grid = detect_beatgrid(samples, sample_rate);
    if grid.bpm <= 0.0 {
        return Vec::new();
    }
    let (frames, fps) = frame_features(samples, sample_rate);
    if frames.len() < 32 || fps <= 0.0 {
        return Vec::new();
    }
    let bar_sec = 4.0 * 60.0 / grid.bpm;
    if bar_sec <= 0.0 {
        return Vec::new();
    }

    // ── per-bar mean feature vectors ─────────────────────────────────────────
    let n_dims = 26;
    let mut sum: Vec<[f64; 26]> = Vec::new();
    let mut cnt: Vec<u32> = Vec::new();
    let mut energy: Vec<f64> = Vec::new(); // mean RMS (dim 25 is logRMS)
    for (fi, fv) in frames.iter().enumerate() {
        let t = fi as f32 / fps;
        let b = ((t - grid.first_beat) / bar_sec).floor();
        if b < 0.0 {
            continue;
        }
        let bi = b as usize;
        if bi >= sum.len() {
            sum.resize(bi + 1, [0.0; 26]);
            cnt.resize(bi + 1, 0);
            energy.resize(bi + 1, 0.0);
        }
        for d in 0..n_dims {
            sum[bi][d] += fv[d] as f64;
        }
        energy[bi] += fv[25].exp() as f64; // back to linear RMS for labelling
        cnt[bi] += 1;
    }
    let nbars = sum.len();
    if nbars < 8 {
        return Vec::new();
    }
    let mut bars: Vec<[f64; 26]> = vec![[0.0; 26]; nbars];
    for b in 0..nbars {
        let c = cnt[b].max(1) as f64;
        for d in 0..n_dims {
            bars[b][d] = sum[b][d] / c;
        }
        energy[b] /= c;
    }

    // ── self-similarity over TIMBRE+HARMONY (dims 1..25 = MFCC 1-12 + chroma;
    //    skip MFCC[0] and logRMS, which are loudness — used for labels, not
    //    structure). Per-bar L2 cosine: a uniform track → all bars identical →
    //    cosine 1 → flat novelty → no spurious boundaries (no cross-bar z-score,
    //    which would turn near-identical bars into noise). ─────────────────────
    const D0: usize = 1;
    const D1: usize = 25;
    let _ = n_dims;
    let norm: Vec<f64> = bars
        .iter()
        .map(|v| (D0..D1).map(|d| v[d] * v[d]).sum::<f64>().sqrt().max(1e-9))
        .collect();
    let sim = |i: usize, j: usize| -> f64 {
        let dot: f64 = (D0..D1).map(|d| bars[i][d] * bars[j][d]).sum();
        dot / (norm[i] * norm[j])
    };

    // ── Foote novelty: checkerboard kernel along the diagonal ────────────────
    let l = (nbars / 6).clamp(2, 16) as isize; // kernel half-size in bars
    let mut nov = vec![0.0f64; nbars];
    for c in 0..nbars as isize {
        let mut acc = 0.0;
        for a in -l..l {
            for b in -l..l {
                let i = c + a;
                let j = c + b;
                if i < 0 || j < 0 || i >= nbars as isize || j >= nbars as isize {
                    continue;
                }
                // checkerboard: +1 when a,b same sign (within a block), −1 across.
                let sign = if (a < 0) == (b < 0) { 1.0 } else { -1.0 };
                // gaussian taper so distant bars matter less.
                let g = (-((a * a + b * b) as f64) / (2.0 * (l as f64) * (l as f64))).exp();
                acc += sign * g * sim(i as usize, j as usize);
            }
        }
        nov[c as usize] = acc;
    }

    // ── peak-pick the novelty curve → boundary bars ──────────────────────────
    let nm = nov.iter().sum::<f64>() / nbars as f64;
    let nsd = (nov.iter().map(|x| (x - nm) * (x - nm)).sum::<f64>() / nbars as f64).sqrt().max(1e-9);
    let thr = nm + 0.6 * nsd;
    let min_gap = ((8.0 / bar_sec).ceil() as usize).max(2); // ≥ ~8 s between boundaries
    let mut bounds: Vec<usize> = vec![0];
    let mut last = 0usize;
    for b in 1..nbars - 1 {
        if nov[b] > thr && nov[b] >= nov[b - 1] && nov[b] > nov[b + 1] && b - last >= min_gap {
            bounds.push(b);
            last = b;
        }
    }
    if *bounds.last().unwrap() != nbars {
        bounds.push(nbars);
    }

    // ── segments + energy-tier labels ────────────────────────────────────────
    let max_e = energy.iter().cloned().fold(0.0f64, f64::max).max(1e-9);
    let mut out: Vec<Section> = Vec::new();
    let nseg = bounds.len() - 1;
    for s in 0..nseg {
        let (b0, b1) = (bounds[s], bounds[s + 1]);
        let seg_e = energy[b0..b1].iter().sum::<f64>() / (b1 - b0).max(1) as f64;
        let rel = (seg_e / max_e) as f32;
        let prev_e = if s > 0 {
            (energy[bounds[s - 1]..b0].iter().sum::<f64>() / (b0 - bounds[s - 1]).max(1) as f64 / max_e) as f32
        } else {
            0.0
        };
        let label = if s == 0 {
            "Intro"
        } else if s == nseg - 1 {
            "Outro"
        } else if rel >= 0.72 {
            "Drop"
        } else if rel < 0.40 {
            "Breakdown"
        } else if rel > prev_e + 0.15 {
            "Build"
        } else {
            "Verse"
        };
        out.push(Section {
            start: grid.first_beat + b0 as f32 * bar_sec,
            end: grid.first_beat + b1 as f32 * bar_sec,
            label: label.to_string(),
            energy: rel,
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f32::consts::PI;

    const SR: u32 = 44_100;

    /// Render a track with N equal-length sections of DISTINCT timbre over a steady
    /// kick (so the beat grid locks), so structure detection has real boundaries.
    fn structured(bpm: f32, secs: f32, timbres: &[f32]) -> Vec<f32> {
        let n = (secs * SR as f32) as usize;
        let mut buf = vec![0.0f32; n];
        let beat = 60.0 / bpm;
        // steady kick for the grid
        let mut t = 0.0;
        while t < secs {
            let s = (t * SR as f32) as usize;
            for i in 0..(0.10 * SR as f32) as usize {
                if s + i >= n { break; }
                let ts = i as f32 / SR as f32;
                buf[s + i] += (-ts * 30.0).exp() * (2.0 * PI * 55.0 * ts).sin() * 0.8;
            }
            t += beat;
        }
        // section-distinct tone
        let seglen = n / timbres.len();
        for (k, &freq) in timbres.iter().enumerate() {
            for i in 0..seglen {
                let idx = k * seglen + i;
                if idx >= n { break; }
                let ts = idx as f32 / SR as f32;
                buf[idx] += (2.0 * PI * freq * ts).sin() * 0.35;
            }
        }
        buf
    }

    #[test]
    fn finds_boundaries_of_distinct_sections() {
        // 4 sections: 200Hz / 2000Hz / 200Hz / 4000Hz over 48 s at 120 BPM.
        let buf = structured(120.0, 48.0, &[200.0, 2000.0, 200.0, 4000.0]);
        let secs = detect_sections(&buf, SR);
        assert!(secs.len() >= 3, "expected several sections, got {}", secs.len());
        // a boundary should land near each true transition (12/24/36 s) within ~3 s.
        let bounds: Vec<f32> = secs.iter().map(|s| s.start).collect();
        for truth in [12.0f32, 24.0, 36.0] {
            let near = bounds.iter().any(|&b| (b - truth).abs() < 3.5);
            assert!(near, "no boundary near {truth}s (got {bounds:?})");
        }
        // sections are ordered, non-overlapping, first labelled Intro.
        assert_eq!(secs[0].label, "Intro");
        for w in secs.windows(2) {
            assert!(w[1].start >= w[0].start, "sections out of order");
        }
    }

    #[test]
    fn uniform_track_makes_few_sections() {
        // one timbre throughout → essentially no internal boundaries.
        let buf = structured(120.0, 40.0, &[440.0]);
        let secs = detect_sections(&buf, SR);
        assert!(secs.len() <= 3, "uniform track over-segmented into {}", secs.len());
    }
}
