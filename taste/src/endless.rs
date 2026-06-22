//! ENDLESS SET (BEAT_POWERAMP Tier-1 #1) — the transition PLANNER. Pure decision
//! brain over two tracks' `TrackAnalysis`: WHERE to mix out of A, WHERE to bring
//! in B, the overlap, whether the tempos can be beat-matched (≤ a few % bend), and
//! whether the keys are harmonically compatible (Camelot). The player executes the
//! emitted plan via the native dual-voice engine (crossfade + time-stretch); this
//! module only decides — fully testable, no audio.

use crate::full::TrackAnalysis;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Transition {
    /// Seconds into A where the crossfade STARTS (snapped to a downbeat, in A's outro).
    pub out_at: f32,
    /// Seconds into B where playback begins (B's intro plays under A's tail).
    pub in_at: f32,
    /// Crossfade length (s).
    pub overlap_secs: f32,
    /// Playback-rate ratio to apply to B so its tempo matches A (1.0 = already matched).
    pub tempo_ratio: f32,
    /// True if the tempos are close enough to beat-match by bending B ≤ ~6%.
    pub beatmatch: bool,
    /// Camelot wheel distance A→B (0 = same, 1 = compatible neighbour).
    pub key_distance: u8,
    /// True if harmonically mixable (key_distance ≤ 1).
    pub harmonic: bool,
    /// Overall transition quality, 0..1.
    pub score: f32,
}

/// Parse a Camelot code like "8A"/"12B" → (number 1..12, is_b_ring).
fn parse_camelot(c: &str) -> Option<(i32, bool)> {
    let c = c.trim();
    let (num, letter) = c.split_at(c.len().checked_sub(1)?);
    let n: i32 = num.parse().ok()?;
    let b = match letter {
        "B" | "b" => true,
        "A" | "a" => false,
        _ => return None,
    };
    if (1..=12).contains(&n) {
        Some((n, b))
    } else {
        None
    }
}

/// Camelot mixing distance: 0 = identical; 1 = compatible (±1 on the wheel same
/// ring, OR relative major/minor = same number other ring); larger = clash.
pub fn camelot_distance(a: &str, b: &str) -> u8 {
    let (Some((na, ba)), Some((nb, bb))) = (parse_camelot(a), parse_camelot(b)) else {
        return 12; // unknown key → treat as far
    };
    if na == nb && ba == bb {
        return 0;
    }
    if na == nb && ba != bb {
        return 1; // relative major/minor
    }
    let wheel = {
        let d = (na - nb).rem_euclid(12);
        d.min(12 - d) // circular distance on the 1..12 wheel
    };
    if ba == bb && wheel == 1 {
        return 1; // adjacent on the same ring
    }
    (wheel as u8).saturating_add(if ba == bb { 0 } else { 2 })
}

/// Plan the A→B transition. `overlap_beats` is the desired crossfade length in
/// beats (of A); it's clamped to what the tracks afford.
pub fn plan_transition(a: &TrackAnalysis, b: &TrackAnalysis, overlap_beats: f32) -> Transition {
    let bpm_a = a.bpm.max(1.0);
    let bar = 4.0 * 60.0 / bpm_a;
    let beat = 60.0 / bpm_a;
    let overlap_secs = (overlap_beats.max(1.0) * beat).max(beat);

    // ── mix-OUT of A: start of the last low-energy/Outro section in the back
    //    third, snapped to a downbeat; else end − overlap. ──────────────────────
    let dur_a = if a.duration > 0.0 { a.duration } else { a.beats.last().copied().unwrap_or(0.0) };
    let default_out = (dur_a - overlap_secs).max(0.0);
    let mut out_at = a
        .sections
        .iter()
        .rev()
        .find(|s| s.start >= dur_a * 0.6 && (s.label == "Outro" || s.label == "Breakdown" || s.energy < 0.5))
        .map(|s| s.start)
        .unwrap_or(default_out)
        .clamp(dur_a * 0.5, default_out.max(dur_a * 0.5));
    // snap to a downbeat of A
    if bar > 0.0 {
        let k = ((out_at - a.first_beat) / bar).round();
        out_at = (a.first_beat + k * bar).clamp(0.0, default_out);
    }

    // ── mix-IN of B: start at its first downbeat (intro plays under A's tail). ──
    let in_at = b.first_beat.max(0.0);

    // ── beatmatch feasibility: bend B to A's tempo by ≤ ~6%. ──────────────────
    let bpm_b = b.bpm.max(1.0);
    let tempo_ratio = bpm_a / bpm_b;
    let beatmatch = (tempo_ratio - 1.0).abs() <= 0.06;

    // ── key compatibility (Camelot). ──────────────────────────────────────────
    let key_distance = camelot_distance(&a.camelot, &b.camelot);
    let harmonic = key_distance <= 1;

    // ── score: blend beat/key/energy. ─────────────────────────────────────────
    let beat_score = (1.0 - (tempo_ratio - 1.0).abs() / 0.12).clamp(0.0, 1.0);
    let key_score = (1.0 - key_distance as f32 / 4.0).clamp(0.0, 1.0);
    let score = (0.45 * beat_score + 0.35 * key_score + 0.20).clamp(0.0, 1.0);

    Transition {
        out_at,
        in_at,
        overlap_secs,
        tempo_ratio,
        beatmatch,
        key_distance,
        harmonic,
        score,
    }
}

/// One track's slot in an Endless Set: which track, and the transition OUT of it
/// into the next (the last stop has `transition: None`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SetStop {
    pub id: String,
    /// Transition from this track into the next one (None for the final stop).
    pub transition: Option<Transition>,
}

/// A continuous, beatmatched/harmonic Endless Set over a pool of analysed tracks.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EndlessSet {
    pub stops: Vec<SetStop>,
    /// Mean transition score across the set, 0..1 (how smooth the whole journey is).
    pub flow: f32,
}

/// Build an Endless Set: greedily order the pool so each hand-off is the smoothest
/// available (beatmatch + harmonic + energy), starting from `start_id` (or the
/// pool's first track), and attach the planned transition to every stop but the
/// last. `overlap_beats` is the desired crossfade length in beats.
pub fn build_endless_set(
    pool: &[(String, TrackAnalysis)],
    start_id: Option<&str>,
    overlap_beats: f32,
) -> EndlessSet {
    let n = pool.len();
    if n == 0 {
        return EndlessSet { stops: Vec::new(), flow: 0.0 };
    }
    let start = start_id
        .and_then(|s| pool.iter().position(|(id, _)| id == s))
        .unwrap_or(0);

    let mut used = vec![false; n];
    let mut order = Vec::with_capacity(n);
    let mut cur = start;
    used[cur] = true;
    order.push(cur);
    // greedy nearest-neighbour by BEST transition score out of the current track.
    for _ in 1..n {
        let mut best: Option<(usize, f32)> = None;
        for j in 0..n {
            if used[j] {
                continue;
            }
            let s = plan_transition(&pool[cur].1, &pool[j].1, overlap_beats).score;
            if best.map(|(_, bs)| s > bs).unwrap_or(true) {
                best = Some((j, s));
            }
        }
        let Some((j, _)) = best else { break };
        used[j] = true;
        order.push(j);
        cur = j;
    }

    let mut stops = Vec::with_capacity(order.len());
    let mut score_sum = 0.0f32;
    let mut score_cnt = 0u32;
    for (k, &idx) in order.iter().enumerate() {
        let transition = if k + 1 < order.len() {
            let next = order[k + 1];
            let t = plan_transition(&pool[idx].1, &pool[next].1, overlap_beats);
            score_sum += t.score;
            score_cnt += 1;
            Some(t)
        } else {
            None
        };
        stops.push(SetStop { id: pool[idx].0.clone(), transition });
    }
    let flow = if score_cnt > 0 { score_sum / score_cnt as f32 } else { 0.0 };
    EndlessSet { stops, flow }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::full::{Section, TrackAnalysis, ANALYSIS_VERSION};

    fn track(bpm: f32, camelot: &str, dur: f32, sections: Vec<Section>) -> TrackAnalysis {
        TrackAnalysis {
            version: ANALYSIS_VERSION,
            duration: dur,
            bpm,
            first_beat: 0.0,
            beat_confidence: 1.0,
            is_stable: true,
            beats: vec![],
            key: String::new(),
            camelot: camelot.into(),
            key_confidence: 1.0,
            sections,
            genre: None,
        }
    }
    fn sec(start: f32, end: f32, label: &str, e: f32) -> Section {
        Section { start, end, label: label.into(), energy: e }
    }

    #[test]
    fn camelot_distances() {
        assert_eq!(camelot_distance("8A", "8A"), 0);
        assert_eq!(camelot_distance("8A", "8B"), 1); // relative maj/min
        assert_eq!(camelot_distance("8A", "9A"), 1); // adjacent same ring
        assert_eq!(camelot_distance("8A", "7A"), 1);
        assert!(camelot_distance("8A", "3A") >= 3); // far
        assert_eq!(camelot_distance("1A", "12A"), 1); // wheel wraps
    }

    #[test]
    fn beatmatch_only_when_tempos_close() {
        let a = track(128.0, "8A", 200.0, vec![]);
        let close = track(130.0, "8A", 200.0, vec![]); // +1.6% → matchable
        let far = track(174.0, "8A", 200.0, vec![]);    // way off
        assert!(plan_transition(&a, &close, 16.0).beatmatch);
        assert!(!plan_transition(&a, &far, 16.0).beatmatch);
        // tempo_ratio bends the incoming toward A.
        let t = plan_transition(&a, &close, 16.0);
        assert!((t.tempo_ratio - 128.0 / 130.0).abs() < 1e-3);
    }

    #[test]
    fn mixes_out_at_the_outro_on_a_downbeat() {
        // A is 120 BPM (bar = 2s), 120 s, with an Outro starting at 96 s.
        let a = track(120.0, "8A", 120.0, vec![
            sec(0.0, 8.0, "Intro", 0.3),
            sec(8.0, 96.0, "Drop", 0.9),
            sec(96.0, 120.0, "Outro", 0.4),
        ]);
        let b = track(122.0, "9A", 200.0, vec![]);
        let t = plan_transition(&a, &b, 16.0);
        assert!((t.out_at - 96.0).abs() < 2.01, "out_at {} not at the outro", t.out_at);
        assert!((t.out_at % 2.0).abs() < 1e-3, "out_at {} not on a downbeat (bar=2s)", t.out_at);
        assert!(t.harmonic, "8A→9A should be harmonic");
        assert!(t.beatmatch, "120→122 should beatmatch");
        assert!(t.score > 0.7, "good transition should score high ({})", t.score);
    }

    #[test]
    fn falls_back_to_end_minus_overlap_without_sections() {
        let a = track(120.0, "8A", 100.0, vec![]);
        let b = track(120.0, "8A", 100.0, vec![]);
        let t = plan_transition(&a, &b, 8.0); // 8 beats @120 = 4 s overlap
        assert!(t.out_at <= 100.0 - 4.0 + 2.0 && t.out_at >= 50.0, "out_at {}", t.out_at);
    }

    #[test]
    fn endless_set_orders_for_smooth_handoffs() {
        // From a 128 BPM 8A start, the smoothest path walks adjacent tempos+keys
        // (8A→9A→10A) and leaves the clashing 174 BPM 3B track for last.
        let pool = vec![
            ("start".to_string(), track(128.0, "8A", 200.0, vec![])),
            ("clash".to_string(), track(174.0, "3B", 200.0, vec![])),
            ("near2".to_string(), track(130.0, "10A", 200.0, vec![])),
            ("near1".to_string(), track(129.0, "9A", 200.0, vec![])),
        ];
        let set = build_endless_set(&pool, Some("start"), 16.0);
        assert_eq!(set.stops.len(), 4, "every track placed once");
        assert_eq!(set.stops[0].id, "start");
        assert_eq!(set.stops.last().unwrap().id, "clash", "the clashing track lands last");
        assert!(set.stops.last().unwrap().transition.is_none(), "final stop has no outgoing transition");
        // every non-final stop carries a plan, and they beatmatch through the smooth run.
        for s in &set.stops[..3] {
            assert!(s.transition.is_some());
        }
        assert!(set.stops[0].transition.as_ref().unwrap().beatmatch);
        assert!(set.flow > 0.5, "a mostly-compatible set should flow well ({})", set.flow);
    }

    #[test]
    fn endless_set_handles_tiny_pools() {
        assert_eq!(build_endless_set(&[], None, 16.0).stops.len(), 0);
        let one = vec![("only".to_string(), track(120.0, "1A", 100.0, vec![]))];
        let set = build_endless_set(&one, None, 16.0);
        assert_eq!(set.stops.len(), 1);
        assert!(set.stops[0].transition.is_none());
    }
}
