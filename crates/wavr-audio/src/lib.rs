//! Wove native audio engine (NATIVE_ENGINE_PLAN.md). symphonia decode →
//! DSP → cpal output, replacing the WebView's Web Audio. Desktop-only here;
//! AAudio/oboe + a lock-free ring come in S4/later.
//!
//! S0 transport · S1 DSP · **S3 dual-voice mixer**: two in-memory voices give
//! buffer-accurate GAPLESS (instant hand-off at end), equal-power CROSSFADE, and
//! a SAMPLE-ACCURATE loop (wrap in the callback — no seek, no click).
//!
//! `cpal::Stream` is `!Send`, so it lives on a keep-alive thread; the public
//! `Engine` holds only `Send+Sync` shared state. The callback briefly locks a
//! Mutex (fine for now; a lock-free ring is a later refinement).

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

mod decode;
mod dsp;
pub use decode::{decode_interleaved, resample_remap};
pub use dsp::{Biquad, Dsp, OutputStage, BANDS};

#[derive(Clone)]
struct Voice {
    pcm: Arc<Vec<f32>>, // interleaved at OUTPUT rate/channels (the part decoded SO FAR while streaming)
    pos: usize,         // interleaved-sample cursor
    total: usize,       // estimated total interleaved samples (for duration while still streaming)
    complete: bool,     // pcm holds the WHOLE track? (false while the background decode is still filling it)
}
impl Voice {
    fn empty() -> Voice { Voice { pcm: Arc::new(Vec::new()), pos: 0, total: 0, complete: true } }
    fn full(pcm: Vec<f32>) -> Voice { let total = pcm.len(); Voice { pcm: Arc::new(pcm), pos: 0, total, complete: true } }
    fn is_empty(&self) -> bool { self.pcm.is_empty() }
    // Only a COMPLETE voice can be "at end" — while streaming we never signal end-of-track (which would
    // trigger a premature gapless hand-off / stop); a momentary read past the decoded part is silence.
    fn at_end(&self) -> bool { self.complete && self.pos >= self.pcm.len() }
    fn dur_len(&self) -> usize { self.total.max(self.pcm.len()) }
    #[inline]
    fn samp(&self, c: usize) -> f32 {
        let i = self.pos + c;
        if i < self.pcm.len() { self.pcm[i] } else { 0.0 }
    }
}

struct Xfade {
    elapsed: usize, // frames
    total: usize,   // frames
}

struct PlayState {
    voices: [Voice; 2],
    active: usize,
    xfade: Option<Xfade>,
    loop_iv: Option<(usize, usize)>, // [start,end) interleaved-sample idx in the active voice
    gen: u64,                        // load generation — a background decode only swaps if still current
    playing: bool,
    volume: f32,
    balance: f32, // stereo balance: -1 = full left, 0 = centre, 1 = full right
    mono: bool,   // sum L+R to both channels (accessibility / single earbud)
    channels: usize,
    dsp: Dsp,
    out_stage: OutputStage,
}

/// Native output engine bound to the default device. `Send + Sync`.
pub struct Engine {
    shared: Arc<Mutex<PlayState>>,
    rate: u32,
    channels: u16,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Engine {
    pub fn new() -> Result<Engine, String> {
        let (tx, rx) = std::sync::mpsc::channel::<Result<(Arc<Mutex<PlayState>>, u32, u16), String>>();
        let stop = Arc::new(AtomicBool::new(false));
        let stop_thread = stop.clone();
        let thread = std::thread::spawn(move || match build_stream() {
            Ok((stream, shared, rate, channels)) => {
                let _ = stream.play();
                let _ = tx.send(Ok((shared, rate, channels)));
                while !stop_thread.load(Ordering::Relaxed) {
                    std::thread::sleep(Duration::from_millis(80));
                }
                drop(stream);
            }
            Err(e) => {
                let _ = tx.send(Err(e));
            }
        });
        match rx.recv() {
            Ok(Ok((shared, rate, channels))) => Ok(Engine { shared, rate, channels, stop, thread: Some(thread) }),
            Ok(Err(e)) => Err(e),
            Err(_) => Err("audio thread exited before init".into()),
        }
    }

    pub fn output_rate(&self) -> u32 { self.rate }
    pub fn output_channels(&self) -> u16 { self.channels }

    /// Resample/remap to the output format — but SKIP the work entirely when the file already matches the
    /// device rate + channel count (the common case), which is the bulk of a cold load's CPU.
    fn to_output(&self, pcm: Vec<f32>, sr: u32, ch: u16) -> Vec<f32> {
        if sr == self.rate && ch == self.channels { pcm } else { resample_remap(&pcm, sr, ch, self.rate, self.channels) }
    }

    fn decode_for_output(&self, path: &str) -> Result<Vec<f32>, String> {
        let (pcm, sr, ch) = decode_interleaved(path)?;
        Ok(self.to_output(pcm, sr, ch))
    }

    /// Load + play immediately. For instant start, only a short PREFIX is decoded synchronously; the rest
    /// is decoded on a background thread and swapped in seamlessly (preserving the play cursor). This is
    /// what makes a track start in ~milliseconds instead of after a full-file decode.
    pub fn load(self: &Arc<Self>, path: &str) -> Result<(), String> {
        use std::time::Instant;
        let t0 = Instant::now();
        // Tiny prefix → near-instant start. The background pass then EXTENDS the buffer continuously
        // (decode is tens of × realtime, so it always stays ahead of the playhead) — so the prefix no
        // longer has to out-race the whole-file decode, regardless of track length.
        let prefix = 3 * self.rate.max(1) as usize * self.channels.max(1) as usize;
        let (pcm, sr, ch, complete, nframes) = decode::decode_interleaved_until(path, Some(prefix))?;
        let dec_ms = t0.elapsed().as_millis();
        let tr = Instant::now();
        let out = self.to_output(pcm, sr, ch);
        let rs_ms = tr.elapsed().as_millis();
        // estimate the true total length (for the seek bar) from the header while we stream the rest in
        let total = if nframes > 0 {
            (nframes as f64 * self.rate as f64 / sr.max(1) as f64) as usize * self.channels.max(1) as usize
        } else { out.len() };

        let my_gen = {
            let mut s = self.shared.lock().map_err(|_| "state poisoned")?;
            s.gen = s.gen.wrapping_add(1);
            let a = s.active;
            s.voices[a] = Voice { pcm: Arc::new(out), pos: 0, total: total.max(0), complete };
            s.voices[1 - a] = Voice::empty();
            s.xfade = None;
            s.loop_iv = None;
            s.playing = true;
            s.dsp.reset();
            s.gen
        };
        eprintln!("[native-audio] load start: decode {dec_ms}ms + resample {rs_ms}ms → {} ({})",
            if complete { "complete" } else { "streaming rest…" }, path);

        if !complete {
            let me = Arc::clone(self);
            let path = path.to_string();
            let (dr, dch) = (self.rate, self.channels);
            std::thread::spawn(move || {
                let t = Instant::now();
                let mut out: Vec<f32> = Vec::new();   // resampled output so far
                let mut raw: Vec<f32> = Vec::new();   // source accumulator (resample path only)
                let mut src_pos = 0f64;
                let mut last_swap = 0usize;
                let swap_every = (dr as usize) * (dch.max(1) as usize) * 4; // grow the live buffer every ~4s of audio
                let mut stop = false;
                let r = decode::decode_stream(&path, |pcm, sr, ch| {
                    if sr == dr && ch == dch {
                        out.extend_from_slice(pcm); // exact format — no resample, no glitch
                    } else {
                        raw.extend_from_slice(pcm);
                        decode::resample_append(&raw, sr, ch, dr, dch, &mut src_pos, &mut out);
                    }
                    if out.len() >= last_swap + swap_every {
                        last_swap = out.len();
                        match me.shared.lock() {
                            Ok(mut s) => {
                                if s.gen != my_gen { stop = true; return false; } // a newer load replaced us
                                let a = s.active;
                                if out.len() > s.voices[a].pcm.len() {
                                    let pos = s.voices[a].pos;
                                    s.voices[a] = Voice { pcm: Arc::new(out.clone()), pos, total: out.len(), complete: false };
                                }
                            }
                            Err(_) => { stop = true; return false; }
                        }
                    }
                    true
                });
                if stop { return; }
                if let Err(e) = r { eprintln!("[native-audio] stream decode failed: {e}"); }
                // final install — the WHOLE track, marked complete (enables end-of-track / gapless again)
                if let Ok(mut s) = me.shared.lock() {
                    if s.gen == my_gen {
                        let a = s.active;
                        let pos = s.voices[a].pos.min(out.len());
                        s.voices[a] = Voice { pcm: Arc::new(out), pos, total: 0, complete: true };
                    }
                }
                eprintln!("[native-audio] streamed full: {}ms · {}", t.elapsed().as_millis(), path);
            });
        }
        Ok(())
    }

    /// Preload the NEXT track into the idle voice (for gapless / crossfade). Decoded in full (it's a
    /// background preload, not user-facing latency).
    pub fn load_next(&self, path: &str) -> Result<(), String> {
        let out = self.decode_for_output(path)?;
        let mut s = self.shared.lock().map_err(|_| "state poisoned")?;
        let idle = 1 - s.active;
        s.voices[idle] = Voice::full(out);
        Ok(())
    }

    /// Equal-power crossfade from the active voice into the preloaded idle voice
    /// over `ms` (0 = instant gapless hand-off). No-op if nothing is preloaded.
    pub fn crossfade_to_next(&self, ms: u32) {
        if let Ok(mut s) = self.shared.lock() {
            let idle = 1 - s.active;
            if s.voices[idle].is_empty() {
                return;
            }
            if ms == 0 {
                let a = s.active;
                s.voices[a] = Voice::empty();
                s.active = idle;
                s.xfade = None;
                s.loop_iv = None;
            } else {
                let total = ((ms as u64 * self.rate as u64) / 1000) as usize;
                s.xfade = Some(Xfade { elapsed: 0, total: total.max(1) });
                s.loop_iv = None;
            }
        }
    }

    pub fn set_playing(&self, playing: bool) { if let Ok(mut s) = self.shared.lock() { s.playing = playing; } }
    pub fn set_volume(&self, v: f32) { if let Ok(mut s) = self.shared.lock() { s.volume = v.clamp(0.0, 1.0); } }
    pub fn set_balance(&self, v: f32) { if let Ok(mut s) = self.shared.lock() { s.balance = v.clamp(-1.0, 1.0); } }
    pub fn set_mono(&self, on: bool) { if let Ok(mut s) = self.shared.lock() { s.mono = on; } }
    pub fn seek_secs(&self, sec: f32) {
        if let Ok(mut s) = self.shared.lock() {
            let a = s.active;
            let idx = (sec.max(0.0) * self.rate as f32) as usize * self.channels.max(1) as usize;
            // clamp to the ESTIMATED total (not just the part decoded so far) so seeking ahead while the
            // track is still streaming lands at the real spot; the callback holds there until it's decoded.
            let cap = s.voices[a].dur_len();
            s.voices[a].pos = idx.min(cap);
            s.dsp.reset();
        }
    }
    /// Set a sample-accurate loop region (seconds) in the active voice; wraps in the
    /// callback so there is no seam click. `None` clears it.
    pub fn set_loop(&self, region: Option<(f32, f32)>) {
        if let Ok(mut s) = self.shared.lock() {
            let ch = self.channels.max(1) as usize;
            s.loop_iv = region.and_then(|(a, b)| {
                let frame = |t: f32| (t.max(0.0) * self.rate as f32) as usize;
                let start = frame(a) * ch;
                let end = frame(b) * ch;
                if end > start { Some((start, end)) } else { None }
            });
        }
    }

    /// Report the INCOMING voice during a crossfade so the UI shows the new track
    /// immediately; otherwise the active voice.
    fn ui_voice(s: &PlayState) -> usize {
        if s.xfade.is_some() { 1 - s.active } else { s.active }
    }
    pub fn position_secs(&self) -> f32 {
        match self.shared.lock() {
            Ok(s) if self.rate > 0 && self.channels > 0 => {
                let v = Self::ui_voice(&s);
                (s.voices[v].pos / self.channels as usize) as f32 / self.rate as f32
            }
            _ => 0.0,
        }
    }
    pub fn duration_secs(&self) -> f32 {
        match self.shared.lock() {
            Ok(s) if self.rate > 0 && self.channels > 0 => {
                let v = Self::ui_voice(&s);
                (s.voices[v].dur_len() / self.channels as usize) as f32 / self.rate as f32
            }
            _ => 0.0,
        }
    }
    pub fn is_playing(&self) -> bool { self.shared.lock().map(|s| s.playing).unwrap_or(false) }

    // ── DSP control (S1) ─────────────────────────────────────────────────────
    pub fn set_eq_enabled(&self, on: bool) { if let Ok(mut s) = self.shared.lock() { s.dsp.set_enabled(on); } }
    pub fn set_preamp_db(&self, db: f32) { if let Ok(mut s) = self.shared.lock() { s.dsp.set_preamp_db(db); } }
    pub fn set_replay_gain_db(&self, db: f32) { if let Ok(mut s) = self.shared.lock() { s.dsp.set_replay_gain_db(db); } }
    pub fn set_band_gain(&self, i: usize, db: f32) { if let Ok(mut s) = self.shared.lock() { s.dsp.set_band_gain(i, db); } }
    pub fn set_band_freq(&self, i: usize, hz: f32) { if let Ok(mut s) = self.shared.lock() { s.dsp.set_band_freq(i, hz); } }
    pub fn set_band_q(&self, i: usize, q: f32) { if let Ok(mut s) = self.shared.lock() { s.dsp.set_band_q(i, q); } }
    pub fn set_bass_db(&self, db: f32) { if let Ok(mut s) = self.shared.lock() { s.dsp.set_bass_db(db); } }
    pub fn set_treble_db(&self, db: f32) { if let Ok(mut s) = self.shared.lock() { s.dsp.set_treble_db(db); } }
    pub fn set_vocal(&self, k: f32) { if let Ok(mut s) = self.shared.lock() { s.dsp.set_vocal(k); } }

    // ── output stage: clip prevention + dither ───────────────────────────────
    pub fn set_clip_prevent(&self, on: bool) { if let Ok(mut s) = self.shared.lock() { s.out_stage.set_clip_prevent(on); } }
    pub fn set_dither_bits(&self, bits: u32) { if let Ok(mut s) = self.shared.lock() { s.out_stage.set_dither_bits(bits); } }
}

impl Drop for Engine {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

/** Output devices to try, in priority order. The system default comes first, but on many Linux setups
 *  (PipeWire/Pulse boxes) the ALSA `default` PCM is misconfigured and won't open ("Slave PCM not usable"
 *  / "no configurations available"), so cpal's default_output_device() yields a device the stream build
 *  then fails on. We therefore ALSO offer the named server devices (`pipewire`, `pulse`) as fallbacks —
 *  build_stream() tries each until one actually opens, so playback works even when `default` is broken. */
fn candidate_devices(host: &cpal::Host) -> Vec<cpal::Device> {
    let mut out = Vec::new();
    if let Some(d) = host.default_output_device() {
        out.push(d);
    }
    if let Ok(devs) = host.output_devices() {
        let (mut pw, mut pulse, mut others) = (None, None, Vec::new());
        for d in devs {
            match d.name().ok().as_deref() {
                Some("pipewire") => pw = Some(d),
                Some("pulse") => pulse = Some(d),
                _ => others.push(d),
            }
        }
        if let Some(d) = pw { out.push(d); }       // server devices route reliably even when `default` is broken
        if let Some(d) = pulse { out.push(d); }
        out.extend(others);                         // any remaining hw device as a last resort
    }
    out
}

fn build_stream() -> Result<(cpal::Stream, Arc<Mutex<PlayState>>, u32, u16), String> {
    let host = cpal::default_host();
    let candidates = candidate_devices(&host);
    if candidates.is_empty() {
        return Err("no output device".into());
    }
    let mut last_err = String::new();
    for device in candidates {
        match build_stream_on(&device) {
            Ok(t) => return Ok(t),
            Err(e) => {
                last_err = format!("{}: {e}", device.name().unwrap_or_else(|_| "?".into()));
                eprintln!("wavr-audio: output device failed ({last_err}) — trying next");
            }
        }
    }
    Err(format!("no usable output device (last: {last_err})"))
}

fn build_stream_on(device: &cpal::Device) -> Result<(cpal::Stream, Arc<Mutex<PlayState>>, u32, u16), String> {
    let supported = device.default_output_config().map_err(|e| e.to_string())?;
    let rate = supported.sample_rate().0;
    let channels = supported.channels();
    let fmt = supported.sample_format();
    if fmt != cpal::SampleFormat::F32 {
        return Err(format!("unsupported output sample format: {fmt:?} (handles f32)"));
    }
    let config: cpal::StreamConfig = supported.into();

    let shared = Arc::new(Mutex::new(PlayState {
        voices: [Voice::empty(), Voice::empty()],
        active: 0,
        xfade: None,
        loop_iv: None,
        gen: 0,
        playing: false,
        volume: 1.0,
        balance: 0.0,
        mono: false,
        channels: channels.max(1) as usize,
        dsp: Dsp::new(rate, channels),
        out_stage: OutputStage::new(),
    }));
    let cb = shared.clone();
    let err_fn = |e| eprintln!("wavr-audio stream error: {e}");
    let stream = device
        .build_output_stream(&config, move |out: &mut [f32], _| fill(out, &cb), err_fn, None)
        .map_err(|e| e.to_string())?;
    Ok((stream, shared, rate, channels))
}

#[inline]
fn eq_out(t: f32) -> f32 { (t.clamp(0.0, 1.0) * std::f32::consts::FRAC_PI_2).cos() }
#[inline]
fn eq_in(t: f32) -> f32 { (t.clamp(0.0, 1.0) * std::f32::consts::FRAC_PI_2).sin() }

fn advance(v: &mut Voice, ch: usize, lp: Option<(usize, usize)>) {
    v.pos += ch;
    if let Some((s, e)) = lp {
        if v.pos >= e {
            v.pos = s;
        }
    }
}

/// Dual-voice mixer callback: active (+ incoming during a crossfade) → DSP →
/// master volume. Sample-accurate loop wrap; gapless hand-off at end.
fn fill(out: &mut [f32], state: &Arc<Mutex<PlayState>>) {
    let Ok(mut s) = state.lock() else {
        out.iter_mut().for_each(|x| *x = 0.0);
        return;
    };
    if !s.playing {
        out.iter_mut().for_each(|x| *x = 0.0);
        return;
    }
    let ch = s.channels.max(1);
    let frames = out.len() / ch;
    for f in 0..frames {
        let base = f * ch;
        let act = s.active;
        let inc = 1 - act;
        let fading = s.xfade.is_some();
        // Streaming underrun: the playhead reached audio that isn't decoded YET (e.g. you seeked ahead
        // while the track is still loading). Output silence and HOLD the cursor here — don't advance, don't
        // end — so when the background decode catches up, playback resumes exactly at this spot (no skip).
        if !fading && !s.voices[act].complete && s.voices[act].pos >= s.voices[act].pcm.len() {
            for c in 0..ch { out[base + c] = 0.0; }
            continue;
        }
        let (ag, ig) = match &s.xfade {
            Some(x) => {
                let t = x.elapsed as f32 / x.total.max(1) as f32;
                (eq_out(t), eq_in(t))
            }
            None => (1.0, 0.0),
        };
        for c in 0..ch {
            let a = s.voices[act].samp(c);
            let i = if fading { s.voices[inc].samp(c) } else { 0.0 };
            out[base + c] = a * ag + i * ig;
        }
        let lp = s.loop_iv;
        advance(&mut s.voices[act], ch, lp);
        if fading {
            advance(&mut s.voices[inc], ch, None);
            let done = {
                let x = s.xfade.as_mut().unwrap();
                x.elapsed += 1;
                x.elapsed >= x.total
            };
            if done {
                s.voices[act] = Voice::empty();
                s.active = inc;
                s.xfade = None;
            }
        } else if s.voices[act].at_end() && !s.voices[inc].is_empty() {
            // gapless: the active track ran out and the next is preloaded → hand off.
            s.voices[act] = Voice::empty();
            s.active = inc;
        }
    }
    // stop when the active voice is exhausted and nothing is queued.
    let a = s.active;
    if s.voices[a].at_end() && s.voices[1 - a].is_empty() && s.loop_iv.is_none() {
        s.playing = false;
    }
    s.dsp.process(out);
    let vol = s.volume;
    if vol != 1.0 {
        for o in out.iter_mut() {
            *o *= vol;
        }
    }
    stereo_stage(out, ch, s.mono, s.balance); // mono-sum + L/R balance (stereo only)
    s.out_stage.process(out); // clip prevention + dither, last (post-volume, pre-DAC)
}

/// Stereo output stage on the first two channels: optional mono-sum, then a balance control. Balance
/// keeps the centre at unity and attenuates the opposite side (−1 = full left, +1 = full right). A
/// no-op for mono output or when off, so it's free in the common case.
fn stereo_stage(out: &mut [f32], ch: usize, mono: bool, balance: f32) {
    if ch < 2 || (!mono && balance == 0.0) { return; }
    let gl = if balance <= 0.0 { 1.0 } else { 1.0 - balance };
    let gr = if balance >= 0.0 { 1.0 } else { 1.0 + balance };
    let frames = out.len() / ch;
    for f in 0..frames {
        let base = f * ch;
        let (mut l, mut r) = (out[base], out[base + 1]);
        if mono { let m = 0.5 * (l + r); l = m; r = m; }
        out[base] = l * gl;
        out[base + 1] = r * gr;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn st(channels: usize, rate: u32) -> PlayState {
        PlayState {
            voices: [Voice::empty(), Voice::empty()],
            active: 0,
            xfade: None,
            loop_iv: None,
            gen: 0,
            playing: true,
            volume: 1.0,
            balance: 0.0,
            mono: false,
            channels,
            dsp: Dsp::new(rate, channels as u16),
            out_stage: OutputStage::new(),
        }
    }
    fn voice(level: f32, frames: usize, ch: usize) -> Voice {
        Voice::full(vec![level; frames * ch])
    }

    #[test]
    fn loop_wraps_sample_accurately() {
        // 8-frame mono buffer, loop [2,5) → after enough pulls, pos stays in [2,5).
        let mut s = st(1, 48_000);
        s.voices[0] = Voice::full((0..8).map(|i| i as f32).collect());
        s.loop_iv = Some((2, 5));
        let shared = Arc::new(Mutex::new(s));
        let mut out = vec![0.0f32; 4];
        for _ in 0..20 {
            fill(&mut out, &shared);
        }
        let pos = shared.lock().unwrap().voices[0].pos;
        assert!((2..5).contains(&pos), "loop pos {pos} escaped [2,5)");
    }

    #[test]
    fn stereo_stage_balance_and_mono() {
        // balance hard-right kills the left channel, leaves the right.
        let mut buf = [0.8f32, 0.4]; // one stereo frame L=0.8 R=0.4
        stereo_stage(&mut buf, 2, false, 1.0);
        assert!((buf[0]).abs() < 1e-6, "full-right should mute L");
        assert!((buf[1] - 0.4).abs() < 1e-6, "full-right keeps R");
        // centre balance is unity (untouched).
        let mut c = [0.8f32, 0.4];
        stereo_stage(&mut c, 2, false, 0.0);
        assert_eq!(c, [0.8, 0.4]);
        // mono sums both channels to the average on each side.
        let mut m = [1.0f32, 0.0];
        stereo_stage(&mut m, 2, true, 0.0);
        assert!((m[0] - 0.5).abs() < 1e-6 && (m[1] - 0.5).abs() < 1e-6, "mono = (L+R)/2 on both");
    }

    #[test]
    fn crossfade_is_equal_power() {
        // voice A = 1.0 everywhere, voice B = 1.0 everywhere; during the fade the
        // summed power gA²+gB² ≈ 1, so the DC level stays ~1.0 (no dip/bump).
        let ch = 1;
        let mut s = st(ch, 48_000);
        s.dsp.set_enabled(false);
        s.voices[0] = voice(1.0, 4800, ch);
        s.voices[1] = voice(1.0, 4800, ch);
        s.xfade = Some(Xfade { elapsed: 0, total: 2400 });
        let shared = Arc::new(Mutex::new(s));
        let mut out = vec![0.0f32; 256];
        let mut worst = 0.0f32;
        for _ in 0..8 {
            fill(&mut out, &shared);
            for &x in &out {
                // both voices DC=1 → out = gA+gB; power proxy = (gA+gB) but check the
                // equal-power identity via gA²+gB²=1 ⇒ gA+gB ∈ [1, 1.414]; mid ≈ 1.414.
                worst = worst.max((x - 1.0).abs());
            }
        }
        // equal-power keeps RMS flat; the linear sum peaks at √2 mid-fade — just assert
        // it never dips BELOW the start level (the classic crossfade hole).
        assert!(worst <= 0.42, "crossfade dipped/overshot too far ({worst:.3})");
    }

    #[test]
    fn gapless_hands_off_at_end() {
        // tiny active voice (2 frames) + preloaded next (level 0.5) → after the active
        // runs out, output becomes the next voice with no zero-gap.
        let ch = 1;
        let mut s = st(ch, 48_000);
        s.dsp.set_enabled(false);
        s.voices[0] = voice(0.9, 2, ch);
        s.voices[1] = voice(0.5, 100, ch);
        let shared = Arc::new(Mutex::new(s));
        let mut out = vec![0.0f32; 8];
        fill(&mut out, &shared);
        // frames 0,1 = active (0.9); from frame 2 on = next (0.5), never 0.
        assert!((out[0] - 0.9).abs() < 1e-4);
        assert!((out[3] - 0.5).abs() < 1e-4, "expected gapless next, got {}", out[3]);
        assert_eq!(shared.lock().unwrap().active, 1, "should have handed off to voice B");
    }
}
