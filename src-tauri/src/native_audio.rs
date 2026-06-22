//! Native audio engine commands (NATIVE_ENGINE_PLAN.md). One `wavr_audio::Engine`
//! (symphonia decode → DSP → cpal output; cpal = AAudio/oboe on Android), opened
//! lazily on first load. The frontend routes here only when `settings.nativeAudio`
//! is on; otherwise playback stays on Web Audio and these are never called.

use serde::Serialize;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{Manager, State};

#[cfg(not(target_os = "android"))]
use wavr_audio::Engine;

// Android (S4 parked): the cpal→Oboe (C++) engine isn't compiled in yet — it needs libc++_shared.so
// bundled or the lib won't dlopen. Native playback is force-disabled on Android (engine.ts), so this
// stub keeps the Tauri command surface identical; every method is a no-op.
#[cfg(target_os = "android")]
mod stub {
    pub struct Engine;
    impl Engine {
        pub fn new() -> Result<Self, String> { Err("native audio is desktop-only".into()) }
        pub fn load(&self, _: &str) -> Result<(), String> { Ok(()) }
        pub fn load_next(&self, _: &str) -> Result<(), String> { Ok(()) }
        pub fn duration_secs(&self) -> f32 { 0.0 }
        pub fn position_secs(&self) -> f32 { 0.0 }
        pub fn is_playing(&self) -> bool { false }
        pub fn set_playing(&self, _: bool) {}
        pub fn seek_secs(&self, _: f32) {}
        pub fn set_volume(&self, _: f32) {}
        pub fn set_balance(&self, _: f32) {}
        pub fn set_mono(&self, _: bool) {}
        pub fn set_eq_enabled(&self, _: bool) {}
        pub fn set_preamp_db(&self, _: f32) {}
        pub fn set_band_gain(&self, _: usize, _: f32) {}
        pub fn set_band_freq(&self, _: usize, _: f32) {}
        pub fn set_band_q(&self, _: usize, _: f32) {}
        pub fn set_bass_db(&self, _: f32) {}
        pub fn set_treble_db(&self, _: f32) {}
        pub fn set_vocal(&self, _: f32) {}
        pub fn crossfade_to_next(&self, _: u32) {}
        pub fn set_loop(&self, _: Option<(f32, f32)>) {}
        pub fn set_replay_gain_db(&self, _: f32) {}
        pub fn set_clip_prevent(&self, _: bool) {}
        pub fn set_dither_bits(&self, _: u32) {}
    }
}
#[cfg(target_os = "android")]
use stub::Engine;

// Field 0 = the engine, behind an Arc so callers can CLONE the handle out under a brief lock and then
// operate (decode/play/seek/eq) WITHOUT holding the mutex — a long decode no longer blocks every other
// command (that wait, on the GTK main thread, was the multi-second freeze). 1/2/3 = cached last
// position/duration/playing so the 10Hz na_state poll never has to block either.
pub struct NativeAudio(Mutex<Option<Arc<Engine>>>, AtomicU32, AtomicU32, AtomicBool);

impl NativeAudio {
    pub fn new() -> Self {
        NativeAudio(Mutex::new(None), AtomicU32::new(0), AtomicU32::new(0), AtomicBool::new(false))
    }
}

/// Build the audio engine NOW (meant to be called on a BACKGROUND thread). On some Linux setups the cpal
/// ALSA device enumeration is slow (it probes jack/oss/dmix slaves that time out ~seconds). Doing that
/// inside the synchronous `na_load` command froze the UI on first play (sync commands run on the GTK/main
/// thread). Pre-warming off-thread means the device is already open by the time the user hits play.
pub fn prewarm(state: &NativeAudio) {
    // already built?
    if matches!(state.0.lock(), Ok(g) if g.is_some()) { return; }
    // Build OUTSIDE the lock (the slow part), then briefly lock to install — so the ~seconds of device
    // enumeration never holds the engine mutex.
    match Engine::new() {
        Ok(e) => { if let Ok(mut g) = state.0.lock() { if g.is_none() { *g = Some(Arc::new(e)); } } }
        Err(err) => eprintln!("[native-audio] prewarm failed: {err}"),
    }
}

#[derive(Serialize)]
pub struct NaState {
    pub position: f32,
    pub duration: f32,
    pub playing: bool,
}

// spawn_blocking → the whole-file symphonia decode runs on a blocking thread pool, GUARANTEED off the GTK
// main thread (an async command body alone wasn't reliably off-main here).
#[tauri::command]
pub async fn na_load(app: tauri::AppHandle, path: String) -> Result<f32, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<f32, String> {
        let state = app.state::<NativeAudio>();
        // Get/create the engine handle under a BRIEF lock, then decode on the Arc with the lock RELEASED —
        // so play/seek/eq/state called during the decode don't block on the mutex.
        let e: Arc<Engine> = {
            let mut g = state.0.lock().map_err(|_| "audio lock".to_string())?;
            if g.is_none() { *g = Some(Arc::new(Engine::new()?)); }
            g.clone().unwrap()
        };
        e.load(&path)?;
        Ok(e.duration_secs())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn na_play(state: State<NativeAudio>) {
    if let Ok(g) = state.0.lock() {
        if let Some(e) = g.as_ref() { e.set_playing(true); }
    }
}

#[tauri::command]
pub fn na_pause(state: State<NativeAudio>) {
    if let Ok(g) = state.0.lock() {
        if let Some(e) = g.as_ref() { e.set_playing(false); }
    }
}

#[tauri::command]
pub fn na_seek(state: State<NativeAudio>, sec: f32) {
    if let Ok(g) = state.0.lock() {
        if let Some(e) = g.as_ref() { e.seek_secs(sec); }
    }
}

#[tauri::command]
pub fn na_set_volume(state: State<NativeAudio>, v: f32) {
    if let Ok(g) = state.0.lock() {
        if let Some(e) = g.as_ref() { e.set_volume(v); }
    }
}

#[tauri::command]
pub fn na_set_balance(state: State<NativeAudio>, balance: f32) {
    if let Ok(g) = state.0.lock() {
        if let Some(e) = g.as_ref() { e.set_balance(balance); }
    }
}

#[tauri::command]
pub fn na_set_mono(state: State<NativeAudio>, mono: bool) {
    if let Ok(g) = state.0.lock() {
        if let Some(e) = g.as_ref() { e.set_mono(mono); }
    }
}

// Polled at 10Hz. Uses try_lock so it NEVER blocks the caller: if the engine lock is held (a track is
// decoding/loading), return the last cached position/duration/playing instead of waiting — that wait, on
// the GTK main thread, was the multi-second UI freeze. On a successful read we refresh the cache.
#[tauri::command]
pub fn na_state(state: State<NativeAudio>) -> NaState {
    if let Ok(g) = state.0.try_lock() {
        if let Some(e) = g.as_ref() {
            let (p, d, pl) = (e.position_secs(), e.duration_secs(), e.is_playing());
            state.1.store(p.to_bits(), Ordering::Relaxed);
            state.2.store(d.to_bits(), Ordering::Relaxed);
            state.3.store(pl, Ordering::Relaxed);
            return NaState { position: p, duration: d, playing: pl };
        }
        return NaState { position: 0.0, duration: 0.0, playing: false };
    }
    // lock busy (decoding) → last-known, no blocking
    NaState {
        position: f32::from_bits(state.1.load(Ordering::Relaxed)),
        duration: f32::from_bits(state.2.load(Ordering::Relaxed)),
        playing: state.3.load(Ordering::Relaxed),
    }
}

#[tauri::command]
pub fn na_set_eq(state: State<NativeAudio>, enabled: bool, preamp: f32, bands: Vec<f32>, freqs: Vec<f32>, qs: Vec<f32>) {
    if let Ok(g) = state.0.lock() {
        if let Some(e) = g.as_ref() {
            e.set_eq_enabled(enabled);
            e.set_preamp_db(preamp);
            for (i, &db) in bands.iter().enumerate() { e.set_band_gain(i, db); }
            for (i, &hz) in freqs.iter().enumerate() { e.set_band_freq(i, hz); }
            for (i, &q) in qs.iter().enumerate() { e.set_band_q(i, q); }
        }
    }
}

#[tauri::command]
pub fn na_set_tone(state: State<NativeAudio>, bass: f32, treble: f32) {
    if let Ok(g) = state.0.lock() {
        if let Some(e) = g.as_ref() { e.set_bass_db(bass); e.set_treble_db(treble); }
    }
}

#[tauri::command]
pub fn na_set_vocal(state: State<NativeAudio>, k: f32) {
    if let Ok(g) = state.0.lock() {
        if let Some(e) = g.as_ref() { e.set_vocal(k); }
    }
}

// spawn_blocking → next-track decode off the main thread (same reasoning as na_load).
#[tauri::command]
pub async fn na_load_next(app: tauri::AppHandle, path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let state = app.state::<NativeAudio>();
        // clone the handle under a brief lock, then decode the next track with the lock released
        let e: Option<Arc<Engine>> = state.0.lock().ok().and_then(|g| g.clone());
        match e {
            Some(e) => e.load_next(&path),
            None => Err("engine not started".into()),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn na_crossfade(state: State<NativeAudio>, ms: u32) {
    if let Ok(g) = state.0.lock() {
        if let Some(e) = g.as_ref() { e.crossfade_to_next(ms); }
    }
}

#[tauri::command]
pub fn na_set_loop(state: State<NativeAudio>, start: f32, end: f32) {
    if let Ok(g) = state.0.lock() {
        if let Some(e) = g.as_ref() { e.set_loop(Some((start, end))); }
    }
}

#[tauri::command]
pub fn na_clear_loop(state: State<NativeAudio>) {
    if let Ok(g) = state.0.lock() {
        if let Some(e) = g.as_ref() { e.set_loop(None); }
    }
}

#[tauri::command]
pub fn na_set_replaygain(state: State<NativeAudio>, db: f32) {
    if let Ok(g) = state.0.lock() {
        if let Some(e) = g.as_ref() { e.set_replay_gain_db(db); }
    }
}

/// Output stage: clip prevention (soft limiter @ 0 dBFS) + dither (0 = off, else 16/24-bit TPDF).
#[tauri::command]
pub fn na_set_output(state: State<NativeAudio>, clip_prevent: bool, dither_bits: u32) {
    if let Ok(g) = state.0.lock() {
        if let Some(e) = g.as_ref() { e.set_clip_prevent(clip_prevent); e.set_dither_bits(dither_bits); }
    }
}
