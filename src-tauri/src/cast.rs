//! Tauri glue for casting (`wavr-cast`). Discovers DLNA renderers + Chromecasts on the LAN and pushes
//! the current track — served by the LAN-bound `wavr-stream` — to the chosen device.
//!
//! Casting inherently needs the media server reachable off-loopback: the frontend turns on LAN
//! sharing (Connect settings) before it builds a cast URL with `stream::cast_url`.

use std::sync::Mutex;
use std::time::Duration;
use tauri::State;
use wavr_cast::{CastDevice, Kind};

/// Holds the most recent discovery results so `cast_play`/`cast_stop` can resolve a device by id.
pub struct CastState(pub Mutex<Vec<CastDevice>>);
impl CastState {
    pub fn new() -> Self { CastState(Mutex::new(Vec::new())) }
}

#[derive(serde::Serialize)]
pub struct CastDeviceDto {
    pub id: String,
    pub name: String,
    pub kind: &'static str, // "dlna" | "chromecast"
    pub address: String,
}

fn dto(d: &CastDevice) -> CastDeviceDto {
    CastDeviceDto {
        id: d.id.clone(),
        name: d.name.clone(),
        kind: match d.kind { Kind::Dlna => "dlna", Kind::Chromecast => "chromecast" },
        address: d.address.clone(),
    }
}

/// Scan the LAN (~2.5s) and return the discovered devices, caching them for play/stop.
#[tauri::command]
pub fn cast_discover(state: State<CastState>) -> Vec<CastDeviceDto> {
    let found = wavr_cast::discover(Duration::from_millis(2500));
    let dtos = found.iter().map(dto).collect();
    if let Ok(mut g) = state.0.lock() { *g = found; }
    dtos
}

/// Play a media URL on a discovered device. `url` is a LAN stream URL from `stream::cast_url`.
#[tauri::command]
pub fn cast_play(state: State<CastState>, id: String, url: String, title: String) -> Result<(), String> {
    let device = {
        let g = state.0.lock().map_err(|_| "cast state poisoned")?;
        g.iter().find(|d| d.id == id).cloned().ok_or("device not found — rescan")?
    };
    let mime = mime_for(&url);
    wavr_cast::play(&device, &url, &title, mime).map_err(|e| e.to_string())
}

/// Stop playback on a discovered device.
#[tauri::command]
pub fn cast_stop(state: State<CastState>, id: String) -> Result<(), String> {
    let device = {
        let g = state.0.lock().map_err(|_| "cast state poisoned")?;
        g.iter().find(|d| d.id == id).cloned().ok_or("device not found")?
    };
    wavr_cast::stop(&device).map_err(|e| e.to_string())
}

fn mime_for(url: &str) -> &'static str {
    let ext = url.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "mp3" => "audio/mpeg",
        "flac" => "audio/flac",
        "wav" => "audio/wav",
        "ogg" | "oga" => "audio/ogg",
        "opus" => "audio/opus",
        "m4a" | "mp4" | "aac" => "audio/mp4",
        "aiff" | "aif" => "audio/aiff",
        _ => "audio/mpeg",
    }
}
