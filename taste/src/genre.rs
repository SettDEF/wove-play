//! Genre / sub-genre classification — Phase 1: an explainable heuristic scorer over the absolute
//! `RawFeatures` (NOT the z-scored Fingerprint, so labels don't drift with the user's library).
//!
//! It scores a small table of genre "prototypes" — each a target tempo + soft preferences on
//! normalized timbre/rhythm features — and returns the best match with a confidence margin. EDM
//! separates cleanly because it's tempo/rhythm/bass-driven; tempo matching is octave-aware (it tries
//! ½× and 2× too) so half-time genres (Trap @ 140, Dubstep) and Drum & Bass land in the right band.
//!
//! The `GenreResult` is intentionally a superset (genre + subgenre + bpm + camelot + energy + raw
//! features) so the DJ app can consume it directly to build harmonic + BPM + energy sets without
//! re-analyzing. See GENRE_ENGINE.md. A learned model can replace the scorer later (Phase 2) — the
//! `GenreFeatures`/`GenreResult` contract stays the same.

use crate::analysis::RawFeatures;
use serde::{Deserialize, Serialize};

// ── raw-feature normalizers (map absolute units → ~0..1 so prototypes are scale-robust) ──
const NYQUIST: f32 = 11_025.0; // analysis resamples to 22.05 kHz
const ONSET_FULL: f32 = 6.0; // onsets/sec considered "very dense"
const CREST_LO: f32 = 6.0; // dB
const CREST_HI: f32 = 20.0;
const CHROMA_MAX: f32 = 2.484_907; // ln(12) — max chroma entropy (fully atonal/flat)
const ZCR_FULL: f32 = 0.2;

fn clamp01(x: f32) -> f32 {
    x.clamp(0.0, 1.0)
}

/// A friendly, normalized view of the features genre classification cares about (all ~0..1 except
/// the BPMs). Carried on `GenreResult` so downstream code (DJ app) can score its own way.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct GenreFeatures {
    pub bpm: f32,
    pub low_end: f32,   // sub/low-bass energy ratio (<150 Hz)
    pub mid: f32,       // 500 Hz–2 kHz ratio (synth/lead body)
    pub onset: f32,     // percussiveness (normalized onset density)
    pub bright: f32,    // spectral centroid / Nyquist
    pub air: f32,       // 85% rolloff / Nyquist
    pub flat: f32,      // spectral flatness (noisiness)
    pub zcr: f32,       // zero-crossing rate (hats/distortion)
    pub dynamics: f32,  // crest factor (normalized) — high = un-compressed/acoustic
    pub atonal: f32,    // chroma entropy (high = atonal/noisy, low = clearly tonal)
    pub steady: f32,    // tempo confidence — a steady 4/4 grid scores high
    pub energy: f32,    // overall hype: percussion + bass + loudness
}

impl GenreFeatures {
    pub fn from_raw(raw: &RawFeatures) -> Self {
        let v = &raw.v;
        let onset = clamp01(v[39] / ONSET_FULL);
        let low_end = clamp01(v[40]);
        let dynamics = clamp01((v[42] - CREST_LO) / (CREST_HI - CREST_LO));
        let energy = clamp01(0.45 * onset + 0.30 * low_end + 0.25 * (1.0 - dynamics));
        GenreFeatures {
            bpm: raw.bpm,
            low_end,
            mid: clamp01(v[41]),
            onset,
            bright: clamp01(v[26] / (NYQUIST * 0.45)),
            air: clamp01(v[28] / (NYQUIST * 0.85)),
            flat: clamp01(v[32]),
            zcr: clamp01(v[36] / ZCR_FULL),
            dynamics,
            atonal: clamp01(v[43] / CHROMA_MAX),
            steady: clamp01(raw.tempo_conf),
            energy,
        }
    }
}

/// The classification result — the stable contract for the app + the DJ tool.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct GenreResult {
    pub genre: String,     // top-level, e.g. "Electronic", "Hip-Hop"
    pub subgenre: String,  // e.g. "Tech House", "Drum & Bass"
    pub confidence: f32,   // 0..1 (scaled top-1 margin)
    pub bpm: f32,
    pub camelot: String,   // from key detection (empty if unknown)
    pub energy: f32,       // 0..1
    pub tags: Vec<String>, // descriptive: "four-on-floor", "bass-heavy", "dark", "half-time"…
    pub features: GenreFeatures,
}

/// A genre prototype: a target tempo + optional soft targets for normalized features (None = ignore).
struct Proto {
    sub: &'static str,
    genre: &'static str,
    bpm: f32,
    bpm_tol: f32,
    low: Option<f32>,
    onset: Option<f32>,
    bright: Option<f32>,
    atonal: Option<f32>,
    flat: Option<f32>,
    zcr: Option<f32>,
    steady: Option<f32>,
    bpm_w: f32,
}

const fn p(
    sub: &'static str, genre: &'static str, bpm: f32, bpm_tol: f32,
    low: Option<f32>, onset: Option<f32>, bright: Option<f32>, atonal: Option<f32>,
    flat: Option<f32>, zcr: Option<f32>, steady: Option<f32>, bpm_w: f32,
) -> Proto {
    Proto { sub, genre, bpm, bpm_tol, low, onset, bright, atonal, flat, zcr, steady, bpm_w }
}

// Prototype table. bpm matching is octave-aware (½×/2×), so half-time genres use their FELT tempo.
#[rustfmt::skip]
const PROTOS: &[Proto] = &[
    //   subgenre          top-level        bpm   tol   low        onset      bright     atonal     flat       zcr        steady     bpm_w
    p("Deep House",       "Electronic",     122.0, 7.0, Some(0.55),Some(0.45),Some(0.40),Some(0.30),None,      None,      Some(0.75), 1.0),
    p("House",            "Electronic",     124.0, 6.0, Some(0.45),Some(0.55),Some(0.55),Some(0.35),None,      None,      Some(0.80), 1.0),
    p("Tech House",       "Electronic",     126.0, 5.0, Some(0.50),Some(0.70),Some(0.50),Some(0.45),Some(0.45),None,      Some(0.85), 1.1),
    p("Techno",           "Electronic",     132.0, 6.0, Some(0.50),Some(0.75),Some(0.30),Some(0.55),Some(0.50),None,      Some(0.85), 1.1),
    p("Hard Techno",      "Electronic",     150.0, 9.0, Some(0.55),Some(0.82),Some(0.28),Some(0.62),Some(0.58),None,      Some(0.85), 1.3),
    p("Hardcore",         "Electronic",     185.0,15.0, Some(0.70),Some(0.88),Some(0.30),Some(0.66),Some(0.66),None,      Some(0.78), 1.4),
    p("Uptempo",          "Electronic",     210.0,18.0, Some(0.70),Some(0.92),Some(0.30),Some(0.72),Some(0.72),None,      Some(0.78), 1.4),
    p("Trance",           "Electronic",     138.0, 6.0, Some(0.45),Some(0.55),Some(0.75),Some(0.25),None,      None,      Some(0.80), 1.1),
    p("Dubstep",          "Electronic",      70.0, 6.0, Some(0.80),Some(0.45),Some(0.50),Some(0.55),Some(0.70),None,      Some(0.55), 1.0),
    p("Drum & Bass",      "Electronic",     174.0, 6.0, Some(0.70),Some(0.85),Some(0.55),Some(0.45),None,      None,      Some(0.55), 1.2),
    p("Future Bass",      "Electronic",     150.0, 8.0, Some(0.60),Some(0.55),Some(0.75),Some(0.25),None,      None,      Some(0.65), 0.9),
    p("Trap",             "Hip-Hop",         72.0, 6.0, Some(0.80),Some(0.45),Some(0.45),Some(0.45),None,      Some(0.70),Some(0.55), 1.0),
    p("Hip-Hop",          "Hip-Hop",         90.0, 8.0, Some(0.65),Some(0.45),Some(0.40),Some(0.40),None,      None,      Some(0.55), 0.8),
    p("R&B / Soul",       "R&B",             95.0,12.0, Some(0.45),Some(0.35),Some(0.40),Some(0.30),None,      None,      Some(0.55), 0.6),
    p("Pop",              "Pop",            116.0,10.0, Some(0.40),Some(0.45),Some(0.60),Some(0.30),None,      None,      Some(0.65), 0.6),
    p("Rock",             "Rock",           120.0,16.0, Some(0.35),Some(0.50),Some(0.55),Some(0.45),Some(0.55),Some(0.60),Some(0.55), 0.5),
    p("Acoustic / Folk",  "Acoustic",        96.0,20.0, Some(0.25),Some(0.25),Some(0.40),Some(0.20),Some(0.20),None,      Some(0.45), 0.3),
    p("Ambient",          "Ambient",         80.0,30.0, Some(0.30),Some(0.15),Some(0.45),Some(0.50),None,      None,      Some(0.30), 0.3),
];

fn gauss(x: f32, mu: f32, sigma: f32) -> f32 {
    let d = (x - mu) / sigma;
    (-0.5 * d * d).exp()
}

/// Octave-aware tempo affinity: best of the felt tempo at 1×, ½×, 2×. Unknown tempo → neutral.
/// Returns (affinity, octave) where octave ∈ {0.5, 1.0, 2.0} = which multiple of the detected tempo fit
/// the target best. 2.0 means the genre's tempo is ~2× the detected BPM → the BPM was likely HALVED.
fn bpm_affinity(bpm: f32, target: f32, tol: f32) -> (f32, f32) {
    if bpm <= 0.0 {
        return (0.3, 1.0);
    }
    let one = gauss(bpm, target, tol);
    let half = gauss(bpm * 0.5, target, tol);
    let dbl = gauss(bpm * 2.0, target, tol);
    let best = one.max(half).max(dbl);
    let octave = if dbl > one && dbl >= half { 2.0 } else if half > one && half >= dbl { 0.5 } else { 1.0 };
    (best, octave)
}

/// Triangular affinity for a normalized 0..1 feature against a soft target.
fn feat_affinity(x: f32, target: f32) -> f32 {
    clamp01(1.0 - (x - target).abs())
}

fn score(proto: &Proto, f: &GenreFeatures) -> (f32, f32) {
    let (bpm_aff, octave) = bpm_affinity(f.bpm, proto.bpm, proto.bpm_tol);
    let mut sum = 0.0;
    let mut wsum = 0.0;
    let mut add = |target: Option<f32>, x: f32| {
        if let Some(t) = target {
            sum += feat_affinity(x, t);
            wsum += 1.0;
        }
    };
    add(proto.low, f.low_end);
    add(proto.onset, f.onset);
    add(proto.bright, f.bright);
    add(proto.atonal, f.atonal);
    add(proto.flat, f.flat);
    add(proto.zcr, f.zcr);
    add(proto.steady, f.steady);
    let feat = if wsum > 0.0 { sum / wsum } else { 0.5 };
    // Weighted blend of tempo + timbre affinity.
    let total = (proto.bpm_w * bpm_aff + feat) / (proto.bpm_w + 1.0);
    (total, octave)
}

fn tags(f: &GenreFeatures, half_time: bool) -> Vec<String> {
    let mut t = Vec::new();
    if f.steady > 0.6 && f.onset > 0.45 && f.bpm >= 118.0 && f.bpm <= 138.0 {
        t.push("four-on-floor".into());
    }
    if half_time {
        t.push("half-time".into());
    }
    if f.low_end > 0.55 {
        t.push("bass-heavy".into());
    }
    t.push(if f.bright > 0.55 { "bright".into() } else if f.bright < 0.3 { "dark".into() } else { "balanced".into() });
    t.push(if f.atonal > 0.6 { "atonal".into() } else { "melodic".into() });
    if f.flat > 0.55 {
        t.push("noisy".into());
    }
    if f.dynamics > 0.6 {
        t.push("dynamic".into());
    }
    if f.energy > 0.6 {
        t.push("high-energy".into());
    } else if f.energy < 0.3 {
        t.push("chilled".into());
    }
    t
}

/// Classify a track from its raw features. `camelot` (from key detection) is attached for the DJ app;
/// pass `None` if unknown.
pub fn classify_genre(raw: &RawFeatures, camelot: Option<String>) -> GenreResult {
    let f = GenreFeatures::from_raw(raw);
    let mut best = 0usize;
    let mut best_score = f32::MIN;
    let mut second = f32::MIN;
    let mut best_octave = 1.0f32;
    for (i, proto) in PROTOS.iter().enumerate() {
        let (s, octave) = score(proto, &f);
        if s > best_score {
            second = best_score;
            best_score = s;
            best = i;
            best_octave = octave;
        } else if s > second {
            second = s;
        }
    }
    let margin = if second > 0.0 { (best_score - second).max(0.0) } else { best_score };
    let confidence = clamp01(0.35 + margin * 2.0);
    let proto = &PROTOS[best];
    // GENRE-DRIVEN OCTAVE FIX: when the winning genre is a fast style that matched at 2× the detected
    // tempo (e.g. hard techno / hardcore read as 83 → its 150–180 prototype matched at 166), the BPM was
    // halved by the beat tracker — trust the genre's timbre and double it (folded to a sane ceiling). This
    // is the "smart" link the user asked for: genre detection corrects the BPM signature.
    let bpm = if best_octave == 2.0 && f.bpm > 0.0 && f.bpm * 2.0 <= 240.0 { f.bpm * 2.0 } else { f.bpm };
    GenreResult {
        genre: proto.genre.to_string(),
        subgenre: proto.sub.to_string(),
        confidence,
        bpm,
        camelot: camelot.unwrap_or_default(),
        energy: f.energy,
        tags: tags(&f, best_octave == 0.5),
        features: f,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::analysis::RawFeatures;

    /// Build RawFeatures with the scalar dims genre cares about set; everything else neutral.
    #[allow(clippy::too_many_arguments)]
    fn raw(bpm: f32, centroid: f32, rolloff: f32, flat: f32, zcr: f32, onset: f32, low: f32, mid: f32, crest: f32, chroma_h: f32, conf: f32) -> RawFeatures {
        let mut v = [0.0f32; crate::fingerprint::DIMS];
        v[26] = centroid;
        v[28] = rolloff;
        v[32] = flat;
        v[36] = zcr;
        v[38] = bpm;
        v[39] = onset;
        v[40] = low;
        v[41] = mid;
        v[42] = crest;
        v[43] = chroma_h;
        v[44] = crate::analysis::fold_bpm(bpm);
        RawFeatures { v, bpm, tempo_conf: conf }
    }

    #[test]
    fn dnb_is_drum_and_bass() {
        // 174 BPM, heavy bass, very percussive → Drum & Bass.
        let r = raw(174.0, 3000.0, 6000.0, 0.3, 0.08, 5.2, 0.72, 0.3, 9.0, 1.0, 0.6);
        let g = classify_genre(&r, None);
        assert_eq!(g.subgenre, "Drum & Bass", "got {:?}", g.subgenre);
        assert_eq!(g.genre, "Electronic");
    }

    #[test]
    fn four_on_floor_is_house_family() {
        // 126 BPM, steady, percussive, mid bright → a house-family Electronic genre.
        let r = raw(126.0, 2400.0, 5000.0, 0.45, 0.06, 4.0, 0.5, 0.35, 8.0, 1.0, 0.9);
        let g = classify_genre(&r, Some("8A".into()));
        assert_eq!(g.genre, "Electronic", "got {:?}/{:?}", g.genre, g.subgenre);
        assert!(g.tags.iter().any(|t| t == "four-on-floor"), "tags {:?}", g.tags);
        assert_eq!(g.camelot, "8A");
    }

    #[test]
    fn trap_is_half_time_hiphop() {
        // 140 BPM felt as 70 (808 bass, hats) → Trap, flagged half-time.
        let r = raw(140.0, 2200.0, 4500.0, 0.3, 0.16, 2.6, 0.82, 0.3, 8.0, 1.1, 0.55);
        let g = classify_genre(&r, None);
        assert_eq!(g.genre, "Hip-Hop", "got {:?}/{:?}", g.genre, g.subgenre);
        assert!(g.tags.iter().any(|t| t == "half-time"), "tags {:?}", g.tags);
        assert!(g.tags.iter().any(|t| t == "bass-heavy"), "tags {:?}", g.tags);
    }

    #[test]
    fn quiet_harmonic_is_acoustic_or_ambient() {
        // Slow, sparse, very dynamic, tonal, light low-end → Acoustic/Ambient (not EDM).
        let r = raw(92.0, 1800.0, 3500.0, 0.15, 0.04, 0.6, 0.2, 0.4, 16.0, 0.4, 0.4);
        let g = classify_genre(&r, None);
        assert!(matches!(g.genre.as_str(), "Acoustic" | "Ambient" | "R&B"), "got {:?}", g.genre);
        assert!(g.energy < 0.4, "energy {}", g.energy);
    }

    #[test]
    fn confidence_in_range() {
        let r = raw(128.0, 2400.0, 5000.0, 0.45, 0.06, 4.0, 0.5, 0.35, 8.0, 1.0, 0.9);
        let g = classify_genre(&r, None);
        assert!(g.confidence >= 0.0 && g.confidence <= 1.0);
    }
}
