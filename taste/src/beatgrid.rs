//! Beat grid + tempo (Analysis v2 A1). PORTED from the WAVR DAW's
//! `engine/analysis/bpm.rs` (proven multi-band onset → autocorrelation +
//! octave resolution → downbeat → phase-polish) and adapted to the taste
//! crate's zero-dependency rule: the DAW used the `biquad` crate; here the
//! band-split filters are hand-rolled RBJ biquads so this stays dep-free and
//! ships to Android without pulling in anything.
//!
//! Genre robustness (the player must read "almost any genre", not just EDM):
//!  - the tempo autocorrelation uses a perceptual log-normal prior centred at
//!    118 BPM + explicit half/double resolution by beat SUPPORT, so hip-hop
//!    (~85) isn't doubled and frenchcore (~200) isn't halved;
//!  - the onset envelope is ENHANCED (local-mean subtraction + whitening)
//!    before tracking, so sparse / acoustic material with no four-on-the-floor
//!    kick still yields usable onsets;
//!  - an Ellis dynamic-programming beat tracker produces per-beat TIMES that
//!    follow tempo drift (live recordings, accelerando), with `is_stable`
//!    telling consumers when the cheap constant grid is trustworthy.
//!
//! Output: `BeatGrid { bpm, first_beat }` is the constant fast path; the richer
//! `BeatAnalysis` adds `beats: Vec<f32>` + `is_stable` + `confidence`.

use serde::{Deserialize, Serialize};

/// A constant-tempo beat grid: a tempo plus the time of the first downbeat.
/// Every beat is `first_beat + n * 60/bpm`; downbeats every 4th beat.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct BeatGrid {
    pub bpm: f32,
    pub first_beat: f32,
}

/// Full beat analysis: the constant grid PLUS the drift-following beat times.
/// When `is_stable`, the constant `bpm`/`first_beat` grid is accurate and
/// consumers can ignore `beats`; otherwise `beats` carries the real (drifting)
/// per-beat times. `confidence` is the tempo periodicity strength in [0,1].
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BeatAnalysis {
    pub bpm: f32,
    pub first_beat: f32,
    pub confidence: f32,
    pub is_stable: bool,
    pub beats: Vec<f32>,
}

// Onset-envelope hop. Smaller hop = finer lag/phase resolution: at 128 samples
// each lag step near 160 BPM is worth ~1.2 BPM (so parabolic refinement lands
// on the right integer) and each frame is ~2.9 ms at 44.1 kHz — fine enough for
// the plan's <20 ms per-beat alignment target.
const HOP: usize = 128;

// Seconds of audio fed to tempo estimation. 90 s is plenty of beats for a stable
// estimate while staying light on mobile battery (the host decodes ~this much).
const TEMPO_WINDOW_SECS: f32 = 90.0;

// ── public API ──────────────────────────────────────────────────────────────

/// Detect a constant-tempo beat grid: tempo (refined to the exact value) plus
/// the phase of the first downbeat. Cheap fast path for consumers that only
/// need a steady grid.
pub fn detect_beatgrid(samples: &[f32], sample_rate: u32) -> BeatGrid {
    let core = detect_grid_core(samples, sample_rate);
    BeatGrid { bpm: core.bpm, first_beat: core.first_beat }
}

/// Full analysis: the constant grid plus DP-tracked per-beat times that follow
/// tempo drift, an `is_stable` flag, and a tempo confidence.
pub fn analyze_beats(samples: &[f32], sample_rate: u32) -> BeatAnalysis {
    let core = detect_grid_core(samples, sample_rate);
    let (beats, is_stable) = match tempo_onset(samples, sample_rate) {
        Some((onset, fps)) if core.bpm > 0.0 => {
            (dp_beat_times(&onset, fps, core.bpm), tempo_is_stable(&onset, fps))
        }
        _ => (Vec::new(), true),
    };
    BeatAnalysis {
        bpm: core.bpm,
        first_beat: core.first_beat,
        confidence: core.confidence,
        is_stable,
        beats,
    }
}

/// DEBUG: top tempo periodicities in the track, for calibration. Returns up to
/// `top` (bpm, strength) pairs sorted strongest-first, where strength = best-phase
/// per-beat mean concentration (how sharply onsets line up at that period). Three
/// envelopes are probed so we can see WHICH band drives the tempo: kick (low),
/// low+mid (tempo), broadband. Not used at runtime — only by examples/bpm_probe.
pub fn debug_tempo_sweep(samples: &[f32], sample_rate: u32, top: usize) -> Vec<(&'static str, Vec<(f32, f32)>)> {
    let mut out = Vec::new();
    let probes: [(&'static str, fn(&[f32], u32) -> Option<(Vec<f32>, f32)>); 3] =
        [("kick", lowband_onset_envelope), ("tempo", tempo_onset), ("broad", onset_envelope)];
    for (name, f) in probes {
        let Some((onset, fps)) = f(samples, sample_rate) else { continue };
        let limit = ((90.0 * fps) as usize).min(onset.len());
        let overall = onset.iter().take(limit).sum::<f32>() / limit.max(1) as f32;
        let score_at = |bpm: f32| -> f32 {
            let period = 60.0 * fps / bpm;
            let pi = period.round() as usize;
            if pi == 0 {
                return 0.0;
            }
            let mut best = 0.0f32;
            for p in 0..pi {
                let (mut s, mut n, mut k) = (0.0f32, 0.0f32, p as f32);
                while (k as usize) < limit {
                    s += onset[k as usize];
                    n += 1.0;
                    k += period;
                }
                if n > 0.0 {
                    best = best.max(s / n);
                }
            }
            best / overall.max(1e-9)
        };
        let mut cands: Vec<(f32, f32)> = Vec::new();
        let mut bpm = 60.0f32;
        while bpm <= 200.0 {
            cands.push((bpm, score_at(bpm)));
            bpm += 0.5;
        }
        // keep local maxima only, then top-N
        let mut peaks: Vec<(f32, f32)> = cands
            .iter()
            .enumerate()
            .filter(|(i, _)| {
                *i == 0 || *i == cands.len() - 1 || (cands[*i].1 >= cands[i - 1].1 && cands[*i].1 >= cands[i + 1].1)
            })
            .map(|(_, &c)| c)
            .collect();
        peaks.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap());
        peaks.truncate(top);
        out.push((name, peaks));
    }
    out
}

/// DEBUG: diagnose tempo-grid tightness. Returns (bpm, residual_rms_ms,
/// matched_beats, third1_bpm, third2_bpm, third3_bpm). A small residual RMS + three
/// agreeing thirds ⇒ a crisp grid we can nail; a large residual or disagreeing
/// thirds ⇒ the kicks genuinely jitter / drift and an exact integer isn't in the
/// audio. Not used at runtime — only by examples/bpm_probe.
pub fn debug_regression(samples: &[f32], sample_rate: u32) -> (f32, f32, usize, f32, f32, f32) {
    let core = detect_grid_core(samples, sample_rate);
    let bpm = core.bpm;
    let (env, ffps) = match fine_kick_env(samples, sample_rate) {
        Some(v) => v,
        None => return (bpm, 0.0, 0, 0.0, 0.0, 0.0),
    };
    let nf = env.len();
    let slope = |j: usize| -> f32 { if j == 0 { 0.0 } else { (env[j] - env[j - 1]).max(0.0) } };
    let max_slope = (1..nf).map(slope).fold(0.0f32, f32::max).max(1e-9);
    let period = 60.0 / bpm;
    let dur = samples.len() as f32 / sample_rate as f32;
    let win = ((period * 0.12) * ffps) as isize;
    // collect matched (beat_time, residual_ms) using the final grid
    let mut times: Vec<f32> = Vec::new();
    let mut resid: Vec<f32> = Vec::new();
    let mut i = 0usize;
    while core.first_beat + i as f32 * period < dur - 0.1 {
        let t_pred = core.first_beat + i as f32 * period;
        i += 1;
        if t_pred < 0.15 || win < 1 {
            continue;
        }
        let c = (t_pred * ffps) as isize;
        if c - win < 1 || c + win >= nf as isize {
            continue;
        }
        let (mut bj, mut bv) = (c, 0.0f32);
        for j in (c - win)..=(c + win) {
            let v = slope(j as usize);
            if v > bv {
                bv = v;
                bj = j;
            }
        }
        if bv >= 0.18 * max_slope {
            let t_obs = bj as f32 / ffps;
            times.push(t_obs);
            resid.push((t_obs - t_pred) * 1000.0);
        }
    }
    let n = times.len();
    let rms = if n > 0 {
        (resid.iter().map(|r| r * r).sum::<f32>() / n as f32).sqrt()
    } else {
        0.0
    };
    // tempo in each third via the median IOI of matched kicks in that third
    let third = |lo: f32, hi: f32| -> f32 {
        let sel: Vec<f32> = times.iter().copied().filter(|&t| t >= lo && t < hi).collect();
        if sel.len() < 4 {
            return 0.0;
        }
        let mut iois: Vec<f32> = sel.windows(2).map(|w| w[1] - w[0]).collect();
        // fold IOIs to ~1 beat (drop 2×/3× gaps from missing kicks)
        iois.retain(|&x| x < period * 1.5);
        if iois.is_empty() {
            return 0.0;
        }
        iois.sort_by(|a, b| a.partial_cmp(b).unwrap());
        60.0 / iois[iois.len() / 2]
    };
    (bpm, rms, n, third(0.0, dur / 3.0), third(dur / 3.0, 2.0 * dur / 3.0), third(2.0 * dur / 3.0, dur))
}

/// Transient onset TIMES (seconds) by peak-picking the broadband onset envelope.
/// Adaptive threshold + 30 ms refractory gap. Useful for slice/section snapping.
pub fn detect_transients(samples: &[f32], sample_rate: u32) -> Vec<f32> {
    let (onset, fps) = match onset_envelope(samples, sample_rate) {
        Some(x) => x,
        None => return Vec::new(),
    };
    let n = onset.len();
    if n < 3 || fps <= 0.0 {
        return Vec::new();
    }
    let win = ((fps * 0.10) as usize).max(4);
    let mean = onset.iter().sum::<f32>() / n as f32;
    let min_gap = ((fps * 0.03) as usize).max(1);
    let mut out = Vec::new();
    let mut last_frame: i64 = -(min_gap as i64);
    for f in 1..n - 1 {
        let lo = f.saturating_sub(win);
        let local = onset[lo..f].iter().copied().sum::<f32>() / (f - lo).max(1) as f32;
        let thr = (local * 1.6).max(mean * 0.6);
        let v = onset[f];
        if v > thr && v >= onset[f - 1] && v > onset[f + 1] && (f as i64 - last_frame) >= min_gap as i64 {
            out.push(f as f32 / fps);
            last_frame = f as i64;
        }
    }
    out
}

// ── core pipeline (ported) ────────────────────────────────────────────────────

struct GridCore {
    bpm: f32,
    first_beat: f32,
    confidence: f32,
}

fn detect_grid_core(samples: &[f32], sample_rate: u32) -> GridCore {
    let (bpm0, conf) = match tempo_onset(samples, sample_rate) {
        Some((onset, fps)) => {
            // Estimate from the RAW onset (the tuned path) and from a WHITENED envelope (local-mean
            // subtraction + normalisation — lets sparse/acoustic/non-percussive material yield clean
            // periodicity). When they AGREE, keep raw so already-correct tracks (e.g. EDM) are untouched;
            // when they DISAGREE, trust the more confident — which rescues the hard, non-percussive cases.
            let (b_raw, c_raw) = detect_tempo(&onset, fps);
            let (b_enh, c_enh) = detect_tempo(&enhance_onset(&onset, fps), fps);
            if b_raw > 0.0 && (b_enh - b_raw).abs() / b_raw < 0.03 {
                (b_raw, c_raw.max(c_enh))
            } else if c_enh > c_raw {
                (b_enh, c_enh)
            } else {
                (b_raw, c_raw)
            }
        }
        None => (0.0, 0.0),
    };
    let (onset_lp, fps) = match lowband_onset_envelope(samples, sample_rate) {
        Some(v) => v,
        None => return GridCore { bpm: snap_bpm(bpm0), first_beat: 0.0, confidence: conf },
    };
    // coarse → refined (octave fixed, ~0.1 BPM) → downbeat phase.
    let coarse = refine_tempo(&onset_lp, fps, bpm0);
    let first = detect_first_downbeat(&onset_lp, fps, coarse);
    let first = polish_phase(samples, sample_rate, coarse, first);
    // EXACT tempo: least-squares fit the grid to the real kick onsets across the
    // whole track (averages out per-beat jitter → true sub-BPM accuracy, no
    // rounding fudge). Falls back to the coarse value if too few beats match.
    let (bpm, first) = regress_tempo(samples, sample_rate, coarse, first);
    let bpm = snap_bpm(bpm);
    let first = anchor_downbeat_to_drop(samples, sample_rate, bpm, first);
    GridCore { bpm, first_beat: first, confidence: conf }
}

// ── onset envelope (hand-rolled biquads — no `biquad` crate) ──────────────────

/// Minimal RBJ biquad (transposed direct-form II). Replaces the DAW's dependency
/// on the `biquad` crate so the taste crate keeps zero DSP deps.
#[derive(Clone, Copy)]
struct Biquad {
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
    z1: f32,
    z2: f32,
}

const Q_BUTTERWORTH: f32 = std::f32::consts::FRAC_1_SQRT_2; // 0.70710678

impl Biquad {
    fn lowpass(sr: f32, fc: f32, q: f32) -> Self {
        let w0 = 2.0 * std::f32::consts::PI * fc / sr;
        let (sw, cw) = (w0.sin(), w0.cos());
        let alpha = sw / (2.0 * q);
        let a0 = 1.0 + alpha;
        Biquad {
            b0: ((1.0 - cw) / 2.0) / a0,
            b1: (1.0 - cw) / a0,
            b2: ((1.0 - cw) / 2.0) / a0,
            a1: (-2.0 * cw) / a0,
            a2: (1.0 - alpha) / a0,
            z1: 0.0,
            z2: 0.0,
        }
    }
    fn highpass(sr: f32, fc: f32, q: f32) -> Self {
        let w0 = 2.0 * std::f32::consts::PI * fc / sr;
        let (sw, cw) = (w0.sin(), w0.cos());
        let alpha = sw / (2.0 * q);
        let a0 = 1.0 + alpha;
        Biquad {
            b0: ((1.0 + cw) / 2.0) / a0,
            b1: (-(1.0 + cw)) / a0,
            b2: ((1.0 + cw) / 2.0) / a0,
            a1: (-2.0 * cw) / a0,
            a2: (1.0 - alpha) / a0,
            z1: 0.0,
            z2: 0.0,
        }
    }
    #[inline]
    fn run(&mut self, x: f32) -> f32 {
        let y = self.b0 * x + self.z1;
        self.z1 = self.b1 * x - self.a1 * y + self.z2;
        self.z2 = self.b2 * x - self.a2 * y;
        y
    }
}

/// Multi-band onset strength (spectral-flux-style, no FFT). Splits into low
/// (≤150 Hz) / mid (150 Hz–4 kHz) / high (≥4 kHz) bands, tracks per-frame RMS,
/// and sums the half-wave-rectified per-band rises, weighted per band. Catches a
/// kick (low), a snare/clap (mid) and a hat (high) even when one masks the
/// others — which is what makes it work beyond four-on-the-floor EDM. The band
/// weights let callers bias the envelope: kick-only for phase, low/mid-biased for
/// tempo (so dense hi-hats don't pull the tempo to its double), full broadband
/// for transient picking. Returns (onset, frames-per-second).
fn onset_strength(samples: &[f32], sample_rate: u32, wl: f32, wm: f32, wh: f32) -> Option<(Vec<f32>, f32)> {
    if samples.len() < HOP * 4 || sample_rate == 0 {
        return None;
    }
    let need_hi = wm > 0.0 || wh > 0.0;
    let sr = sample_rate as f32;
    let mut lp_low = Biquad::lowpass(sr, 150.0, Q_BUTTERWORTH);
    let mut hp_mid = Biquad::highpass(sr, 150.0, Q_BUTTERWORTH);
    let mut lp_mid = Biquad::lowpass(sr, 4000.0, Q_BUTTERWORTH);
    let mut hp_high = Biquad::highpass(sr, 4000.0, Q_BUTTERWORTH);

    let fps = sr / HOP as f32;
    let n_frames = samples.len() / HOP;
    let mut onset = vec![0.0f32; n_frames];
    let (mut pl, mut pm, mut ph) = (0.0f32, 0.0f32, 0.0f32);

    for f in 0..n_frames {
        let s = f * HOP;
        let (mut el, mut em, mut eh) = (0.0f32, 0.0f32, 0.0f32);
        for &x in &samples[s..s + HOP] {
            let l = lp_low.run(x);
            el += l * l;
            if need_hi {
                let m = lp_mid.run(hp_mid.run(x));
                let h = hp_high.run(x);
                em += m * m;
                eh += h * h;
            }
        }
        let inv = 1.0 / HOP as f32;
        let (rl, rm, rh) = ((el * inv).sqrt(), (em * inv).sqrt(), (eh * inv).sqrt());
        onset[f] = wl * (rl - pl).max(0.0) + wm * (rm - pm).max(0.0) + wh * (rh - ph).max(0.0);
        pl = rl;
        pm = rm;
        ph = rh;
    }
    Some((onset, fps))
}

/// Broadband onset — for transient picking (highs included so hats register).
fn onset_envelope(samples: &[f32], sample_rate: u32) -> Option<(Vec<f32>, f32)> {
    onset_strength(samples, sample_rate, 1.0, 0.8, 0.5)
}

/// Tempo onset — kick-led, mids kept (so tonal/acoustic onsets still register),
/// highs nearly muted. Dense hi-hats (high band) are the main cause of half/
/// double-tempo errors across genres (hip-hop, trap, DnB), so they get almost no
/// say; the kick — which sits on the beat — dominates.
fn tempo_onset(samples: &[f32], sample_rate: u32) -> Option<(Vec<f32>, f32)> {
    onset_strength(samples, sample_rate, 1.0, 0.3, 0.05)
}

/// Kick-band onset — for beat PHASE / downbeat, where the kick is the anchor.
fn lowband_onset_envelope(samples: &[f32], sample_rate: u32) -> Option<(Vec<f32>, f32)> {
    onset_strength(samples, sample_rate, 1.0, 0.0, 0.0)
}

// ── tempo ─────────────────────────────────────────────────────────────────────

/// Pure-Rust tempo via COMB-CONCENTRATION × a perceptual resonance prior.
///
/// For each candidate BPM we comb the onset envelope at that beat period across
/// every phase and take the best per-beat mean (how sharply onsets line up on the
/// grid) — a far cleaner periodicity measure than raw autocorrelation, which
/// rings at every harmonic/sub-harmonic. The concentration is weighted by a
/// log-normal resonance prior centred at ~100 BPM: human tempo perception peaks
/// in a broad mid pocket, and (crucially for bass/hip-hop/Memphis/phonk, which
/// live at 80–100) this stops dense hi-hats doubling the tempo (→170) and stops a
/// flat prior parking ambiguous tracks at its own centre. EDM still resolves:
/// a genuine 128/150 kick concentrates strongly enough to beat its sub-harmonic.
/// Returns (bpm, confidence). bpm is the coarse 0.5-BPM scan winner; `refine_tempo`
/// then locks the exact value on the kick band.
fn detect_tempo(onset: &[f32], fps: f32) -> (f32, f32) {
    if onset.len() < 16 || fps <= 0.0 {
        return (0.0, 0.0);
    }
    let limit = ((TEMPO_WINDOW_SECS * fps) as usize).min(onset.len());
    let overall = (onset[..limit].iter().sum::<f32>() / limit.max(1) as f32).max(1e-9);

    // best-phase per-beat mean at a (fractional) beat period: how sharply onsets
    // line up on the grid at this tempo. Cleaner than autocorrelation (which rings
    // at every harmonic), and the resonance prior below counters its mild
    // slow-tempo bias (more comb phases to cherry-pick at low BPM).
    let concentration = |bpm: f32| -> f32 {
        let period = 60.0 * fps / bpm;
        let pi = period.round() as usize;
        if pi == 0 {
            return 0.0;
        }
        let mut best = 0.0f32;
        for p in 0..pi {
            let (mut s, mut nn, mut k) = (0.0f32, 0.0f32, p as f32);
            while (k as usize) < limit {
                s += onset[k as usize];
                nn += 1.0;
                k += period;
            }
            if nn > 0.0 {
                best = best.max(s / nn);
            }
        }
        best / overall
    };
    // Perceptual resonance prior — centred at 118 BPM (geometric middle of the 70–200 range), σ 0.60.
    // A 100/0.50 prior over-penalised fast genres: gabber/hardcore/frenchcore (150–200) lost to their
    // 75–100 half even though the true tempo concentrates harder. At 118/0.60 the octaves are near-
    // symmetric, so beat SUPPORT (concentration) decides — hip-hop stays ~85 (weak support at 170) while
    // gabber lands at ~175 (strong support there). Matches the DAW estimator.
    let prior = |bpm: f32| {
        let z = (bpm / 118.0).ln() / 0.60;
        (-0.5 * z * z).exp()
    };

    let (mut best_bpm, mut best_score) = (0.0f32, f32::MIN);
    let (mut sum, mut n) = (0.0f32, 0.0f32);
    let mut bpm = 60.0f32;
    while bpm <= 200.0 + 1e-3 {
        let score = concentration(bpm) * prior(bpm);
        sum += score;
        n += 1.0;
        if score > best_score {
            best_score = score;
            best_bpm = bpm;
        }
        bpm += 0.5;
    }
    if best_bpm <= 0.0 {
        return (0.0, 0.0);
    }
    let avg = if n > 0.0 { sum / n } else { 1.0 };
    let conf = if avg > 1e-9 { (best_score / avg - 1.0).clamp(0.0, 1.0) } else { 0.0 };
    (best_bpm, conf)
}

/// Best-fit the exact tempo: search ±1.5 BPM around `bpm0` for the value whose
/// constant grid lands on the strongest kick onsets, scored by per-beat mean.
fn refine_tempo(onset: &[f32], fps: f32, bpm0: f32) -> f32 {
    if bpm0 <= 0.0 {
        return bpm0;
    }
    let limit = ((TEMPO_WINDOW_SECS * fps) as usize).min(onset.len());
    let score_at = |bpm: f32| -> f32 {
        let period = 60.0 * fps / bpm;
        let period_i = period.round() as usize;
        if period_i == 0 {
            return 0.0;
        }
        let mut best = 0.0f32;
        for p in 0..period_i {
            let (mut s, mut n, mut k) = (0.0f32, 0.0f32, p as f32);
            while (k as usize) < limit {
                s += onset[k as usize];
                n += 1.0;
                k += period;
            }
            if n > 0.0 {
                best = best.max(s / n);
            }
        }
        best
    };
    let step = 0.1f32;
    let mut best_bpm = bpm0;
    let mut best = score_at(bpm0);
    let mut b = bpm0 - 1.5;
    while b <= bpm0 + 1.5 + 1e-6 {
        let sc = score_at(b);
        if sc > best {
            best = sc;
            best_bpm = b;
        }
        b += step;
    }
    // Parabolic interpolation around the 0.1-grid peak → sub-0.1 BPM precision, so
    // a true ~87.2 isn't reported as 87.5 (which would miss the integer snap).
    let (sm, s0, sp) = (score_at(best_bpm - step), best, score_at(best_bpm + step));
    let denom = sm - 2.0 * s0 + sp;
    if denom.abs() > 1e-9 {
        let delta = 0.5 * (sm - sp) / denom; // in units of `step`
        if delta.abs() < 1.0 {
            best_bpm += delta * step;
        }
    }
    best_bpm
}

/// Round the (already-precise) tempo to one decimal for a clean display value —
/// no integer fudging. The accuracy comes from `regress_tempo` fitting the grid to
/// the real onsets, so a true 87 reads 87.0 honestly (an off-grid 122.5 stays 122.5).
fn snap_bpm(bpm: f32) -> f32 {
    if bpm <= 0.0 {
        return bpm;
    }
    (bpm * 10.0).round() / 10.0
}

/// Fine low-delay kick-band energy envelope (one-pole ≈150 Hz, 32-sample hops ≈
/// 0.7 ms) — sub-frame-accurate onset timing for tempo regression & phase polish.
fn fine_kick_env(samples: &[f32], sample_rate: u32) -> Option<(Vec<f32>, f32)> {
    if sample_rate == 0 {
        return None;
    }
    let srf = sample_rate as f32;
    const FH: usize = 32;
    let nf = samples.len() / FH;
    if nf < 128 {
        return None;
    }
    let fc = 150.0f32;
    let dt = 1.0 / srf;
    let rc = 1.0 / (2.0 * std::f32::consts::PI * fc);
    let a = dt / (rc + dt);
    let mut lp = 0.0f32;
    let mut env = vec![0.0f32; nf];
    for f in 0..nf {
        let s = f * FH;
        let mut e = 0.0f32;
        for &x in &samples[s..s + FH] {
            lp += a * (x - lp);
            e += lp * lp;
        }
        env[f] = (e / FH as f32).sqrt();
    }
    Some((env, srf / FH as f32))
}

/// Peak-pick strong kick onset TIMES (seconds) from the fine low-band envelope.
/// `min_gap` is the refractory spacing (≈⅓ beat) so each kick yields one mark.
fn strong_kick_times(samples: &[f32], sample_rate: u32, period0: f32) -> Vec<f32> {
    let (env, ffps) = match fine_kick_env(samples, sample_rate) {
        Some(v) => v,
        None => return Vec::new(),
    };
    let n = env.len();
    let slope = |j: usize| -> f32 { if j == 0 { 0.0 } else { (env[j] - env[j - 1]).max(0.0) } };
    let max_slope = (1..n).map(slope).fold(0.0f32, f32::max).max(1e-9);
    let thr = 0.18 * max_slope;
    let min_gap = ((0.33 * period0 * ffps) as usize).max(2);
    let mut out = Vec::new();
    let mut last: i64 = -(min_gap as i64);
    for j in 1..n - 1 {
        let v = slope(j);
        if v >= thr && v >= slope(j - 1) && v > slope(j + 1) && (j as i64 - last) >= min_gap as i64 {
            out.push(j as f32 / ffps);
            last = j as i64;
        }
    }
    out
}

/// EXACT tempo from the MEDIAN inter-kick interval — the honest, jitter-robust way
/// to sub-BPM accuracy.
///
/// Memphis/sampled drums jitter ±50 ms around the grid and the odd section drifts,
/// which drags a least-squares fit off the true tempo. The MEDIAN of the
/// kick-to-kick intervals ignores that: each interval is folded to its nearest
/// whole number of beats (so a skipped kick's 2×/3× gap still votes for one
/// period), and the median of all those period votes is the grid period — robust
/// to outliers and missing beats alike. (Verified: this reads a true 87 as ~87.0
/// where regression read 87.3.) Returns (bpm, first_beat); keeps the input when too
/// few clean intervals exist (e.g. non-percussive material).
fn regress_tempo(samples: &[f32], sample_rate: u32, bpm0: f32, first_beat: f32) -> (f32, f32) {
    if bpm0 <= 0.0 {
        return (bpm0, first_beat);
    }
    let period0 = 60.0 / bpm0;
    let times = strong_kick_times(samples, sample_rate, period0);
    if times.len() < 16 {
        return (bpm0, first_beat);
    }
    // Each consecutive gap → a period vote: fold by its nearest beat-count.
    let mut votes: Vec<f32> = Vec::with_capacity(times.len());
    for w in times.windows(2) {
        let gap = w[1] - w[0];
        let r = (gap / period0).round();
        if r >= 1.0 && r <= 4.0 && (gap / period0 - r).abs() < 0.15 {
            votes.push(gap / r);
        }
    }
    if votes.len() < 12 {
        return (bpm0, first_beat);
    }
    // Use the MODE of the per-beat tempo, not the median: a track that drifts for
    // one section (e.g. a faster outro) would skew the median, but its DOMINANT
    // tempo — the groove the track "is" — is the most common one. Histogram the
    // votes in 0.1-BPM bins, take the fullest bin, then average the votes inside it
    // (±0.3 BPM) for a precise, jitter-free value.
    let vbpm: Vec<f32> = votes.iter().map(|p| 60.0 / p).collect();
    let lo = bpm0 - 8.0;
    let bins = 160usize; // 0.1 BPM × 160 = ±8 BPM span
    let mut hist = vec![0u32; bins];
    for &v in &vbpm {
        let b = ((v - lo) / 0.1).round();
        if b >= 0.0 && (b as usize) < bins {
            hist[b as usize] += 1;
        }
    }
    let peak = (0..bins).max_by_key(|&i| hist[i]).unwrap_or(0);
    let peak_bpm = lo + peak as f32 * 0.1;
    let sel: Vec<f32> = vbpm.iter().copied().filter(|&v| (v - peak_bpm).abs() <= 0.3).collect();
    if sel.len() < 8 {
        return (bpm0, first_beat);
    }
    let bpm = sel.iter().sum::<f32>() / sel.len() as f32;
    // Trust it only if it stays within ~6% of the coarse estimate (octave-safe).
    if (bpm - bpm0).abs() > 0.06 * bpm0 || !bpm.is_finite() {
        return (bpm0, first_beat);
    }
    (bpm, first_beat)
}

// ── downbeat phase ────────────────────────────────────────────────────────────

/// Find the phase (seconds) of the first downbeat by combing the (kick) onset
/// envelope at the fractional beat period across every phase, then anchoring
/// bar 1 to the first strong beat.
fn detect_first_downbeat(onset: &[f32], fps: f32, bpm: f32) -> f32 {
    if bpm <= 0.0 || onset.len() < 8 {
        return 0.0;
    }
    let period = 60.0 * fps / bpm;
    let period_i = period.round() as usize;
    if period_i == 0 {
        return 0.0;
    }
    let window = (90.0 * fps) as usize;
    let limit = window.min(onset.len());

    let comb = |phase_f: f32| -> f32 {
        if phase_f < 0.0 {
            return f32::MIN;
        }
        let mut sum = 0.0f32;
        let mut k = phase_f;
        while (k as usize) + 1 < limit {
            let i = k as usize;
            let fr = k - i as f32;
            sum += onset[i] * (1.0 - fr) + onset[i + 1] * fr;
            k += period;
        }
        sum
    };

    let mut best_phase = 0usize;
    let mut best_score = f32::MIN;
    for phase in 0..period_i {
        let sc = comb(phase as f32);
        if sc > best_score {
            best_score = sc;
            best_phase = phase;
        }
    }
    let mut phase_f = best_phase as f32;
    if best_phase >= 1 && best_phase + 1 < period_i {
        let sm = comb(phase_f - 0.5);
        let sp = comb(phase_f + 0.5);
        let denom = sm - 2.0 * best_score + sp;
        if denom.abs() > 1e-9 {
            let delta = 0.5 * (sm - sp) / denom;
            if delta.abs() < 1.0 {
                phase_f += delta * 0.5;
            }
        }
    }
    phase_f = phase_f.max(0.0);

    let bar = period * 4.0;
    let mut peak = 0.0f32;
    {
        let mut k = phase_f;
        while (k as usize) < limit {
            peak = peak.max(onset[k as usize]);
            k += period;
        }
    }
    let thresh = 0.35 * peak;
    let mut first_strong = -1.0f32;
    if peak > 0.0 {
        let mut k = phase_f;
        while (k as usize) < limit {
            if onset[k as usize] >= thresh {
                first_strong = k;
                break;
            }
            k += period;
        }
    }
    let downbeat = if first_strong >= 0.0 {
        let mut f = first_strong;
        while f >= bar {
            f -= bar;
        }
        f
    } else {
        let mut best_phase = phase_f;
        let mut best_score = f32::MIN;
        for b in 0..4 {
            let phase = phase_f + b as f32 * period;
            let mut sum = 0.0f32;
            let mut k = phase;
            while (k as usize) < limit {
                sum += onset[k as usize];
                k += bar;
            }
            if sum > best_score {
                best_score = sum;
                best_phase = phase;
            }
        }
        let mut f = best_phase;
        while f >= bar {
            f -= bar;
        }
        f
    };

    (downbeat / fps).max(0.0)
}

/// Refine the grid phase to the actual kick transients at near-sample resolution
/// using a low-delay one-pole kick-band envelope (no biquad lag to correct for),
/// shifting the whole grid by the MEDIAN per-beat offset, clamped to ±0.15 beat.
fn polish_phase(samples: &[f32], sample_rate: u32, bpm: f32, first_beat: f32) -> f32 {
    let beat = 60.0 / bpm;
    if bpm <= 0.0 || beat <= 0.0 || sample_rate == 0 {
        return first_beat;
    }
    let srf = sample_rate as f32;
    const FH: usize = 32;
    let nf = samples.len() / FH;
    if nf < 64 {
        return first_beat;
    }
    let fc = 150.0f32;
    let dt = 1.0 / srf;
    let rc = 1.0 / (2.0 * std::f32::consts::PI * fc);
    let a = dt / (rc + dt);
    let mut lp = 0.0f32;
    let mut env = vec![0.0f32; nf];
    for f in 0..nf {
        let s = f * FH;
        let mut e = 0.0f32;
        for &x in &samples[s..s + FH] {
            lp += a * (x - lp);
            e += lp * lp;
        }
        env[f] = (e / FH as f32).sqrt();
    }
    let ffps = srf / FH as f32;
    let wf = (0.025 * ffps) as isize;
    let dur = samples.len() as f32 / srf;
    let t_start = if dur > 40.0 { 20.0 } else { 0.0 };
    let t_end = (dur - 0.5).min(t_start + 50.0);

    let mut offs: Vec<f32> = Vec::new();
    let mut bi = (t_start / beat).ceil() as i64;
    loop {
        let t = first_beat + bi as f32 * beat;
        if t > t_end {
            break;
        }
        bi += 1;
        let c = (t * ffps) as isize;
        if c - wf < 1 || c + wf >= nf as isize {
            continue;
        }
        let (mut bj, mut bv) = (c, -1.0f32);
        for j in (c - wf)..=(c + wf) {
            let v = env[j as usize] - env[(j - 1) as usize];
            if v > bv {
                bv = v;
                bj = j;
            }
        }
        if bv > 0.0 {
            offs.push((bj - c) as f32 / ffps);
        }
    }
    if offs.len() < 8 {
        return first_beat;
    }
    offs.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let median = offs[offs.len() / 2];
    let m = median.clamp(-0.15 * beat, 0.15 * beat);
    (first_beat + m).max(0.0)
}

/// Anchor bar 1 to the track's first drop (first emphatic hit after a quiet
/// intro), else reduce the phase into the first bar. Only changes which beat is
/// labelled "1"; the beat phase is preserved.
fn anchor_downbeat_to_drop(samples: &[f32], sample_rate: u32, bpm: f32, first_beat: f32) -> f32 {
    let beat = 60.0 / bpm;
    let srf = sample_rate as f32;
    let dur = samples.len() as f32 / srf;
    if beat <= 0.0 || dur < 12.0 * beat {
        return first_beat;
    }
    let nb = (dur / beat) as usize;
    let mut e = vec![0.0f32; nb];
    for i in 0..nb {
        let t = first_beat + i as f32 * beat;
        let s = (t * srf) as usize;
        let en = (((t + beat) * srf) as usize).min(samples.len());
        if s < en {
            let seg = &samples[s..en];
            e[i] = (seg.iter().map(|x| x * x).sum::<f32>() / seg.len() as f32).sqrt();
        }
    }
    let mut sorted = e.clone();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let steady = sorted[sorted.len() * 3 / 4].max(1e-9);
    let bar = 4.0 * beat;

    let scan_end = nb.min(((16.0 / beat) as usize).max(8));
    let mut drop_i = -1i32;
    for i in 1..scan_end {
        let lo = i.saturating_sub(4);
        let base = e[lo..i].iter().sum::<f32>() / (i - lo) as f32;
        if e[i] > 2.2 * base && e[i] > 0.5 * steady && base < 0.5 * steady {
            drop_i = i as i32;
            break;
        }
    }
    if drop_i <= 0 {
        return first_beat.rem_euclid(bar);
    }
    (first_beat + drop_i as f32 * beat).max(0.0)
}

// ── Ellis dynamic-programming beat tracking (the drift-following upgrade) ──────

/// Whiten the onset envelope so sparse / acoustic onsets survive: subtract a
/// local running mean (~0.1 s), half-wave rectify, then divide by the global std.
/// This is the main lever that lets the tracker read non-percussive material.
fn enhance_onset(onset: &[f32], fps: f32) -> Vec<f32> {
    let n = onset.len();
    if n == 0 {
        return Vec::new();
    }
    let w = ((0.10 * fps) as usize).max(1);
    let mut out = vec![0.0f32; n];
    // running-sum local mean
    let mut acc = 0.0f32;
    let mut q: std::collections::VecDeque<f32> = std::collections::VecDeque::with_capacity(w + 1);
    for i in 0..n {
        acc += onset[i];
        q.push_back(onset[i]);
        if q.len() > w {
            acc -= q.pop_front().unwrap();
        }
        let mean = acc / q.len() as f32;
        out[i] = (onset[i] - mean).max(0.0);
    }
    let m = out.iter().sum::<f32>() / n as f32;
    let var = out.iter().map(|x| (x - m) * (x - m)).sum::<f32>() / n as f32;
    let std = var.sqrt().max(1e-6);
    for v in out.iter_mut() {
        *v /= std;
    }
    out
}

/// Ellis-style DP beat tracker. Given the onset envelope, fps and a target
/// tempo, returns per-beat TIMES (seconds) that follow local tempo deviation.
fn dp_beat_times(onset: &[f32], fps: f32, bpm: f32) -> Vec<f32> {
    let n = onset.len();
    if bpm <= 0.0 || n < 16 || fps <= 0.0 {
        return Vec::new();
    }
    let period = 60.0 * fps / bpm;
    if !period.is_finite() || period < 2.0 {
        return Vec::new();
    }
    let env = enhance_onset(onset, fps);

    let tightness = 6.0f32; // Ellis default; penalises deviation from `period`
    let lo_off = (period * 0.5).round().max(1.0) as usize;
    let hi_off = (period * 2.0).round().max(lo_off as f32 + 1.0) as usize;

    let mut cumscore = vec![0.0f32; n];
    let mut backlink = vec![-1i64; n];
    for i in 0..n {
        let mut best = f32::NEG_INFINITY;
        let mut bestidx = -1i64;
        if i >= lo_off {
            let start = i.saturating_sub(hi_off);
            let end = i - lo_off;
            for tau in start..=end {
                let interval = (i - tau) as f32;
                let f = (interval / period).ln();
                let score = cumscore[tau] - tightness * f * f;
                if score > best {
                    best = score;
                    bestidx = tau as i64;
                }
            }
        }
        cumscore[i] = if bestidx < 0 { env[i] } else { env[i] + best };
        backlink[i] = bestidx;
    }

    // End on the strongest cumulative score in the final ~2 beats, then backtrack.
    let tail = (period * 2.0).round() as usize;
    let start = n.saturating_sub(tail.max(1));
    let mut end = start;
    let mut end_v = f32::MIN;
    for i in start..n {
        if cumscore[i] > end_v {
            end_v = cumscore[i];
            end = i;
        }
    }
    let mut beats_rev: Vec<usize> = Vec::new();
    let mut cur = end as i64;
    while cur >= 0 {
        beats_rev.push(cur as usize);
        cur = backlink[cur as usize];
    }
    beats_rev.reverse();
    beats_rev.into_iter().map(|f| f as f32 / fps).collect()
}

/// Decide whether the constant grid is trustworthy, robustly: detect the tempo
/// independently on the first and second halves of the track and check they agree
/// (within ~4%, allowing for an octave flip on a borderline half). A produced,
/// constant-tempo track passes; genuine drift (accelerando, a live/DJ tempo ramp)
/// gives two different halves → flagged unstable so consumers use `beats`. This is
/// far more reliable than reading the DP inter-beat intervals, which jitter on
/// syncopated real music even when the tempo is rock-steady.
fn tempo_is_stable(onset: &[f32], fps: f32) -> bool {
    let h = onset.len() / 2;
    if h < 64 {
        return true;
    }
    let (b1, _) = detect_tempo(&onset[..h], fps);
    let (b2, _) = detect_tempo(&onset[h..], fps);
    if b1 <= 0.0 || b2 <= 0.0 {
        return true;
    }
    let rel = (b1 - b2).abs() / b1.max(b2);
    let octave = ((b1 * 2.0 - b2).abs() / b2).min((b2 * 2.0 - b1).abs() / b1);
    rel <= 0.04 || octave <= 0.04
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f32::consts::PI;

    const SR: u32 = 44_100;

    /// 4-on-the-floor kicks + off-beat hats after a silent intro offset.
    fn synth_kick_track(bpm: f32, sr: u32, secs: f32, offset_beats: f32) -> Vec<f32> {
        let beat = 60.0 / bpm;
        let n = (secs * sr as f32) as usize;
        let mut buf = vec![0.0f32; n];
        let mut t = offset_beats * beat;
        let mut beat_idx = 0u32;
        while t < secs {
            let start = (t * sr as f32) as usize;
            let amp = if beat_idx % 4 == 0 { 1.0 } else { 0.8 };
            let klen = (0.12 * sr as f32) as usize;
            for i in 0..klen {
                let idx = start + i;
                if idx >= n {
                    break;
                }
                let ts = i as f32 / sr as f32;
                buf[idx] += amp * (-ts * 30.0).exp() * (2.0 * PI * 55.0 * ts).sin();
            }
            let hat_t = t + beat * 0.5;
            let hstart = (hat_t * sr as f32) as usize;
            let hlen = (0.02 * sr as f32) as usize;
            for i in 0..hlen {
                let idx = hstart + i;
                if idx >= n {
                    break;
                }
                let ts = i as f32 / sr as f32;
                buf[idx] += 0.5 * (-ts * 200.0).exp() * (2.0 * PI * 9000.0 * ts).sin();
            }
            t += beat;
            beat_idx += 1;
        }
        buf
    }

    fn add(buf: &mut [f32], sr: u32, at: f32, freq: f32, amp: f32, decay: f32, len: f32) {
        let n = buf.len();
        let start = (at * sr as f32) as usize;
        let l = (len * sr as f32) as usize;
        for i in 0..l {
            let idx = start + i;
            if idx >= n {
                break;
            }
            let ts = i as f32 / sr as f32;
            buf[idx] += amp * (-ts * decay).exp() * (2.0 * PI * freq * ts).sin();
        }
    }

    /// Full mix: kick on 1&3, snare (the loud decoy transient) on 2&4, hats on
    /// 8ths, sub note per bar. The grid must lock to the kick, not the snare.
    fn synth_full_mix(bpm: f32, sr: u32, secs: f32, offset_beats: f32) -> Vec<f32> {
        let beat = 60.0 / bpm;
        let n = (secs * sr as f32) as usize;
        let mut buf = vec![0.0f32; n];
        let mut beat_idx = 0u32;
        let mut t = offset_beats * beat;
        while t < secs {
            let inbar = beat_idx % 4;
            if inbar == 0 || inbar == 2 {
                add(&mut buf, sr, t, 52.0, 1.0, 28.0, 0.16);
            }
            if inbar == 1 || inbar == 3 {
                add(&mut buf, sr, t, 1800.0, 0.9, 60.0, 0.08);
                add(&mut buf, sr, t, 240.0, 0.7, 50.0, 0.08);
            }
            add(&mut buf, sr, t + beat * 0.5, 9000.0, 0.35, 250.0, 0.02);
            add(&mut buf, sr, t, 8000.0, 0.3, 250.0, 0.02);
            if inbar == 0 {
                add(&mut buf, sr, t, 55.0, 0.5, 2.0, beat * 4.0);
            }
            t += beat;
            beat_idx += 1;
        }
        buf
    }

    /// Match each detected beat to the nearest true beat; return the median abs
    /// error in seconds (only counts detected beats inside the true range).
    fn median_beat_error(detected: &[f32], truth: &[f32]) -> f32 {
        if detected.is_empty() || truth.is_empty() {
            return f32::INFINITY;
        }
        let (lo, hi) = (truth[0] - 0.2, truth[truth.len() - 1] + 0.2);
        let mut errs: Vec<f32> = Vec::new();
        for &d in detected {
            if d < lo || d > hi {
                continue;
            }
            let e = truth.iter().map(|&t| (t - d).abs()).fold(f32::INFINITY, f32::min);
            errs.push(e);
        }
        if errs.is_empty() {
            return f32::INFINITY;
        }
        errs.sort_by(|a, b| a.partial_cmp(b).unwrap());
        errs[errs.len() / 2]
    }

    #[test]
    fn grid_locks_to_kick_not_snare() {
        let bpm = 90.0f32;
        let beat = 60.0 / bpm;
        let offset_beats = 0.7;
        let buf = synth_full_mix(bpm, SR, 40.0, offset_beats);
        let grid = detect_beatgrid(&buf, SR);

        let ratio = grid.bpm / bpm;
        let octave_ok =
            (ratio - 1.0).abs() < 0.04 || (ratio - 2.0).abs() < 0.08 || (ratio - 0.5).abs() < 0.02;
        assert!(octave_ok, "bpm {} not an octave of {}", grid.bpm, bpm);

        let true_first = offset_beats * beat;
        let frac = ((grid.first_beat - true_first) / beat).fract().abs();
        let err = frac.min(1.0 - frac) * beat;
        assert!(err < 0.03, "first_beat {} off-grid (true {}), err {}s", grid.first_beat, true_first, err);
    }

    #[test]
    fn downbeat_locks_to_kick_phase() {
        let bpm = 128.0f32;
        let beat = 60.0 / bpm;
        let offset_beats = 1.5;
        let buf = synth_kick_track(bpm, SR, 30.0, offset_beats);
        let grid = detect_beatgrid(&buf, SR);

        assert!((grid.bpm - bpm).abs() < 2.0, "bpm off: {}", grid.bpm);
        let true_first = offset_beats * beat;
        let err = ((grid.first_beat - true_first) / beat).fract().abs();
        let err = err.min(1.0 - err) * beat;
        assert!(err < 0.025, "first_beat {} not on a beat (true {}), err {}s", grid.first_beat, true_first, err);
    }

    #[test]
    fn hiphop_not_doubled() {
        // 85 BPM groove with DENSE 8th-note hi-hats — the classic half/double trap.
        // The beat is marked by kick (1 & 3) and snare backbeat (2 & 4); the hats
        // ring on every 8th. A naive detector locks to the 8th-hat rate (~170);
        // the low/mid-biased tempo onset + 118-centred prior must read ~85.
        let bpm = 85.0f32;
        let beat = 60.0 / bpm;
        let secs = 40.0;
        let n = (secs * SR as f32) as usize;
        let mut buf = vec![0.0f32; n];
        let mut beat_idx = 0u32;
        let mut t = 0.0f32;
        while t < secs {
            match beat_idx % 4 {
                0 | 2 => add(&mut buf, SR, t, 50.0, 1.0, 26.0, 0.16), // kick on 1 & 3
                _ => {
                    add(&mut buf, SR, t, 1700.0, 0.8, 55.0, 0.09); // snare on 2 & 4
                    add(&mut buf, SR, t, 240.0, 0.6, 50.0, 0.09);
                }
            }
            // hi-hats on every 8th — loud and dense, the doubling bait
            add(&mut buf, SR, t, 9000.0, 0.4, 260.0, 0.02);
            add(&mut buf, SR, t + beat * 0.5, 9000.0, 0.4, 260.0, 0.02);
            t += beat;
            beat_idx += 1;
        }
        let grid = detect_beatgrid(&buf, SR);
        assert!((grid.bpm - 85.0).abs() <= 3.0, "expected ~85 BPM, got {} (likely doubled to ~170)", grid.bpm);
    }

    #[test]
    fn sparse_acoustic_tempo_in_octave() {
        // No drums: a guitar-like pluck (decaying 330 Hz) on each beat at 100 BPM.
        // The onset enhancement must surface these non-percussive onsets.
        let bpm = 100.0f32;
        let beat = 60.0 / bpm;
        let secs = 30.0;
        let n = (secs * SR as f32) as usize;
        let mut buf = vec![0.0f32; n];
        let mut t = 0.2f32;
        let mut k = 0u32;
        while t < secs {
            // mild pitch variation so it's not a pure click train
            let f = 330.0 * if k % 2 == 0 { 1.0 } else { 1.25 };
            add(&mut buf, SR, t, f, 0.7, 6.0, 0.4);
            t += beat;
            k += 1;
        }
        let grid = detect_beatgrid(&buf, SR);
        let folded = grid.bpm;
        let ok = (folded - 100.0).abs() < 4.0 || (folded - 200.0).abs() < 6.0 || (folded - 50.0).abs() < 3.0;
        assert!(ok, "sparse acoustic tempo {} not an octave of 100", grid.bpm);
    }

    #[test]
    fn three_four_tempo_detects() {
        // 3/4 waltz at 150 BPM, "boom-tick-tick": a strong downbeat kick plus a
        // clear low-band tick on beats 2 & 3 so EVERY beat is marked (an
        // unambiguous 3/4 groove — tests the meter, not perceptual ambiguity).
        let bpm = 150.0f32;
        let beat = 60.0 / bpm;
        let secs = 30.0;
        let n = (secs * SR as f32) as usize;
        let mut buf = vec![0.0f32; n];
        let mut k = 0u32;
        let mut t = 0.0f32;
        while t < secs {
            if k % 3 == 0 {
                add(&mut buf, SR, t, 55.0, 1.0, 28.0, 0.16);
            } else {
                add(&mut buf, SR, t, 110.0, 0.75, 32.0, 0.12);
            }
            t += beat;
            k += 1;
        }
        let grid = detect_beatgrid(&buf, SR);
        let r = grid.bpm / bpm;
        let ok = (r - 1.0).abs() < 0.04 || (r - 0.5).abs() < 0.02 || (r - 2.0).abs() < 0.08;
        assert!(ok, "3/4 tempo {} not an octave of 150", grid.bpm);
    }

    #[test]
    fn dp_beats_align_within_20ms() {
        // Steady 120 BPM kick track: DP beat times must land on the true beats
        // with median error < 20 ms (the plan's precision bar).
        let bpm = 120.0f32;
        let beat = 60.0 / bpm;
        let secs = 30.0;
        let offset = 0.0;
        let buf = synth_kick_track(bpm, SR, secs, offset);
        let an = analyze_beats(&buf, SR);
        assert!(!an.beats.is_empty(), "no beats tracked");

        let mut truth = Vec::new();
        let mut t = offset * beat;
        while t < secs {
            truth.push(t);
            t += beat;
        }
        let med = median_beat_error(&an.beats, &truth);
        assert!(med < 0.020, "median beat error {:.1} ms exceeds 20 ms", med * 1000.0);
        assert!(an.is_stable, "steady track should be is_stable");
    }

    #[test]
    fn dp_follows_tempo_ramp() {
        // Accelerando: period shrinks linearly 0.55 s → 0.45 s (≈109 → 133 BPM).
        // The constant grid can't fit this; DP beats must follow within 25 ms and
        // is_stable must be FALSE so consumers know to use `beats`.
        let secs = 40.0;
        let n = (secs * SR as f32) as usize;
        let mut buf = vec![0.0f32; n];
        let (p0, p1) = (0.55f32, 0.45f32);
        let mut truth = Vec::new();
        let mut t = 0.3f32;
        while t < secs - 0.5 {
            add(&mut buf, SR, t, 55.0, 1.0, 30.0, 0.14);
            truth.push(t);
            let frac = (t / secs).clamp(0.0, 1.0);
            let period = p0 + (p1 - p0) * frac;
            t += period;
        }
        let an = analyze_beats(&buf, SR);
        assert!(an.beats.len() >= truth.len() / 2, "DP tracked too few beats: {}", an.beats.len());
        let med = median_beat_error(&an.beats, &truth);
        assert!(med < 0.025, "ramp median beat error {:.1} ms exceeds 25 ms", med * 1000.0);
        assert!(!an.is_stable, "accelerando should NOT be is_stable");
    }

    #[test]
    fn transients_land_on_hits() {
        let buf = synth_kick_track(120.0, SR, 4.0, 0.0);
        let on = detect_transients(&buf, SR);
        assert!(on.len() >= 6, "expected several onsets, got {}", on.len());
        assert!(detect_transients(&vec![0.0f32; SR as usize], SR).is_empty());
    }
}
