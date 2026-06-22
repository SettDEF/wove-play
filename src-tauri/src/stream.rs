//! Tauri glue for the local media streaming server (`wavr-stream`). Started once on setup, bound to
//! loopback so `<audio>` can stream + range-seek a file instead of loading it whole. `stream_url`
//! registers a real filesystem path and returns its `http://127.0.0.1:<port>/f/<token>` URL.
//!
//! NOTE: serves real file PATHS. Android `content://` URIs aren't filesystem paths — streaming those
//! needs an Android-side reader bridge (follow-up); until then they keep the existing read path.

use std::net::UdpSocket;
use std::sync::Mutex;
use tauri::State;
use wavr_stream::StreamServer;

pub struct MediaServer(pub Mutex<Option<StreamServer>>);

impl MediaServer {
    pub fn new() -> Self {
        // Loopback only for now (in-app playback). LAN/Chromecast will start a second 0.0.0.0 binding.
        MediaServer(Mutex::new(StreamServer::start("127.0.0.1").ok()))
    }
}

/// Register a filesystem path with the server and return a streamable loopback URL (or null on
/// non-path inputs / if the server didn't start — caller falls back to the existing path).
#[tauri::command]
pub fn stream_url(state: State<MediaServer>, path: String) -> Option<String> {
    if path.starts_with("content://") || path.starts_with("http") { return None; }
    let g = state.0.lock().ok()?;
    let srv = g.as_ref()?;
    Some(srv.url("127.0.0.1", std::path::PathBuf::from(path)))
}

/// Re-bind the media server: LAN (`0.0.0.0`, reachable by Chromecast / nearby devices) or loopback
/// only. Registered tokens reset on a re-bind (URLs are re-fetched per play, so that's fine).
#[tauri::command]
pub fn stream_set_lan(state: State<MediaServer>, on: bool) {
    let host = if on { "0.0.0.0" } else { "127.0.0.1" };
    if let Ok(mut g) = state.0.lock() {
        *g = StreamServer::start(host).ok();
    }
}

/// This machine's primary LAN IP (the source address used to reach the network). `None` if offline.
fn local_ip() -> Option<String> {
    let sock = UdpSocket::bind("0.0.0.0:0").ok()?;
    sock.connect("8.8.8.8:80").ok()?; // no packet is sent; just resolves the egress interface
    sock.local_addr().ok().map(|a| a.ip().to_string())
}

/// A stream URL addressed by this machine's LAN IP, so a cast device on the same Wi-Fi can reach it.
/// Requires LAN sharing on (server bound to `0.0.0.0`) — the cast flow enables it first.
#[tauri::command]
pub fn cast_url(state: State<MediaServer>, path: String) -> Option<String> {
    let ip = local_ip()?;
    let g = state.0.lock().ok()?;
    let srv = g.as_ref()?;
    Some(srv.url(&ip, std::path::PathBuf::from(path)))
}
