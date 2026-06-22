//! Listening signals — the training data (Section 3). Raw events are stored append-only; time
//! decay (`0.5 ^ (age_days / 90)`) is applied at USE time, never baked into storage.

use serde::{Deserialize, Serialize};

pub const HALF_LIFE_DAYS: f64 = 90.0;
pub const MAX_EVENTS: usize = 20_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum EventKind {
    SkipEarly,    // within first 15 s
    SkipMid,      // 15 s – 50%
    SkipLate,     // after 50%
    FullPlay,     // ≥ 90%
    Replay,       // same track within 2 h
    AddedManually,// added to playlist / queue
    Like,
    Dislike,
    SeekReplaySection,
}

impl EventKind {
    /// Base signal weight before time decay (Section 3 table).
    pub fn base_weight(self) -> f32 {
        match self {
            EventKind::SkipEarly => -1.0,
            EventKind::SkipMid => -0.5,
            EventKind::SkipLate => 0.0,
            EventKind::FullPlay => 0.5,
            EventKind::Replay => 1.0,
            EventKind::AddedManually => 0.8,
            EventKind::Like => 1.5,
            EventKind::Dislike => -1.5,
            EventKind::SeekReplaySection => 0.6,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Event {
    pub track: String, // track id (file hash / path)
    pub kind: EventKind,
    pub ts: i64,       // unix seconds
}

impl Event {
    /// Effective weight at time `now`, with the 90-day half-life decay applied.
    pub fn weight_at(&self, now: i64) -> f32 {
        let age_days = ((now - self.ts).max(0) as f64) / 86_400.0;
        let decay = 0.5f64.powf(age_days / HALF_LIFE_DAYS);
        (self.kind.base_weight() as f64 * decay) as f32
    }
}
