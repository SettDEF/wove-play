//! Native Android media session / background playback bridge. The session + foreground service
//! live in the Kotlin `MediaPlugin` / `PlaybackService`; this is the Rust side that exposes
//! `media_start` / `media_update` / `media_stop` to the frontend and registers the Android plugin
//! (so its `control` events reach JS via `addPluginListener("wavrmedia", "control", …)`).
//!
//! Audio playback itself stays in the WebView's Web Audio engine — this only owns the OS-level
//! media session. On desktop these commands are no-ops (desktop already has the W3C MediaSession;
//! MPRIS is a separate later task).

use serde::Serialize;
use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

#[cfg(mobile)]
use tauri::{plugin::PluginHandle, Manager};

/// Mirrors the Kotlin `MediaUpdateArgs`. Sent on every metadata / state / position change.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct MediaUpdateArgs {
    title: String,
    artist: String,
    album: String,
    duration_sec: f64,
    position_sec: f64,
    playing: bool,
    /// base64 image (no `data:` prefix); only applied when `art_changed` is true.
    art: Option<String>,
    art_changed: bool,
    /// ordered notification transport buttons (null = leave unchanged); first 3 = compact view.
    actions: Option<Vec<String>>,
    /// current track is loved → filled heart on the Like button.
    liked: bool,
    /// what to render under the title: artist-album | artist | album | none.
    notif_text: String,
    /// white status-bar icon: note | play | wave | eq | bolt | pulse.
    notif_icon: String,
    /// notification style: media (MediaStyle) | plain.
    notif_style: String,
}

/// Mirrors the Kotlin `BrowseArgs`: the Android Auto browse catalog (flat parentId → children JSON).
#[derive(Serialize, Clone)]
struct BrowseArgs {
    tree: String,
}

#[cfg(mobile)]
struct Media<R: Runtime>(PluginHandle<R>);

#[cfg(mobile)]
impl<R: Runtime> Media<R> {
    fn start(&self) -> Result<(), String> {
        self.0.run_mobile_plugin::<serde_json::Value>("mediaStart", ()).map(|_| ()).map_err(|e| e.to_string())
    }
    fn update(&self, args: MediaUpdateArgs) -> Result<(), String> {
        self.0.run_mobile_plugin::<serde_json::Value>("mediaUpdate", args).map(|_| ()).map_err(|e| e.to_string())
    }
    fn stop(&self) -> Result<(), String> {
        self.0.run_mobile_plugin::<serde_json::Value>("mediaStop", ()).map(|_| ()).map_err(|e| e.to_string())
    }
    fn set_browse_tree(&self, tree: String) -> Result<(), String> {
        self.0.run_mobile_plugin::<serde_json::Value>("setBrowseTree", BrowseArgs { tree }).map(|_| ()).map_err(|e| e.to_string())
    }
    fn bt_has_permission(&self) -> Result<bool, String> {
        self.0.run_mobile_plugin::<BtPerm>("btHasPermission", ()).map(|p| p.granted).map_err(|e| e.to_string())
    }
    fn bt_request_permission(&self) -> Result<(), String> {
        self.0.run_mobile_plugin::<serde_json::Value>("btRequestPermission", ()).map(|_| ()).map_err(|e| e.to_string())
    }
    fn content_stream_url(&self, uri: String) -> Result<Option<String>, String> {
        self.0.run_mobile_plugin::<ContentUrl>("contentStreamUrl", ContentUriArgs { uri }).map(|r| r.url).map_err(|e| e.to_string())
    }
    fn set_app_icon(&self, id: String) -> Result<(), String> {
        self.0.run_mobile_plugin::<serde_json::Value>("setAppIcon", IconArgs { id }).map(|_| ()).map_err(|e| e.to_string())
    }
}

#[cfg(mobile)]
#[derive(Serialize, Clone)]
struct ContentUriArgs {
    uri: String,
}

#[cfg(mobile)]
#[derive(Serialize, Clone)]
struct IconArgs {
    id: String,
}

#[cfg(mobile)]
#[derive(serde::Deserialize)]
struct ContentUrl {
    #[serde(default)]
    url: Option<String>,
}

#[cfg(mobile)]
#[derive(serde::Deserialize)]
struct BtPerm {
    granted: bool,
}

#[tauri::command]
pub async fn media_start<R: Runtime>(app: tauri::AppHandle<R>) -> Result<(), String> {
    #[cfg(mobile)]
    {
        return app.state::<Media<R>>().start();
    }
    #[cfg(not(mobile))]
    {
        let _ = app;
        Ok(())
    }
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn media_update<R: Runtime>(
    app: tauri::AppHandle<R>,
    title: String,
    artist: String,
    album: String,
    duration_sec: f64,
    position_sec: f64,
    playing: bool,
    art: Option<String>,
    art_changed: bool,
    actions: Option<Vec<String>>,
    liked: bool,
    notif_text: String,
    notif_icon: String,
    notif_style: String,
) -> Result<(), String> {
    #[cfg(mobile)]
    {
        return app.state::<Media<R>>().update(MediaUpdateArgs {
            title,
            artist,
            album,
            duration_sec,
            position_sec,
            playing,
            art,
            art_changed,
            actions,
            liked,
            notif_text,
            notif_icon,
            notif_style,
        });
    }
    #[cfg(not(mobile))]
    {
        let _ = (app, title, artist, album, duration_sec, position_sec, playing, art, art_changed, actions, liked, notif_text, notif_icon, notif_style);
        Ok(())
    }
}

#[tauri::command]
pub async fn media_stop<R: Runtime>(app: tauri::AppHandle<R>) -> Result<(), String> {
    #[cfg(mobile)]
    {
        return app.state::<Media<R>>().stop();
    }
    #[cfg(not(mobile))]
    {
        let _ = app;
        Ok(())
    }
}

#[tauri::command]
pub async fn media_set_browse_tree<R: Runtime>(app: tauri::AppHandle<R>, tree: String) -> Result<(), String> {
    #[cfg(mobile)]
    {
        return app.state::<Media<R>>().set_browse_tree(tree);
    }
    #[cfg(not(mobile))]
    {
        let _ = (app, tree);
        Ok(())
    }
}

#[tauri::command]
pub async fn media_bt_has_permission<R: Runtime>(app: tauri::AppHandle<R>) -> Result<bool, String> {
    #[cfg(mobile)]
    {
        return app.state::<Media<R>>().bt_has_permission();
    }
    #[cfg(not(mobile))]
    {
        let _ = app;
        Ok(false)
    }
}

#[tauri::command]
pub async fn media_bt_request_permission<R: Runtime>(app: tauri::AppHandle<R>) -> Result<(), String> {
    #[cfg(mobile)]
    {
        return app.state::<Media<R>>().bt_request_permission();
    }
    #[cfg(not(mobile))]
    {
        let _ = app;
        Ok(())
    }
}

#[tauri::command]
pub async fn media_content_stream_url<R: Runtime>(app: tauri::AppHandle<R>, uri: String) -> Result<Option<String>, String> {
    #[cfg(mobile)]
    {
        return app.state::<Media<R>>().content_stream_url(uri);
    }
    #[cfg(not(mobile))]
    {
        let _ = (app, uri);
        Ok(None)
    }
}

#[tauri::command]
pub async fn media_set_app_icon<R: Runtime>(app: tauri::AppHandle<R>, id: String) -> Result<(), String> {
    #[cfg(mobile)]
    {
        return app.state::<Media<R>>().set_app_icon(id);
    }
    #[cfg(not(mobile))]
    {
        let _ = (app, id);
        Ok(())
    }
}

/// Registers the Android `MediaPlugin` and stores its handle. The plugin name (`wavrmedia`) is the
/// key the frontend uses for `addPluginListener("wavrmedia", "control", …)`.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("wavrmedia")
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            {
                let handle = _api.register_android_plugin("com.wavr.play", "MediaPlugin")?;
                _app.manage(Media(handle));
            }
            Ok(())
        })
        .build()
}
