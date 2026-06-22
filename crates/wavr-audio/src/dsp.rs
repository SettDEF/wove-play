//! Native DSP (slice S1) — the playback chain ported out of the Web Audio graph:
//! preamp · ReplayGain · 10-band parametric EQ · bass/treble shelves · vocal
//! fader (center-cancel). Per-output-channel biquad state; processes interleaved
//! f32 in place inside the audio callback. (Reverb/echo wet sends are heavier
//! time-domain effects — deferred to a later slice.)
//!
//! Biquads use f64 state so the low bands (31 Hz @ 48 kHz, poles near the unit
//! circle) stay numerically clean.

use std::f64::consts::PI;

/// RBJ cookbook biquad (transposed direct-form II), f64 internals.
#[derive(Clone, Copy)]
pub struct Biquad {
    b0: f64, b1: f64, b2: f64, a1: f64, a2: f64,
    z1: f64, z2: f64,
}

impl Biquad {
    fn identity() -> Self {
        Biquad { b0: 1.0, b1: 0.0, b2: 0.0, a1: 0.0, a2: 0.0, z1: 0.0, z2: 0.0 }
    }
    fn from(b0: f64, b1: f64, b2: f64, a0: f64, a1: f64, a2: f64) -> Self {
        Biquad { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0, z1: 0.0, z2: 0.0 }
    }
    pub fn peaking(sr: f32, f: f32, q: f32, gain_db: f32) -> Self {
        let a = 10f64.powf(gain_db as f64 / 40.0);
        let w0 = 2.0 * PI * f as f64 / sr as f64;
        let (sw, cw) = (w0.sin(), w0.cos());
        let alpha = sw / (2.0 * q.max(0.01) as f64);
        Biquad::from(1.0 + alpha * a, -2.0 * cw, 1.0 - alpha * a, 1.0 + alpha / a, -2.0 * cw, 1.0 - alpha / a)
    }
    pub fn low_shelf(sr: f32, f: f32, q: f32, gain_db: f32) -> Self {
        let a = 10f64.powf(gain_db as f64 / 40.0);
        let w0 = 2.0 * PI * f as f64 / sr as f64;
        let (sw, cw) = (w0.sin(), w0.cos());
        let alpha = sw / (2.0 * q.max(0.01) as f64);
        let tsa = 2.0 * a.sqrt() * alpha;
        Biquad::from(
            a * ((a + 1.0) - (a - 1.0) * cw + tsa),
            2.0 * a * ((a - 1.0) - (a + 1.0) * cw),
            a * ((a + 1.0) - (a - 1.0) * cw - tsa),
            (a + 1.0) + (a - 1.0) * cw + tsa,
            -2.0 * ((a - 1.0) + (a + 1.0) * cw),
            (a + 1.0) + (a - 1.0) * cw - tsa,
        )
    }
    pub fn high_shelf(sr: f32, f: f32, q: f32, gain_db: f32) -> Self {
        let a = 10f64.powf(gain_db as f64 / 40.0);
        let w0 = 2.0 * PI * f as f64 / sr as f64;
        let (sw, cw) = (w0.sin(), w0.cos());
        let alpha = sw / (2.0 * q.max(0.01) as f64);
        let tsa = 2.0 * a.sqrt() * alpha;
        Biquad::from(
            a * ((a + 1.0) + (a - 1.0) * cw + tsa),
            -2.0 * a * ((a - 1.0) + (a + 1.0) * cw),
            a * ((a + 1.0) + (a - 1.0) * cw - tsa),
            (a + 1.0) - (a - 1.0) * cw + tsa,
            2.0 * ((a - 1.0) - (a + 1.0) * cw),
            (a + 1.0) - (a - 1.0) * cw - tsa,
        )
    }
    pub fn lowpass(sr: f32, f: f32, q: f32) -> Self {
        let w0 = 2.0 * PI * f as f64 / sr as f64;
        let (sw, cw) = (w0.sin(), w0.cos());
        let alpha = sw / (2.0 * q.max(0.01) as f64);
        Biquad::from((1.0 - cw) / 2.0, 1.0 - cw, (1.0 - cw) / 2.0, 1.0 + alpha, -2.0 * cw, 1.0 - alpha)
    }
    pub fn highpass(sr: f32, f: f32, q: f32) -> Self {
        let w0 = 2.0 * PI * f as f64 / sr as f64;
        let (sw, cw) = (w0.sin(), w0.cos());
        let alpha = sw / (2.0 * q.max(0.01) as f64);
        Biquad::from((1.0 + cw) / 2.0, -(1.0 + cw), (1.0 + cw) / 2.0, 1.0 + alpha, -2.0 * cw, 1.0 - alpha)
    }
    #[inline]
    pub fn run(&mut self, x: f32) -> f32 {
        let xf = x as f64;
        let y = self.b0 * xf + self.z1;
        self.z1 = self.b1 * xf - self.a1 * y + self.z2;
        self.z2 = self.b2 * xf - self.a2 * y;
        y as f32
    }
    fn reset(&mut self) { self.z1 = 0.0; self.z2 = 0.0; }
}

pub const BANDS: usize = 10;
/// ISO 10-band centres (Hz).
pub const DEFAULT_FREQS: [f32; BANDS] = [31.0, 62.0, 125.0, 250.0, 500.0, 1000.0, 2000.0, 4000.0, 8000.0, 16000.0];

fn db_to_lin(db: f32) -> f32 { 10f32.powf(db / 20.0) }

/// The full per-track DSP chain. One instance per Engine; holds per-channel filter
/// state. Call `process(interleaved)` from the audio callback.
pub struct Dsp {
    sr: u32,
    channels: usize,
    enabled: bool,
    preamp: f32, // linear
    rg: f32,     // ReplayGain, linear
    freqs: [f32; BANDS],
    qs: [f32; BANDS],
    gains: [f32; BANDS], // dB
    bass_db: f32,
    treble_db: f32,
    vocal_k: f32,
    eq: Vec<[Biquad; BANDS]>, // [channel][band]
    bass: Vec<Biquad>,        // [channel]
    treble: Vec<Biquad>,      // [channel]
    v_hp: Biquad,             // mono mid band-limit for the vocal canceller
    v_lp: Biquad,
}

impl Dsp {
    pub fn new(sr: u32, channels: u16) -> Self {
        let ch = channels.max(1) as usize;
        let mut d = Dsp {
            sr,
            channels: ch,
            enabled: true,
            preamp: 1.0,
            rg: 1.0,
            freqs: DEFAULT_FREQS,
            qs: [1.0; BANDS],
            gains: [0.0; BANDS],
            bass_db: 0.0,
            treble_db: 0.0,
            vocal_k: 0.0,
            eq: vec![[Biquad::identity(); BANDS]; ch],
            bass: vec![Biquad::identity(); ch],
            treble: vec![Biquad::identity(); ch],
            v_hp: Biquad::highpass(sr as f32, 180.0, 0.707),
            v_lp: Biquad::lowpass(sr as f32, 5000.0, 0.707),
        };
        for i in 0..BANDS { d.rebuild_band(i); }
        d.rebuild_tone();
        d
    }

    fn rebuild_band(&mut self, i: usize) {
        for c in 0..self.channels {
            self.eq[c][i] = Biquad::peaking(self.sr as f32, self.freqs[i], self.qs[i], self.gains[i]);
        }
    }
    fn rebuild_tone(&mut self) {
        for c in 0..self.channels {
            self.bass[c] = Biquad::low_shelf(self.sr as f32, 120.0, 0.707, self.bass_db);
            self.treble[c] = Biquad::high_shelf(self.sr as f32, 6000.0, 0.707, self.treble_db);
        }
    }

    // ── control surface ──────────────────────────────────────────────────────
    pub fn set_enabled(&mut self, on: bool) { self.enabled = on; }
    pub fn set_preamp_db(&mut self, db: f32) { self.preamp = db_to_lin(db); }
    pub fn set_replay_gain_db(&mut self, db: f32) { self.rg = db_to_lin(db); }
    pub fn set_band_gain(&mut self, i: usize, db: f32) { if i < BANDS { self.gains[i] = db; self.rebuild_band(i); } }
    pub fn set_band_freq(&mut self, i: usize, hz: f32) { if i < BANDS { self.freqs[i] = hz.max(10.0); self.rebuild_band(i); } }
    pub fn set_band_q(&mut self, i: usize, q: f32) { if i < BANDS { self.qs[i] = q.max(0.05); self.rebuild_band(i); } }
    pub fn set_bass_db(&mut self, db: f32) { self.bass_db = db; self.rebuild_tone(); }
    pub fn set_treble_db(&mut self, db: f32) { self.treble_db = db; self.rebuild_tone(); }
    pub fn set_vocal(&mut self, k: f32) { self.vocal_k = k.clamp(0.0, 1.2); }

    /// Clear filter state (on seek / track change) to avoid a transient blip.
    pub fn reset(&mut self) {
        for c in 0..self.channels {
            for b in 0..BANDS { self.eq[c][b].reset(); }
            self.bass[c].reset();
            self.treble[c].reset();
        }
        self.v_hp.reset();
        self.v_lp.reset();
    }

    /// Process interleaved samples in place. Order matches the Web Audio graph:
    /// vocal-fader → preamp·RG gain → 10 EQ bands → bass → treble.
    pub fn process(&mut self, buf: &mut [f32]) {
        let ch = self.channels;
        if ch == 0 {
            return;
        }
        let g = self.preamp * self.rg;
        let frames = buf.len() / ch;
        for f in 0..frames {
            let base = f * ch;
            if ch >= 2 && self.vocal_k > 0.0 {
                let l = buf[base];
                let r = buf[base + 1];
                let mid = (l + r) * 0.5;
                let m = self.v_lp.run(self.v_hp.run(mid)) * self.vocal_k;
                buf[base] = l - m;
                buf[base + 1] = r - m;
            }
            for c in 0..ch {
                let mut x = buf[base + c] * g;
                if self.enabled {
                    let chain = &mut self.eq[c];
                    for b in chain.iter_mut() {
                        x = b.run(x);
                    }
                    x = self.bass[c].run(x);
                    x = self.treble[c].run(x);
                }
                buf[base + c] = x;
            }
        }
    }
}

/// Final output stage (post-volume, pre-DAC): clip prevention + dither. Poweramp applies these last,
/// just before handing samples to the output. Kept separate from [`Dsp`] so it runs after master
/// volume in the mixer callback.
pub struct OutputStage {
    clip_prevent: bool,
    dither_bits: u32, // 0 = off; else quantize to this bit depth with TPDF dither (16 / 24)
    rng: u32,
}

impl OutputStage {
    pub fn new() -> Self { OutputStage { clip_prevent: true, dither_bits: 0, rng: 0x9E3779B9 } }
    pub fn set_clip_prevent(&mut self, on: bool) { self.clip_prevent = on; }
    /// 0 = off, otherwise 16 or 24 (other values clamped to that range).
    pub fn set_dither_bits(&mut self, bits: u32) {
        self.dither_bits = if bits == 0 { 0 } else { bits.clamp(8, 24) };
    }
    #[inline]
    fn rand_unit(&mut self) -> f32 {
        // xorshift32 → [0,1); deterministic, no rand dep, fine for dither noise.
        self.rng ^= self.rng << 13;
        self.rng ^= self.rng >> 17;
        self.rng ^= self.rng << 5;
        (self.rng as f32) / (u32::MAX as f32)
    }
    /// Soft-knee limiter above ±0.9 then hard clamp at ±1.0 — guarantees nothing exceeds 0 dBFS
    /// (prevents EQ/ReplayGain-induced clipping) while staying transparent below the knee.
    #[inline]
    fn soft_clip(x: f32) -> f32 {
        const K: f32 = 0.9;
        if x.abs() <= K { return x; }
        let s = x.signum();
        let over = x.abs() - K;            // amount past the knee
        let comp = (1.0 - K) * (over / (over + (1.0 - K))); // asymptotes to (1-K)
        (s * (K + comp)).clamp(-1.0, 1.0)
    }
    pub fn process(&mut self, buf: &mut [f32]) {
        if self.clip_prevent {
            for x in buf.iter_mut() { *x = Self::soft_clip(*x); }
        }
        if self.dither_bits > 0 {
            let step = 1.0 / ((1u32 << (self.dither_bits - 1)) as f32); // 1 LSB at this bit depth
            for x in buf.iter_mut() {
                let tri = (self.rand_unit() - self.rand_unit()) * step; // TPDF, ±1 LSB
                *x = ((*x + tri) / step).round() * step;
            }
        }
    }
}

impl Default for OutputStage { fn default() -> Self { Self::new() } }

#[cfg(test)]
mod tests {
    use super::*;
    use std::f32::consts::PI;

    const SR: u32 = 48_000;

    #[test]
    fn clip_prevention_caps_at_full_scale() {
        let mut o = OutputStage::new();
        let mut buf = vec![2.0, -2.0, 0.5, -0.5, 1.5];
        o.process(&mut buf);
        assert!(buf.iter().all(|x| x.abs() <= 1.0), "clip prevention must keep |x| ≤ 1.0");
        assert!((buf[2] - 0.5).abs() < 1e-6 && (buf[3] + 0.5).abs() < 1e-6, "below-knee samples pass through");
    }

    #[test]
    fn dither_off_is_identity_quantize_snaps_to_grid() {
        let mut off = OutputStage::new();
        off.set_clip_prevent(false);
        let mut a = vec![0.123_456_7, -0.4, 0.0];
        let orig = a.clone();
        off.process(&mut a);
        assert_eq!(a, orig, "dither off + clip off = identity");

        let mut on = OutputStage::new();
        on.set_clip_prevent(false);
        on.set_dither_bits(16);
        let mut b = vec![0.123_456_7f32; 64];
        on.process(&mut b);
        let step = 1.0 / ((1u32 << 15) as f32);
        for &x in &b { let r = (x / step).round() * step; assert!((x - r).abs() < 1e-6, "samples land on the 16-bit grid"); }
    }

    fn sine(freq: f32, n: usize, ch: usize) -> Vec<f32> {
        let mut v = vec![0.0f32; n * ch];
        for i in 0..n {
            let s = (2.0 * PI * freq * i as f32 / SR as f32).sin() * 0.5;
            for c in 0..ch { v[i * ch + c] = s; }
        }
        v
    }
    fn rms(buf: &[f32]) -> f32 {
        if buf.is_empty() { return 0.0; }
        (buf.iter().map(|x| x * x).sum::<f32>() / buf.len() as f32).sqrt()
    }
    // skip the filter ramp-up at the start
    fn tail(buf: &[f32], ch: usize) -> &[f32] { &buf[(buf.len() / 4 / ch) * ch..] }

    #[test]
    fn eq_boosts_its_band_and_leaves_others() {
        // +12 dB at the 1 kHz band: a 1 kHz tone gets louder; a 60 Hz tone barely moves.
        let mut d = Dsp::new(SR, 2);
        d.set_band_gain(5, 12.0); // 1 kHz
        let mut on = sine(1000.0, SR as usize, 2);
        let before = rms(tail(&on, 2));
        d.process(&mut on);
        let after = rms(tail(&on, 2));
        assert!(after > before * 1.8, "1kHz +12dB should ~3.98× amplitude (got {:.2}×)", after / before);

        let mut d2 = Dsp::new(SR, 2);
        d2.set_band_gain(5, 12.0);
        let mut off = sine(60.0, SR as usize, 2);
        let b2 = rms(tail(&off, 2));
        d2.process(&mut off);
        let a2 = rms(tail(&off, 2));
        assert!((a2 / b2 - 1.0).abs() < 0.15, "60Hz should be ~unchanged by a 1kHz boost (got {:.2}×)", a2 / b2);
    }

    #[test]
    fn preamp_gain_scales_amplitude() {
        let mut d = Dsp::new(SR, 2);
        d.set_enabled(false); // isolate the gain stage
        d.set_preamp_db(6.0);
        let mut buf = sine(500.0, 4800, 2);
        let before = rms(&buf);
        d.process(&mut buf);
        let after = rms(&buf);
        assert!((after / before - 1.995).abs() < 0.05, "+6dB ≈ 1.995× (got {:.3})", after / before);
    }

    #[test]
    fn vocal_fader_cancels_centre_keeps_sides() {
        // pure-centre 1 kHz (L==R): k=1 should strongly attenuate it.
        let mut d = Dsp::new(SR, 2);
        d.set_enabled(false);
        d.set_vocal(1.0);
        let mut centre = sine(1000.0, SR as usize, 2);
        let before = rms(tail(&centre, 2));
        d.process(&mut centre);
        let after = rms(tail(&centre, 2));
        assert!(after < before * 0.4, "centre vocal should drop a lot (got {:.2}×)", after / before);

        // anti-phase sides (L=-R): unaffected (mid = 0).
        let mut d2 = Dsp::new(SR, 2);
        d2.set_enabled(false);
        d2.set_vocal(1.0);
        let n = SR as usize;
        let mut sides = vec![0.0f32; n * 2];
        for i in 0..n {
            let s = (2.0 * PI * 1000.0 * i as f32 / SR as f32).sin() * 0.5;
            sides[i * 2] = s;
            sides[i * 2 + 1] = -s;
        }
        let b = rms(tail(&sides, 2));
        d2.process(&mut sides);
        let a = rms(tail(&sides, 2));
        assert!((a / b - 1.0).abs() < 0.05, "sides should pass through (got {:.2}×)", a / b);
    }
}
