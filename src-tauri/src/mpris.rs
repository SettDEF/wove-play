//! Desktop OS media controls. On LINUX this exposes an MPRIS interface (via `souvlaki` + zbus) so the
//! system media notification / lock screen / KDE-GNOME widgets show the cover + title + artist + album and
//! drive play/pause/next/prev/seek. Control presses are emitted to the frontend as a `mpris-control`
//! event (`{ kind, pos }`). On non-Linux desktops this is a no-op (the WebView's W3C MediaSession covers
//! them); Android uses its own MediaSession plugin.

use tauri::{AppHandle, Runtime};

#[cfg(target_os = "linux")]
mod imp {
    use std::sync::Mutex;
    use std::time::Duration;
    use souvlaki::{MediaControlEvent, MediaControls, MediaMetadata, MediaPlayback, MediaPosition, PlatformConfig, SeekDirection};
    use tauri::{AppHandle, Emitter, Manager, Runtime};

    pub struct Mpris(pub Mutex<Option<MediaControls>>);
    impl Mpris {
        pub fn new() -> Self { Self(Mutex::new(None)) }
    }

    fn kind(e: &MediaControlEvent) -> Option<(&'static str, f64)> {
        Some(match e {
            MediaControlEvent::Play => ("play", 0.0),
            MediaControlEvent::Pause => ("pause", 0.0),
            MediaControlEvent::Toggle => ("toggle", 0.0),
            MediaControlEvent::Next => ("next", 0.0),
            MediaControlEvent::Previous => ("prev", 0.0),
            MediaControlEvent::Stop => ("stop", 0.0),
            MediaControlEvent::Seek(SeekDirection::Forward) => ("forward", 0.0),
            MediaControlEvent::Seek(SeekDirection::Backward) => ("rewind", 0.0),
            MediaControlEvent::SetPosition(MediaPosition(d)) => ("seek", d.as_secs_f64()),
            _ => return None,
        })
    }

    fn ensure<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
        let st = app.state::<Mpris>();
        let mut g = st.0.lock().map_err(|_| "mpris lock")?;
        if g.is_some() {
            return Ok(());
        }
        let cfg = PlatformConfig { dbus_name: "wove", display_name: "Wove", hwnd: None };
        let mut controls = MediaControls::new(cfg).map_err(|e| format!("{e:?}"))?;
        let h = app.clone();
        controls
            .attach(move |e: MediaControlEvent| {
                if let Some((k, pos)) = kind(&e) {
                    let _ = h.emit("mpris-control", serde_json::json!({ "kind": k, "pos": pos }));
                }
            })
            .map_err(|e| format!("{e:?}"))?;
        *g = Some(controls);
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn update<R: Runtime>(
        app: &AppHandle<R>, title: String, artist: String, album: String,
        duration_sec: f64, position_sec: f64, playing: bool, art: Option<String>,
    ) -> Result<(), String> {
        ensure(app)?;
        // cover bytes → cache file → file:// URL (MPRIS wants a URL, not raw bytes)
        let cover_url = art.and_then(|b64| {
            use base64::Engine;
            let bytes = base64::engine::general_purpose::STANDARD.decode(b64.as_bytes()).ok()?;
            let dir = app.path().app_cache_dir().ok()?;
            let _ = std::fs::create_dir_all(&dir);
            let p = dir.join("mpris-cover.jpg");
            std::fs::write(&p, bytes).ok()?;
            Some(format!("file://{}", p.to_string_lossy()))
        });
        let st = app.state::<Mpris>();
        let mut g = st.0.lock().map_err(|_| "mpris lock")?;
        if let Some(c) = g.as_mut() {
            c.set_metadata(MediaMetadata {
                title: Some(&title), album: Some(&album), artist: Some(&artist),
                cover_url: cover_url.as_deref(),
                duration: (duration_sec > 0.0).then(|| Duration::from_secs_f64(duration_sec)),
            })
            .map_err(|e| format!("{e:?}"))?;
            let pos = Some(MediaPosition(Duration::from_secs_f64(position_sec.max(0.0))));
            c.set_playback(if playing { MediaPlayback::Playing { progress: pos } } else { MediaPlayback::Paused { progress: pos } })
                .map_err(|e| format!("{e:?}"))?;
        }
        Ok(())
    }

    // Lightweight: update only play/pause + position (no metadata, no cover re-write) — for the frequent
    // position ticks.
    pub fn playback<R: Runtime>(app: &AppHandle<R>, playing: bool, position_sec: f64) -> Result<(), String> {
        let st = app.state::<Mpris>();
        let mut g = st.0.lock().map_err(|_| "mpris lock")?;
        if let Some(c) = g.as_mut() {
            let pos = Some(MediaPosition(Duration::from_secs_f64(position_sec.max(0.0))));
            c.set_playback(if playing { MediaPlayback::Playing { progress: pos } } else { MediaPlayback::Paused { progress: pos } })
                .map_err(|e| format!("{e:?}"))?;
        }
        Ok(())
    }

    pub fn clear<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
        let st = app.state::<Mpris>();
        if let Ok(mut g) = st.0.lock() {
            if let Some(c) = g.as_mut() {
                let _ = c.set_playback(MediaPlayback::Stopped);
            }
        }
        Ok(())
    }
}

#[cfg(target_os = "linux")]
pub use imp::Mpris;

#[cfg(not(target_os = "linux"))]
pub struct Mpris;
#[cfg(not(target_os = "linux"))]
impl Mpris {
    pub fn new() -> Self { Self }
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn mpris_update<R: Runtime>(
    app: AppHandle<R>, title: String, artist: String, album: String,
    duration_sec: f64, position_sec: f64, playing: bool, art: Option<String>,
) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        return imp::update(&app, title, artist, album, duration_sec, position_sec, playing, art);
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (app, title, artist, album, duration_sec, position_sec, playing, art);
        Ok(())
    }
}

#[tauri::command]
pub async fn mpris_playback<R: Runtime>(app: AppHandle<R>, playing: bool, position_sec: f64) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        return imp::playback(&app, playing, position_sec);
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (app, playing, position_sec);
        Ok(())
    }
}

#[tauri::command]
pub async fn mpris_clear<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        return imp::clear(&app);
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = app;
        Ok(())
    }
}
