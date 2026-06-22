//! DJ set planner (Genre engine Phase 3) — order a pool of analyzed tracks into a DJ-ready set by
//! genre/sub-genre + harmonic key (Camelot) + BPM ramp + a target ENERGY CURVE. Pure ordering over
//! the data the genre engine + key detection already produce, so the DJ app can call this directly
//! (it owns no audio/decoding). Reuses `endless::camelot_distance` for harmonic compatibility.

use crate::endless::camelot_distance;
use serde::{Deserialize, Serialize};

/// One candidate track, as the DJ app would hand it in (all fields come from `GenreResult` + key).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DjTrack {
    pub id: String,
    pub bpm: f32,
    pub camelot: String,
    pub energy: f32, // 0..1
    pub genre: String,
    pub subgenre: String,
}

/// Shape of the energy journey across the set.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum EnergyCurve {
    Rise,    // warm-up → peak (0 → 1)
    Descend, // come-down (1 → 0)
    Peak,    // build to a peak in the middle, then ease off
    Plateau, // ramp up, hold high, gentle taper at the very end (a "main set")
    Wave,    // oscillate — peaks and valleys
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DjSetOptions {
    pub genre: Option<String>,    // restrict to this top-level genre (case-insensitive)
    pub subgenre: Option<String>, // restrict to this sub-genre (case-insensitive)
    pub curve: EnergyCurve,
    pub max_len: usize,
    pub harmonic: bool,    // true = weight Camelot compatibility heavily (smooth harmonic mixing)
    pub max_bpm_jump: f32, // soft cap on the BPM delta between consecutive tracks (0 = no cap)
}

impl Default for DjSetOptions {
    fn default() -> Self {
        DjSetOptions { genre: None, subgenre: None, curve: EnergyCurve::Plateau, max_len: 20, harmonic: true, max_bpm_jump: 8.0 }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DjStop {
    pub id: String,
    pub bpm: f32,
    pub camelot: String,
    pub energy: f32,
    pub key_distance: u8, // Camelot distance from the previous stop (0 for the seed)
    pub bpm_delta: f32,   // |bpm - previous bpm| (0 for the seed)
    pub harmonic: bool,   // key_distance <= 1 (a clean harmonic transition into this stop)
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DjSet {
    pub stops: Vec<DjStop>,
    pub flow: f32, // 0..1 — average transition smoothness across the set
    pub subgenre: Option<String>,
}

/// Target energy (0..1) at fractional position `p` (0..1) across the set, per curve.
fn target_energy(curve: EnergyCurve, p: f32) -> f32 {
    let p = p.clamp(0.0, 1.0);
    match curve {
        EnergyCurve::Rise => 0.25 + 0.75 * p,
        EnergyCurve::Descend => 1.0 - 0.75 * p,
        EnergyCurve::Peak => 1.0 - (2.0 * p - 1.0).abs(), // tent: 0 → 1 (mid) → 0
        EnergyCurve::Plateau => {
            if p < 0.25 { 0.5 + 2.0 * p } // ramp 0.5 → 1.0 over the first quarter
            else if p > 0.85 { 1.0 - (p - 0.85) / 0.15 * 0.35 } // taper to ~0.65 at the end
            else { 1.0 }
        }
        EnergyCurve::Wave => 0.5 + 0.4 * (p * std::f32::consts::PI * 3.0).sin(),
    }
}

fn matches(t: &DjTrack, opts: &DjSetOptions) -> bool {
    let ok = |want: &Option<String>, have: &str| want.as_ref().map_or(true, |w| w.eq_ignore_ascii_case(have));
    ok(&opts.genre, &t.genre) && ok(&opts.subgenre, &t.subgenre)
}

/// Transition cost from `prev` to `cand` aiming for energy `te`. Lower = smoother. ~0..1+.
fn cost(prev: &DjTrack, cand: &DjTrack, te: f32, opts: &DjSetOptions) -> f32 {
    let key = camelot_distance(&prev.camelot, &cand.camelot) as f32 / 12.0; // 0..1
    let jump = (prev.bpm - cand.bpm).abs();
    let mut bpm = (jump / 16.0).min(1.0);
    if opts.max_bpm_jump > 0.0 && jump > opts.max_bpm_jump {
        bpm += (jump - opts.max_bpm_jump) / opts.max_bpm_jump * 0.5; // soft over-cap penalty
    }
    let en = (cand.energy - te).abs();
    let (wk, wb, we) = if opts.harmonic { (0.45, 0.30, 0.25) } else { (0.15, 0.30, 0.55) };
    wk * key + wb * bpm + we * en
}

/// Order `pool` into a DJ-ready set. Greedy: seed near the curve's start energy, then repeatedly pick
/// the lowest-cost next track (harmonic + BPM-ramp + energy-target). Returns an empty set if nothing
/// matches the genre filter.
pub fn plan_dj_set(pool: &[DjTrack], opts: &DjSetOptions) -> DjSet {
    let mut remaining: Vec<&DjTrack> = pool.iter().filter(|t| matches(t, opts)).collect();
    let want = opts.subgenre.clone();
    if remaining.is_empty() {
        return DjSet { stops: vec![], flow: 0.0, subgenre: want };
    }
    let n = opts.max_len.min(remaining.len()).max(1);

    // Seed: the track whose energy is closest to the curve's starting target.
    let te0 = target_energy(opts.curve, 0.0);
    let seed_i = (0..remaining.len())
        .min_by(|&a, &b| (remaining[a].energy - te0).abs().total_cmp(&(remaining[b].energy - te0).abs()))
        .unwrap();
    let seed = remaining.swap_remove(seed_i);

    let mut stops = vec![DjStop {
        id: seed.id.clone(), bpm: seed.bpm, camelot: seed.camelot.clone(), energy: seed.energy,
        key_distance: 0, bpm_delta: 0.0, harmonic: true,
    }];
    let mut prev = seed;
    let mut cost_sum = 0.0f32;

    for i in 1..n {
        let p = if n > 1 { i as f32 / (n - 1) as f32 } else { 0.0 };
        let te = target_energy(opts.curve, p);
        let best = (0..remaining.len())
            .min_by(|&a, &b| cost(prev, remaining[a], te, opts).total_cmp(&cost(prev, remaining[b], te, opts)));
        let Some(bi) = best else { break };
        let next = remaining.swap_remove(bi);
        cost_sum += cost(prev, next, te, opts);
        let kd = camelot_distance(&prev.camelot, &next.camelot);
        stops.push(DjStop {
            id: next.id.clone(), bpm: next.bpm, camelot: next.camelot.clone(), energy: next.energy,
            key_distance: kd, bpm_delta: (prev.bpm - next.bpm).abs(), harmonic: kd <= 1,
        });
        prev = next;
    }

    let transitions = stops.len().saturating_sub(1).max(1) as f32;
    let flow = (1.0 - (cost_sum / transitions)).clamp(0.0, 1.0);
    DjSet { stops, flow, subgenre: want }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(id: &str, bpm: f32, camelot: &str, energy: f32, sub: &str) -> DjTrack {
        DjTrack { id: id.into(), bpm, camelot: camelot.into(), energy, genre: "Electronic".into(), subgenre: sub.into() }
    }

    fn pool() -> Vec<DjTrack> {
        vec![
            t("a", 124.0, "8A", 0.30, "House"),
            t("b", 126.0, "9A", 0.55, "House"),
            t("c", 128.0, "8B", 0.70, "Tech House"),
            t("d", 128.0, "9B", 0.85, "Tech House"),
            t("e", 130.0, "10A", 0.95, "Techno"),
            t("f", 122.0, "7A", 0.20, "House"),
            t("g", 174.0, "3A", 0.90, "Drum & Bass"),
        ]
    }

    #[test]
    fn rise_curve_increases_energy() {
        let opts = DjSetOptions { curve: EnergyCurve::Rise, max_len: 6, ..Default::default() };
        let set = plan_dj_set(&pool(), &opts);
        assert!(set.stops.len() >= 5);
        let first = set.stops.first().unwrap().energy;
        let last = set.stops.last().unwrap().energy;
        assert!(last > first, "rise should end higher: {first} → {last}");
        assert!(set.flow >= 0.0 && set.flow <= 1.0);
    }

    #[test]
    fn subgenre_filter_restricts_pool() {
        let opts = DjSetOptions { subgenre: Some("house".into()), ..Default::default() };
        let set = plan_dj_set(&pool(), &opts);
        // only the 3 "House" tracks (Tech House / Techno / DnB excluded by exact sub-genre match)
        assert_eq!(set.stops.len(), 3, "got {:?}", set.stops.iter().map(|s| &s.id).collect::<Vec<_>>());
        assert_eq!(set.subgenre.as_deref(), Some("house"));
    }

    #[test]
    fn harmonic_prefers_compatible_keys() {
        let opts = DjSetOptions { curve: EnergyCurve::Plateau, max_len: 6, harmonic: true, ..Default::default() };
        let set = plan_dj_set(&pool(), &opts);
        // most transitions should be harmonically close (Camelot distance small)
        let clean = set.stops.iter().skip(1).filter(|s| s.key_distance <= 2).count();
        assert!(clean >= set.stops.len() / 2, "expected mostly clean key moves, stops={:?}",
            set.stops.iter().map(|s| (&s.camelot, s.key_distance)).collect::<Vec<_>>());
    }

    #[test]
    fn empty_when_no_match() {
        let opts = DjSetOptions { subgenre: Some("Polka".into()), ..Default::default() };
        let set = plan_dj_set(&pool(), &opts);
        assert!(set.stops.is_empty());
        assert_eq!(set.flow, 0.0);
    }
}
