//! Native Android folder picking (Storage Access Framework). The actual UI + traversal live in
//! the Kotlin `FolderPlugin`; this is the Rust bridge that exposes `pick_folder` / `list_folder`
//! to the frontend. On desktop these are no-ops (use the native directory dialog there instead).

use serde::{Deserialize, Serialize};
use tauri::{
    ipc::Channel,
    plugin::{Builder, TauriPlugin},
    Runtime,
};

#[cfg(mobile)]
// `Manager` is used only on mobile (app.state()/app.manage() in the #[cfg(mobile)] paths); allow the
// unused-import warning on desktop builds where those paths are compiled out.
#[allow(unused_imports)]
use tauri::{plugin::PluginHandle, AppHandle, Manager};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ListArgs {
    uri: String,
}

/// Args for the streaming variant: forwards a JS `Channel` to the Kotlin plugin so it can emit
/// progress + track batches as it walks the SAF tree. The channel serializes to its callback id.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ListStreamArgs {
    uri: String,
    on_event: Channel<serde_json::Value>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct PickResult {
    pub uri: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct FolderTrack {
    pub uri: String,
    pub name: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct ListResult {
    pub tracks: Vec<FolderTrack>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StartIndexingArgs {
    uri: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenUrlArgs {
    url: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReadIndexArgs {
    skip: u32,
    limit: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReadBytesArgs {
    uri: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadBytesResult {
    pub data: String, // base64
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoverResult {
    pub data: Option<String>, // data: URL of the embedded art thumbnail, or None
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TagUrisArgs {
    uris: Vec<String>,
}

/// Real tag rows for a batch of content:// URIs (passed through verbatim from the Kotlin reader).
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct TagRowsResult {
    pub tracks: Vec<serde_json::Value>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MediaScanArgs {
    offset: u32,
    limit: u32,
    folder: Option<String>,
}

/// A page of MediaStore rows (full tags, passed through verbatim) + the library total.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaScanResult {
    pub tracks: Vec<serde_json::Value>,
    #[serde(default)]
    pub total: u32,
    #[serde(default)]
    pub needs_permission: bool,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct PermResult {
    #[serde(default)]
    pub granted: bool,
}

/// List of music folders (RELATIVE_PATH + count) for the in-app folder picker.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FoldersResult {
    pub folders: Vec<serde_json::Value>,
    #[serde(default)]
    pub needs_permission: bool,
}

/// On-disk indexing heartbeat written by the Android foreground service.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexStatus {
    pub exists: bool,
    pub files: u32,
    pub folders: u32,
    pub done: bool,
    pub ts: f64,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemColors {
    pub available: bool,
    pub accent: Option<String>,
    pub accent2: Option<String>,
    pub neutral_dark: Option<String>,
    pub neutral_light: Option<String>,
}

#[cfg(mobile)]
struct Folder<R: Runtime>(PluginHandle<R>);

#[cfg(mobile)]
impl<R: Runtime> Folder<R> {
    fn pick_folder(&self) -> Result<PickResult, String> {
        self.0.run_mobile_plugin("pickFolder", ()).map_err(|e| e.to_string())
    }
    fn list_folder(&self, uri: String) -> Result<ListResult, String> {
        self.0.run_mobile_plugin("listFolder", ListArgs { uri }).map_err(|e| e.to_string())
    }
    fn list_folder_stream(&self, uri: String, on_event: Channel<serde_json::Value>) -> Result<(), String> {
        self.0.run_mobile_plugin("listFolderStream", ListStreamArgs { uri, on_event }).map_err(|e| e.to_string())
    }
    fn system_colors(&self) -> Result<SystemColors, String> {
        self.0.run_mobile_plugin("systemColors", ()).map_err(|e| e.to_string())
    }
    fn start_indexing(&self, uri: String) -> Result<(), String> {
        self.0.run_mobile_plugin("startIndexing", StartIndexingArgs { uri }).map_err(|e| e.to_string())
    }
    fn stop_indexing(&self) -> Result<(), String> {
        self.0.run_mobile_plugin("stopIndexing", ()).map_err(|e| e.to_string())
    }
    fn clear_index(&self) -> Result<(), String> {
        self.0.run_mobile_plugin("clearIndex", ()).map_err(|e| e.to_string())
    }
    fn index_status(&self) -> Result<IndexStatus, String> {
        self.0.run_mobile_plugin("indexStatus", ()).map_err(|e| e.to_string())
    }
    fn read_index(&self, skip: u32, limit: u32) -> Result<ListResult, String> {
        self.0.run_mobile_plugin("readIndex", ReadIndexArgs { skip, limit }).map_err(|e| e.to_string())
    }
    fn open_url(&self, url: String) -> Result<(), String> {
        self.0.run_mobile_plugin("openUrl", OpenUrlArgs { url }).map_err(|e| e.to_string())
    }
    fn read_bytes(&self, uri: String) -> Result<ReadBytesResult, String> {
        self.0.run_mobile_plugin("readBytes", ReadBytesArgs { uri }).map_err(|e| e.to_string())
    }
    fn cover_uri(&self, uri: String) -> Result<CoverResult, String> {
        self.0.run_mobile_plugin("coverUri", ReadBytesArgs { uri }).map_err(|e| e.to_string())
    }
    fn cover_cache_clear(&self) -> Result<(), String> {
        self.0.run_mobile_plugin("coverCacheClear", ()).map_err(|e| e.to_string())
    }
    fn read_tags_uris(&self, uris: Vec<String>) -> Result<TagRowsResult, String> {
        self.0.run_mobile_plugin("readTagsUris", TagUrisArgs { uris }).map_err(|e| e.to_string())
    }
    fn media_store_scan(&self, offset: u32, limit: u32, folder: Option<String>) -> Result<MediaScanResult, String> {
        self.0.run_mobile_plugin("mediaStoreScan", MediaScanArgs { offset, limit, folder }).map_err(|e| e.to_string())
    }
    fn has_media_permission(&self) -> Result<PermResult, String> {
        self.0.run_mobile_plugin("hasMediaPermission", ()).map_err(|e| e.to_string())
    }
    fn request_media_permission(&self) -> Result<(), String> {
        self.0.run_mobile_plugin("requestMediaPermission", ()).map_err(|e| e.to_string())
    }
    fn media_store_folders(&self) -> Result<FoldersResult, String> {
        self.0.run_mobile_plugin("mediaStoreFolders", ()).map_err(|e| e.to_string())
    }
}

/// Open a URL in the system default handler (browser / a lyrics app on Android). Desktop uses the
/// platform launcher; Android fires an ACTION_VIEW intent via the plugin.
#[cfg(not(mobile))]
fn open_url_desktop(url: &str) -> Result<(), String> {
    use std::process::Command;
    #[cfg(target_os = "linux")]
    let mut cmd = { let mut c = Command::new("xdg-open"); c.arg(url); c };
    #[cfg(target_os = "macos")]
    let mut cmd = { let mut c = Command::new("open"); c.arg(url); c };
    #[cfg(target_os = "windows")]
    let mut cmd = { let mut c = Command::new("cmd"); c.args(["/C", "start", "", url]); c };
    cmd.spawn().map(|_| ()).map_err(|e| e.to_string())
}

// Regular app commands (allowed by default — no plugin ACL needed). The plugin below only
// registers + manages the native handle.
#[tauri::command]
pub async fn pick_folder<R: Runtime>(app: tauri::AppHandle<R>) -> Result<PickResult, String> {
    #[cfg(mobile)]
    {
        return app.state::<Folder<R>>().pick_folder();
    }
    #[cfg(not(mobile))]
    {
        let _ = app;
        Err("Native folder picker is Android-only.".into())
    }
}

#[tauri::command]
pub async fn list_folder<R: Runtime>(app: tauri::AppHandle<R>, uri: String) -> Result<ListResult, String> {
    #[cfg(mobile)]
    {
        return app.state::<Folder<R>>().list_folder(uri);
    }
    #[cfg(not(mobile))]
    {
        let _ = (app, uri);
        Err("Native folder listing is Android-only.".into())
    }
}

#[tauri::command]
pub async fn list_folder_stream<R: Runtime>(app: tauri::AppHandle<R>, uri: String, on_event: Channel<serde_json::Value>) -> Result<(), String> {
    #[cfg(mobile)]
    {
        return app.state::<Folder<R>>().list_folder_stream(uri, on_event);
    }
    #[cfg(not(mobile))]
    {
        let _ = (app, uri, on_event);
        Err("Native folder listing is Android-only.".into())
    }
}

#[tauri::command]
pub async fn start_indexing<R: Runtime>(app: tauri::AppHandle<R>, uri: String) -> Result<(), String> {
    #[cfg(mobile)]
    {
        return app.state::<Folder<R>>().start_indexing(uri);
    }
    #[cfg(not(mobile))]
    {
        let _ = (app, uri);
        Err("Background indexing is Android-only.".into())
    }
}

#[tauri::command]
pub async fn stop_indexing<R: Runtime>(app: tauri::AppHandle<R>) -> Result<(), String> {
    #[cfg(mobile)]
    {
        return app.state::<Folder<R>>().stop_indexing();
    }
    #[cfg(not(mobile))]
    {
        let _ = app;
        Ok(())
    }
}

#[tauri::command]
pub async fn clear_index<R: Runtime>(app: tauri::AppHandle<R>) -> Result<(), String> {
    #[cfg(mobile)]
    {
        return app.state::<Folder<R>>().clear_index();
    }
    #[cfg(not(mobile))]
    {
        let _ = app;
        Ok(())
    }
}

#[tauri::command]
pub async fn index_status<R: Runtime>(app: tauri::AppHandle<R>) -> Result<IndexStatus, String> {
    #[cfg(mobile)]
    {
        return app.state::<Folder<R>>().index_status();
    }
    #[cfg(not(mobile))]
    {
        let _ = app;
        Ok(IndexStatus::default())
    }
}

#[tauri::command]
pub async fn read_index<R: Runtime>(app: tauri::AppHandle<R>, skip: u32, limit: u32) -> Result<ListResult, String> {
    #[cfg(mobile)]
    {
        return app.state::<Folder<R>>().read_index(skip, limit);
    }
    #[cfg(not(mobile))]
    {
        let _ = (app, skip, limit);
        Ok(ListResult::default())
    }
}

#[tauri::command]
pub async fn read_bytes<R: Runtime>(app: tauri::AppHandle<R>, uri: String) -> Result<ReadBytesResult, String> {
    #[cfg(mobile)]
    {
        return app.state::<Folder<R>>().read_bytes(uri);
    }
    #[cfg(not(mobile))]
    {
        let _ = (app, uri);
        Err("Native byte read is Android-only.".into())
    }
}

#[tauri::command]
pub async fn cover_uri<R: Runtime>(app: tauri::AppHandle<R>, uri: String) -> Result<CoverResult, String> {
    #[cfg(mobile)]
    {
        return app.state::<Folder<R>>().cover_uri(uri);
    }
    #[cfg(not(mobile))]
    {
        let _ = (app, uri);
        Ok(CoverResult::default())
    }
}

/// Clear the Android Kotlin cover cache (`cacheDir/covers`). Desktop uses `commands::cover_cache_clear`.
#[tauri::command]
pub async fn clear_cover_cache<R: Runtime>(app: tauri::AppHandle<R>) -> Result<(), String> {
    #[cfg(mobile)]
    {
        return app.state::<Folder<R>>().cover_cache_clear();
    }
    #[cfg(not(mobile))]
    {
        let _ = app;
        Ok(())
    }
}

/// Read real tags for a batch of content:// URIs (Android MediaMetadataRetriever). Desktop: empty.
#[tauri::command]
pub async fn read_tags_uris<R: Runtime>(app: tauri::AppHandle<R>, uris: Vec<String>) -> Result<TagRowsResult, String> {
    #[cfg(mobile)]
    {
        return app.state::<Folder<R>>().read_tags_uris(uris);
    }
    #[cfg(not(mobile))]
    {
        let _ = (app, uris);
        Ok(TagRowsResult::default())
    }
}

/// Fast Android library scan via MediaStore (paged). Desktop: empty (uses the native folder scan).
#[tauri::command]
pub async fn media_store_scan<R: Runtime>(app: tauri::AppHandle<R>, offset: u32, limit: u32, folder: Option<String>) -> Result<MediaScanResult, String> {
    #[cfg(mobile)]
    {
        return app.state::<Folder<R>>().media_store_scan(offset, limit, folder);
    }
    #[cfg(not(mobile))]
    {
        let _ = (app, offset, limit, folder);
        Ok(MediaScanResult::default())
    }
}

#[tauri::command]
pub async fn has_media_permission<R: Runtime>(app: tauri::AppHandle<R>) -> Result<PermResult, String> {
    #[cfg(mobile)]
    { return app.state::<Folder<R>>().has_media_permission(); }
    #[cfg(not(mobile))]
    { let _ = app; Ok(PermResult { granted: false }) }
}

#[tauri::command]
pub async fn request_media_permission<R: Runtime>(app: tauri::AppHandle<R>) -> Result<(), String> {
    #[cfg(mobile)]
    { return app.state::<Folder<R>>().request_media_permission(); }
    #[cfg(not(mobile))]
    { let _ = app; Ok(()) }
}

#[tauri::command]
pub async fn media_store_folders<R: Runtime>(app: tauri::AppHandle<R>) -> Result<FoldersResult, String> {
    #[cfg(mobile)]
    { return app.state::<Folder<R>>().media_store_folders(); }
    #[cfg(not(mobile))]
    { let _ = app; Ok(FoldersResult::default()) }
}

#[tauri::command]
pub async fn open_url<R: Runtime>(app: tauri::AppHandle<R>, url: String) -> Result<(), String> {
    #[cfg(mobile)]
    {
        return app.state::<Folder<R>>().open_url(url);
    }
    #[cfg(not(mobile))]
    {
        let _ = app;
        open_url_desktop(&url)
    }
}

#[tauri::command]
pub async fn system_colors<R: Runtime>(app: tauri::AppHandle<R>) -> Result<SystemColors, String> {
    #[cfg(mobile)]
    {
        return app.state::<Folder<R>>().system_colors();
    }
    #[cfg(not(mobile))]
    {
        let _ = app;
        Ok(SystemColors::default())
    }
}

/// Plugin that only registers the Android `FolderPlugin` and stores its handle as managed state.
/// (No plugin commands → no extra ACL permissions; the commands above are plain app commands.)
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("folder")
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            {
                let handle = _api.register_android_plugin("com.wavr.play", "FolderPlugin")?;
                _app.manage(Folder(handle));
            }
            Ok(())
        })
        .build()
}
