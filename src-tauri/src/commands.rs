use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::time::UNIX_EPOCH;
use walkdir::WalkDir;

use lofty::file::{AudioFile, TaggedFileExt};
use lofty::tag::{Accessor, ItemKey};
use tauri::ipc::Channel;
use tauri::Manager;

/// Print a line to the process STDERR so it shows in the `tauri dev` TERMINAL (webview `console.*` does
/// not reach it). Used by the lag monitor so perf stalls land where you can copy/paste them. Cheap +
/// fire-and-forget from JS; only called for actual stalls, so the IPC volume is negligible.
#[tauri::command]
pub fn debug_log(line: String) {
    eprintln!("{line}");
}

/// One scanned audio file with metadata (no decode — just a tag read).
#[derive(Serialize, Deserialize, Clone)]
pub struct ScannedTrack {
    pub path: String,
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub album_artist: Option<String>,
    pub genre: Option<String>,
    pub year: Option<u32>,
    pub track_no: Option<u32>,
    pub disc_no: Option<u32>,
    pub duration: Option<f64>,
    /// File modified time (secs since epoch) — for incremental rescans.
    pub mtime: Option<f64>,
    /// Containing folder (only the library cache round-trips this; the native scan leaves it None).
    #[serde(default)]
    pub folder: Option<String>,
}

const AUDIO_EXTS: &[&str] = &["mp3", "flac", "wav", "ogg", "oga", "m4a", "aac", "opus", "wma", "aiff", "aif"];

fn is_audio(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| AUDIO_EXTS.contains(&e.to_lowercase().as_str()))
        .unwrap_or(false)
}

fn mtime_of(path: &Path) -> Option<f64> {
    std::fs::metadata(path).ok()?.modified().ok()?.duration_since(UNIX_EPOCH).ok().map(|d| d.as_secs_f64())
}

fn read_meta(path: &Path) -> ScannedTrack {
    let mut out = ScannedTrack {
        path: path.to_string_lossy().to_string(),
        title: None, artist: None, album: None, album_artist: None, genre: None,
        year: None, track_no: None, disc_no: None, duration: None, mtime: mtime_of(path), folder: None,
    };
    if let Ok(tagged) = lofty::read_from_path(path) {
        out.duration = Some(tagged.properties().duration().as_secs_f64());
        if let Some(tag) = tagged.primary_tag().or_else(|| tagged.first_tag()) {
            // treat blank/whitespace tag values as missing so the filename fallback can fill them
            let clean = |s: &str| { let t = s.trim(); if t.is_empty() { None } else { Some(t.to_string()) } };
            out.title = tag.title().and_then(|s| clean(&s));
            out.artist = tag.artist().and_then(|s| clean(&s));
            out.album = tag.album().and_then(|s| clean(&s));
            out.genre = tag.genre().and_then(|s| clean(&s));
            out.year = tag.year();
            out.track_no = tag.track();
            out.disc_no = tag.disk();
            out.album_artist = tag.get_string(&ItemKey::AlbumArtist).and_then(clean);
        }
    }
    // Fallback for untagged files (common for downloaded tracks named "Artist - Title.ext"):
    // parse artist/title from the filename so they're still grouped properly in the library.
    if out.artist.is_none() || out.title.is_none() {
        let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
        match stem.split_once(" - ") {
            Some((a, t)) => {
                if out.artist.is_none() { out.artist = Some(a.trim().to_string()); }
                if out.title.is_none() { out.title = Some(t.trim().to_string()); }
            }
            None => { if out.title.is_none() { out.title = Some(stem.to_string()); } }
        }
    }
    out
}

/// Recursively scan a folder for audio files and return them with metadata.
#[tauri::command]
pub async fn scan_library(folder: String) -> Result<Vec<ScannedTrack>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut tracks = Vec::new();
        for entry in WalkDir::new(&folder).follow_links(true).into_iter().filter_map(|e| e.ok()) {
            let p = entry.path();
            if p.is_file() && is_audio(p) {
                tracks.push(read_meta(p));
            }
            if tracks.len() >= 50_000 {
                break; // safety cap
            }
        }
        tracks.sort_by(|a, b| a.path.to_lowercase().cmp(&b.path.to_lowercase()));
        Ok(tracks)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// A path the frontend already has cached, with the mtime it was indexed at.
#[derive(Deserialize)]
pub struct KnownEntry {
    pub path: String,
    pub mtime: Option<f64>,
}

/// The result of an incremental scan: only NEW/MODIFIED files carry freshly-read tags;
/// unchanged files are returned by path so the frontend keeps its cached metadata (no re-read).
#[derive(Serialize, Default)]
pub struct ScanDiff {
    pub changed: Vec<ScannedTrack>, // new or mtime-differs → tags read now
    pub removed: Vec<String>,       // previously-known paths no longer on disk
    pub unchanged: Vec<String>,     // present and mtime matches the cache
}

/// Core incremental diff: walk every `folder`, only tag-read files that are new or whose mtime changed.
fn diff_scan(folders: &[String], known: &std::collections::HashMap<String, Option<f64>>) -> ScanDiff {
    let mut diff = ScanDiff::default();
    let mut seen = std::collections::HashSet::new();
    'outer: for folder in folders {
        for entry in WalkDir::new(folder).follow_links(true).into_iter().filter_map(|e| e.ok()) {
            let p = entry.path();
            if !(p.is_file() && is_audio(p)) {
                continue;
            }
            let path = p.to_string_lossy().to_string();
            if !seen.insert(path.clone()) {
                continue; // overlapping folders → don't double-count
            }
            let m = mtime_of(p);
            match known.get(&path) {
                Some(km) if m.is_some() && *km == m => diff.unchanged.push(path),
                _ => diff.changed.push(read_meta(p)),
            }
            if diff.changed.len() + diff.unchanged.len() >= 500_000 {
                break 'outer;
            }
        }
    }
    for k in known.keys() {
        if !seen.contains(k) {
            diff.removed.push(k.clone());
        }
    }
    diff
}

/// Incremental library scan over one or more music folders. Pass the paths+mtimes you already have
/// cached; only changed files get a tag read, so re-scans stay fast. Detects adds & removals.
#[tauri::command]
pub async fn scan_library_diff(folders: Vec<String>, known: Vec<KnownEntry>) -> Result<ScanDiff, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let map: std::collections::HashMap<String, Option<f64>> =
            known.into_iter().map(|k| (k.path, k.mtime)).collect();
        Ok(diff_scan(&folders, &map))
    })
    .await
    .map_err(|e| e.to_string())?
}

// ── streaming scan (#138): progress + batches as we walk, so a huge (e.g. 1TB) library
//    fills the UI progressively and the user sees live file/folder counts. ────────────────
#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ScanEvent {
    /// Periodic heartbeat: how many audio files + folders we've walked so far.
    Progress { files: usize, folders: usize },
    /// A chunk of results — new/changed tracks (tags read) + unchanged paths (kept from cache).
    Batch { changed: Vec<ScannedTrack>, unchanged: Vec<String> },
    /// Terminal event: paths no longer on disk + final totals.
    Done { removed: Vec<String>, files: usize, folders: usize },
}

/// Walk `folders`, emitting [`ScanEvent`]s through `emit`. Generic over the sink so it's unit-testable
/// without a Tauri runtime. Only new/mtime-changed files are tag-read; unchanged come back by path.
fn diff_scan_stream<F: FnMut(ScanEvent)>(folders: &[String], known: &HashMap<String, Option<f64>>, mut emit: F) {
    let mut seen: HashSet<String> = HashSet::new();
    let (mut files, mut folders_n, mut since_progress) = (0usize, 0usize, 0usize);
    let mut changed: Vec<ScannedTrack> = Vec::new();
    let mut unchanged: Vec<String> = Vec::new();
    'outer: for folder in folders {
        for entry in WalkDir::new(folder).follow_links(true).into_iter().filter_map(|e| e.ok()) {
            if entry.file_type().is_dir() {
                folders_n += 1;
                continue;
            }
            let p = entry.path();
            if !(p.is_file() && is_audio(p)) {
                continue;
            }
            let path = p.to_string_lossy().to_string();
            if !seen.insert(path.clone()) {
                continue; // overlapping folders → don't double-count
            }
            files += 1;
            since_progress += 1;
            let m = mtime_of(p);
            match known.get(&path) {
                Some(km) if m.is_some() && *km == m => unchanged.push(path),
                _ => changed.push(read_meta(p)),
            }
            // flush a batch once it's worth a render (changed are heavy; unchanged are cheap strings)
            if changed.len() >= 200 || unchanged.len() >= 4000 {
                emit(ScanEvent::Batch { changed: std::mem::take(&mut changed), unchanged: std::mem::take(&mut unchanged) });
            }
            if since_progress >= 250 {
                since_progress = 0;
                emit(ScanEvent::Progress { files, folders: folders_n });
            }
            if files >= 1_000_000 {
                break 'outer; // sanity ceiling
            }
        }
    }
    if !changed.is_empty() || !unchanged.is_empty() {
        emit(ScanEvent::Batch { changed: std::mem::take(&mut changed), unchanged: std::mem::take(&mut unchanged) });
    }
    let removed: Vec<String> = known.keys().filter(|k| !seen.contains(*k)).cloned().collect();
    emit(ScanEvent::Done { removed, files, folders: folders_n });
}

/// Streaming incremental scan: results arrive as [`ScanEvent`]s on `on_event` while the walk runs,
/// so the library fills progressively and the UI shows live file/folder counts. Use for big libraries.
#[tauri::command]
pub async fn scan_library_stream(folders: Vec<String>, known: Vec<KnownEntry>, on_event: Channel<ScanEvent>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let map: HashMap<String, Option<f64>> = known.into_iter().map(|k| (k.path, k.mtime)).collect();
        diff_scan_stream(&folders, &map, |e| { let _ = on_event.send(e); });
    })
    .await
    .map_err(|e| e.to_string())
}

/// Editable tag fields sent from the tag editor.
#[derive(Deserialize)]
pub struct TagEdit {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub album_artist: Option<String>,
    pub genre: Option<String>,
    pub year: Option<u32>,
    pub track_no: Option<u32>,
}

/// Write metadata back to an audio file (desktop). Creates a primary tag if the file has none.
#[tauri::command]
pub async fn write_tags(path: String, edit: TagEdit) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || write_tags_sync(Path::new(&path), &edit))
        .await
        .map_err(|e| e.to_string())?
}

fn write_tags_sync(path: &Path, edit: &TagEdit) -> Result<(), String> {
    use lofty::config::WriteOptions;
    use lofty::tag::{Tag, TagExt};
    let mut tagged = lofty::read_from_path(path).map_err(|e| e.to_string())?;
    if tagged.primary_tag().is_none() {
        let tt = tagged.primary_tag_type();
        tagged.insert_tag(Tag::new(tt));
    }
    let tag = tagged.primary_tag_mut().ok_or("no writable tag")?;
    let set = |tag: &mut Tag, key: ItemKey, v: &Option<String>| {
        match v {
            Some(s) if !s.is_empty() => { tag.insert_text(key, s.clone()); }
            Some(_) => { tag.remove_key(&key); }
            None => {}
        }
    };
    set(tag, ItemKey::TrackTitle, &edit.title);
    set(tag, ItemKey::TrackArtist, &edit.artist);
    set(tag, ItemKey::AlbumTitle, &edit.album);
    set(tag, ItemKey::AlbumArtist, &edit.album_artist);
    set(tag, ItemKey::Genre, &edit.genre);
    if let Some(y) = edit.year { tag.set_year(y); }
    if let Some(t) = edit.track_no { tag.set_track(t); }
    tag.save_to_path(path, WriteOptions::default()).map_err(|e| e.to_string())
}

/// Lowercase hex MD5 (for Subsonic token auth: md5(password + salt)).
#[tauri::command]
pub fn md5_hex(input: String) -> String {
    format!("{:x}", md5::compute(input.as_bytes()))
}

/// Proxy HTTP GET that returns the body bytes + content-type — runs in Rust so it's NOT subject to the
/// WebView's CORS rules (album-art CDNs / metadata APIs often don't send CORS headers). 20 MB cap.
#[tauri::command]
pub async fn http_get_bytes(url: String) -> Result<(Vec<u8>, String), String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<(Vec<u8>, String), String> {
        use std::io::Read;
        let resp = ureq::get(&url)
            .set("User-Agent", "WovePlay/0.1 (+https://wove.app)")
            .call()
            .map_err(|e| e.to_string())?;
        let mime = resp.header("Content-Type").unwrap_or("application/octet-stream").to_string();
        let mut buf: Vec<u8> = Vec::new();
        resp.into_reader().take(20 * 1024 * 1024).read_to_end(&mut buf).map_err(|e| e.to_string())?;
        Ok((buf, mime))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Embed cover art into an audio file's primary tag (replaces any existing front-cover pictures), so the
/// chosen cover persists + is visible to every app. `data` is the raw image bytes.
#[tauri::command]
pub async fn set_cover(path: String, data: Vec<u8>, mime: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        use lofty::config::WriteOptions;
        use lofty::picture::{MimeType, Picture, PictureType};
        use lofty::tag::{Tag, TagExt};
        let p = Path::new(&path);
        let mut tagged = lofty::read_from_path(p).map_err(|e| e.to_string())?;
        if tagged.primary_tag().is_none() {
            let tt = tagged.primary_tag_type();
            tagged.insert_tag(Tag::new(tt));
        }
        let tag = tagged.primary_tag_mut().ok_or("no writable tag")?;
        let mt = match mime.as_str() {
            "image/png" => MimeType::Png,
            _ => MimeType::Jpeg,
        };
        let pic = Picture::new_unchecked(PictureType::CoverFront, Some(mt), None, data);
        // drop existing pictures, then set ours
        while tag.pictures().first().is_some() {
            tag.remove_picture(0);
        }
        tag.push_picture(pic);
        tag.save_to_path(p, WriteOptions::default()).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Read tags for a set of individually-picked files (e.g. from the system file picker).
/// Best-effort: files whose tags can't be read (or content URIs the tag reader can't open,
/// as on Android SAF) come back with empty metadata so the UI can fall back to the filename.
#[tauri::command]
pub async fn tracks_meta(paths: Vec<String>) -> Result<Vec<ScannedTrack>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        Ok(paths.iter().map(|p| read_meta(Path::new(p))).collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Embedded cover art for one file, decoded + resized to a ~256px JPEG thumbnail (data URL).
/// Returns None if the file has no embedded picture. Lazy — called per visible album/track.
/// Encode a decoded image as a 256px JPEG thumbnail (longest edge), preserving aspect ratio.
fn thumb_jpeg(img: image::DynamicImage) -> Option<Vec<u8>> {
    let thumb = img.thumbnail(256, 256);
    let mut buf = Vec::new();
    thumb.write_to(&mut std::io::Cursor::new(&mut buf), image::ImageFormat::Jpeg).ok()?;
    Some(buf)
}
/// Wrap JPEG bytes as a data: URL the WebView can put in an `<img src>`.
fn jpeg_data_url(buf: &[u8]) -> String {
    use base64::Engine;
    format!("data:image/jpeg;base64,{}", base64::engine::general_purpose::STANDARD.encode(buf))
}
/// Disk thumbnail cache file: `app_cache_dir/covers/<hash(path+mtime)>.jpg`. Keyed by mtime so a
/// re-tagged file refreshes; an EMPTY cache file = a cached "no art" result (so an art-less file is
/// never re-decoded every launch).
fn cover_cache_file(app: &tauri::AppHandle, path: &str) -> Option<std::path::PathBuf> {
    use std::hash::{Hash, Hasher};
    let dir = app.path().app_cache_dir().ok()?.join("covers");
    let _ = std::fs::create_dir_all(&dir);
    let mtime = std::fs::metadata(path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let mut h = std::collections::hash_map::DefaultHasher::new();
    path.hash(&mut h);
    mtime.hash(&mut h);
    Some(dir.join(format!("{:016x}.jpg", h.finish())))
}

/// Extract a 256px JPEG thumbnail: embedded picture → sidecar image → None.
fn extract_cover(path: &str) -> Option<Vec<u8>> {
    if let Ok(tagged) = lofty::read_from_path(path) {
        if let Some(tag) = tagged.primary_tag().or_else(|| tagged.first_tag()) {
            if let Some(pic) = tag.pictures().first() {
                if let Ok(img) = image::load_from_memory(pic.data()) {
                    if let Some(b) = thumb_jpeg(img) {
                        return Some(b);
                    }
                }
            }
        }
    }
    if let Some(side) = sidecar_cover(Path::new(path)) {
        if let Ok(img) = image::open(&side) {
            if let Some(b) = thumb_jpeg(img) {
                return Some(b);
            }
        }
    }
    None
}

/// Find a sidecar cover image next to a track (cover.jpg / folder.jpg / front.* / *.png, etc.) —
/// the common case for libraries that DON'T embed art in the audio files.
fn sidecar_cover(track: &Path) -> Option<std::path::PathBuf> {
    let dir = track.parent()?;
    const NAMES: [&str; 8] = ["cover", "folder", "front", "album", "albumart", "albumartsmall", "thumb", "artwork"];
    const EXTS: [&str; 4] = ["jpg", "jpeg", "png", "webp"];
    // 1) preferred well-known names
    for n in NAMES {
        for e in EXTS {
            let p = dir.join(format!("{n}.{e}"));
            if p.is_file() { return Some(p); }
            let p = dir.join(format!("{}.{e}", n.to_uppercase()));
            if p.is_file() { return Some(p); }
        }
    }
    // 2) otherwise the first image file in the folder
    if let Ok(rd) = std::fs::read_dir(dir) {
        for entry in rd.flatten() {
            let p = entry.path();
            if let Some(ext) = p.extension().and_then(|e| e.to_str()) {
                if EXTS.contains(&ext.to_ascii_lowercase().as_str()) { return Some(p); }
            }
        }
    }
    None
}

#[tauri::command]
pub async fn cover_art(app: tauri::AppHandle, path: String) -> Result<Option<String>, String> {
    let cache = cover_cache_file(&app, &path);
    tauri::async_runtime::spawn_blocking(move || {
        // cache hit — read the pre-made thumbnail instead of decoding the audio file again
        // (empty file = a cached "no art" result).
        if let Some(ref cp) = cache {
            if let Ok(bytes) = std::fs::read(cp) {
                return Ok(if bytes.is_empty() { None } else { Some(jpeg_data_url(&bytes)) });
            }
        }
        // miss → extract, then persist (or persist an empty negative marker)
        let jpeg = extract_cover(&path);
        if let Some(ref cp) = cache {
            let _ = std::fs::write(cp, jpeg.as_deref().unwrap_or(&[]));
        }
        Ok(jpeg.map(|b| jpeg_data_url(&b)))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Wipe the on-disk cover-thumbnail cache (called on library Rebuild / Delete index).
#[tauri::command]
pub fn cover_cache_clear(app: tauri::AppHandle) -> Result<(), String> {
    if let Ok(dir) = app.path().app_cache_dir() {
        let _ = std::fs::remove_dir_all(dir.join("covers"));
    }
    Ok(())
}

/// Read a sidecar lyrics file next to the track (`song.lrc` → `song.txt`). Returns None if absent.
/// `.lrc` carries `[mm:ss.xx]` timestamps for synced/scrolling lyrics; `.txt` is plain.
#[tauri::command]
pub async fn read_lyrics(path: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = Path::new(&path);
        for ext in ["lrc", "txt"] {
            let cand = p.with_extension(ext);
            if cand.is_file() {
                if let Ok(s) = std::fs::read_to_string(&cand) {
                    if !s.trim().is_empty() {
                        return Ok(Some(s));
                    }
                }
            }
        }
        Ok(None)
    })
    .await
    .map_err(|e| e.to_string())?
}

// ── library cache (persisted to app-data so re-launches are instant) ──────────────
// Stored as JSONL: line 0 = {"folder","total"} meta, then ONE track per line. This lets a 40k-song
// cache be STREAMED to the UI in batches (first screen paints before the whole file is parsed) and read
// without holding a giant JSON string in memory.
#[derive(Serialize, Deserialize)]
pub struct CachedLibrary {
    pub folder: String,
    pub tracks: Vec<ScannedTrack>,
}
#[derive(Serialize, Deserialize)]
struct CacheMeta {
    folder: String,
    #[serde(default)]
    total: u32,
}

fn cache_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("library.jsonl"))
}

#[tauri::command]
pub fn library_cache_save(app: tauri::AppHandle, folder: String, tracks: Vec<ScannedTrack>) -> Result<(), String> {
    use std::io::Write;
    let path = cache_path(&app)?;
    let f = std::fs::File::create(&path).map_err(|e| e.to_string())?;
    let mut w = std::io::BufWriter::new(f);
    let meta = serde_json::to_string(&CacheMeta { folder, total: tracks.len() as u32 }).map_err(|e| e.to_string())?;
    writeln!(w, "{meta}").map_err(|e| e.to_string())?;
    for t in &tracks {
        let line = serde_json::to_string(t).map_err(|e| e.to_string())?;
        writeln!(w, "{line}").map_err(|e| e.to_string())?;
    }
    w.flush().map_err(|e| e.to_string())?;
    // Mirror into the SQLite index so it stays in sync with the JSONL cache (best-effort: a DB hiccup
    // must never break the canonical cache save). [perf P2.9]
    if let Some(db) = app.try_state::<crate::libdb::LibDb>() {
        let _ = db.replace(&tracks);
    }
    Ok(())
}

#[tauri::command]
pub fn library_cache_load(app: tauri::AppHandle) -> Result<Option<CachedLibrary>, String> {
    use std::io::BufRead;
    let path = cache_path(&app)?;
    let file = match std::fs::File::open(&path) { Ok(f) => f, Err(_) => return Ok(None) };
    let mut lines = std::io::BufReader::new(file).lines();
    let folder = match lines.next() {
        Some(Ok(l)) => serde_json::from_str::<CacheMeta>(&l).map(|m| m.folder).unwrap_or_default(),
        _ => return Ok(None),
    };
    let mut tracks = Vec::new();
    for line in lines.map_while(Result::ok) {
        if let Ok(t) = serde_json::from_str::<ScannedTrack>(&line) { tracks.push(t); }
    }
    Ok(Some(CachedLibrary { folder, tracks }))
}

/// Stream the cached library to the UI in batches (channel events: {kind:"meta",folder} →
/// {kind:"batch",tracks:[…]}* → {kind:"done"}). Reads the JSONL once; the first batch lets the list paint.
#[tauri::command]
pub fn library_cache_stream(app: tauri::AppHandle, on_event: tauri::ipc::Channel<serde_json::Value>) -> Result<(), String> {
    use std::io::BufRead;
    let path = cache_path(&app)?;
    let file = match std::fs::File::open(&path) {
        Ok(f) => f,
        Err(_) => { let _ = on_event.send(serde_json::json!({"kind":"done"})); return Ok(()); }
    };
    let mut lines = std::io::BufReader::new(file).lines();
    let folder = match lines.next() {
        Some(Ok(l)) => serde_json::from_str::<CacheMeta>(&l).map(|m| m.folder).unwrap_or_default(),
        _ => { let _ = on_event.send(serde_json::json!({"kind":"done"})); return Ok(()); }
    };
    let _ = on_event.send(serde_json::json!({"kind":"meta","folder":folder}));
    let mut batch: Vec<serde_json::Value> = Vec::with_capacity(2000);
    for line in lines.map_while(Result::ok) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
            batch.push(v);
            if batch.len() >= 2000 {
                let _ = on_event.send(serde_json::json!({"kind":"batch","tracks":std::mem::take(&mut batch)}));
            }
        }
    }
    if !batch.is_empty() { let _ = on_event.send(serde_json::json!({"kind":"batch","tracks":batch})); }
    let _ = on_event.send(serde_json::json!({"kind":"done"}));
    Ok(())
}

/// Write arbitrary bytes to a path (visualizer export → native save dialog target).
#[tauri::command]
pub fn save_file(path: String, bytes: Vec<u8>) -> Result<(), String> {
    std::fs::write(path, bytes).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::io::Write;

    fn touch(dir: &std::path::Path, name: &str) -> String {
        let p = dir.join(name);
        let mut f = std::fs::File::create(&p).unwrap();
        f.write_all(b"x").unwrap();
        p.to_string_lossy().to_string()
    }

    fn write_min_wav(path: &std::path::Path) {
        let sr: u32 = 8000; let n: usize = 64; let data_len = (n * 2) as u32;
        let mut f = std::fs::File::create(path).unwrap();
        f.write_all(b"RIFF").unwrap(); f.write_all(&(36 + data_len).to_le_bytes()).unwrap(); f.write_all(b"WAVE").unwrap();
        f.write_all(b"fmt ").unwrap(); f.write_all(&16u32.to_le_bytes()).unwrap();
        f.write_all(&1u16.to_le_bytes()).unwrap(); f.write_all(&1u16.to_le_bytes()).unwrap();
        f.write_all(&sr.to_le_bytes()).unwrap(); f.write_all(&(sr * 2).to_le_bytes()).unwrap();
        f.write_all(&2u16.to_le_bytes()).unwrap(); f.write_all(&16u16.to_le_bytes()).unwrap();
        f.write_all(b"data").unwrap(); f.write_all(&data_len.to_le_bytes()).unwrap();
        for _ in 0..n { f.write_all(&0i16.to_le_bytes()).unwrap(); }
    }

    #[test]
    fn write_tags_round_trips() {
        let dir = std::env::temp_dir().join(format!("wavrplay_tags_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("song.wav");
        write_min_wav(&p);
        let edit = TagEdit {
            title: Some("Night Drive".into()), artist: Some("WAVR".into()), album: Some("Demo".into()),
            album_artist: None, genre: Some("Electronic".into()), year: Some(2026), track_no: Some(3),
        };
        write_tags_sync(&p, &edit).expect("write");
        let meta = read_meta(&p);
        assert_eq!(meta.title.as_deref(), Some("Night Drive"));
        assert_eq!(meta.artist.as_deref(), Some("WAVR"));
        assert_eq!(meta.album.as_deref(), Some("Demo"));
        assert_eq!(meta.genre.as_deref(), Some("Electronic"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn incremental_diff_detects_add_remove_unchanged() {
        let dir = std::env::temp_dir().join(format!("wavrplay_idx_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let _a = touch(&dir, "a.mp3");
        let b = touch(&dir, "b.flac");
        touch(&dir, "notes.txt"); // non-audio → ignored

        // first scan: empty cache → both audio files are "changed", txt ignored
        let d1 = diff_scan(&[dir.to_string_lossy().to_string()], &HashMap::new());
        assert_eq!(d1.changed.len(), 2, "first scan reads all audio files");
        assert_eq!(d1.unchanged.len(), 0);

        // build a cache from the first scan
        let known: HashMap<String, Option<f64>> =
            d1.changed.iter().map(|t| (t.path.clone(), t.mtime)).collect();

        // second scan, nothing touched: everything unchanged, NOTHING re-read
        let d2 = diff_scan(&[dir.to_string_lossy().to_string()], &known);
        assert_eq!(d2.unchanged.len(), 2, "unchanged files are not re-read");
        assert_eq!(d2.changed.len(), 0);
        assert_eq!(d2.removed.len(), 0);

        // remove b, add c → diff reports exactly that
        std::fs::remove_file(&b).unwrap();
        let _c = touch(&dir, "c.ogg");
        let d3 = diff_scan(&[dir.to_string_lossy().to_string()], &known);
        assert_eq!(d3.removed, vec![b.clone()], "removed file detected");
        assert_eq!(d3.unchanged.len(), 1, "untouched file still cached (a.mp3)");
        assert!(d3.changed.iter().any(|t| t.path.ends_with("c.ogg")), "new file detected");
        assert_eq!(d3.changed.len(), 1, "only the new file is read");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn streaming_scan_emits_batches_and_done() {
        let dir = std::env::temp_dir().join(format!("wavrplay_stream_{}", std::process::id()));
        let sub = dir.join("disco");
        std::fs::create_dir_all(&sub).unwrap();
        touch(&dir, "a.mp3");
        touch(&dir, "b.flac");
        touch(&sub, "c.ogg");
        touch(&dir, "cover.jpg"); // non-audio → ignored

        let mut events = Vec::new();
        diff_scan_stream(&[dir.to_string_lossy().to_string()], &HashMap::new(), |e| events.push(e));

        // collect changed paths across all Batch events; find the terminal Done
        let mut changed = 0usize;
        let mut done: Option<(usize, usize, usize)> = None; // (removed, files, folders)
        for e in &events {
            match e {
                ScanEvent::Batch { changed: c, .. } => changed += c.len(),
                ScanEvent::Done { removed, files, folders } => done = Some((removed.len(), *files, *folders)),
                ScanEvent::Progress { .. } => {}
            }
        }
        assert_eq!(changed, 3, "all three audio files streamed as changed");
        let (removed, files, folders) = done.expect("a Done event is always emitted");
        assert_eq!(removed, 0, "nothing removed on a fresh scan");
        assert_eq!(files, 3, "Done reports the audio file total");
        assert!(folders >= 1, "at least the subfolder is counted ({folders})");

        std::fs::remove_dir_all(&dir).ok();
    }
}
