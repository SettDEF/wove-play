//! SQLite-backed library index — PERF_PLAN P2.9 (phase 1: storage + query engine).
//!
//! The library metadata is mirrored into a SQLite DB so a huge collection (80k+) can be browsed by
//! PAGE — sorted, filtered and searched in native code — instead of materialising the whole array in
//! the WebView's JS heap. This phase builds + keeps the DB in sync (it's written wherever the JSONL
//! cache is saved) and exposes the query commands. The UI still reads the in-memory array until
//! phase 2 flips each view (Songs / Albums / Artists / Search) to consume pages from here.

use crate::commands::ScannedTrack;
use rusqlite::{params, params_from_iter, types::Value, Connection, Row};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::State;

/// Managed state: one pooled connection guarded by a mutex (writes are bulk + infrequent; reads are
/// fast native queries, so a single connection is plenty and avoids pool complexity).
pub struct LibDb {
    conn: Mutex<Connection>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Filter {
    pub search: Option<String>,
    pub genre: Option<String>,
    pub decade: Option<i64>,
    pub folder: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageReq {
    pub offset: i64,
    pub limit: i64,
    #[serde(default)]
    pub sort: String,
    #[serde(default)]
    pub dir: String,
    #[serde(default)]
    pub filter: Filter,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlbumRow {
    pub album: String,
    pub artist: String,
    pub count: i64,
    pub cover: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtistRow {
    pub artist: String,
    pub count: i64,
    pub cover: String,
}

impl LibDb {
    pub fn open(path: std::path::PathBuf) -> Self {
        let conn = Connection::open(path).unwrap_or_else(|_| Connection::open_in_memory().unwrap());
        Self::init(&conn);
        LibDb { conn: Mutex::new(conn) }
    }

    fn init(conn: &Connection) {
        let _ = conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA synchronous=NORMAL;
             CREATE TABLE IF NOT EXISTS tracks (
               path TEXT PRIMARY KEY, title TEXT, artist TEXT, album TEXT, album_artist TEXT,
               genre TEXT, year INTEGER, track_no INTEGER, disc_no INTEGER, duration REAL,
               mtime REAL, folder TEXT, search TEXT
             );
             CREATE INDEX IF NOT EXISTS idx_tracks_title  ON tracks(title  COLLATE NOCASE);
             CREATE INDEX IF NOT EXISTS idx_tracks_artist ON tracks(artist COLLATE NOCASE);
             CREATE INDEX IF NOT EXISTS idx_tracks_album  ON tracks(album  COLLATE NOCASE);
             CREATE INDEX IF NOT EXISTS idx_tracks_year   ON tracks(year);
             CREATE INDEX IF NOT EXISTS idx_tracks_genre  ON tracks(genre  COLLATE NOCASE);
             CREATE INDEX IF NOT EXISTS idx_tracks_folder ON tracks(folder);",
        );
    }

    fn search_key(t: &ScannedTrack) -> String {
        format!(
            "{} {} {}",
            t.title.as_deref().unwrap_or(""),
            t.artist.as_deref().unwrap_or(""),
            t.album.as_deref().unwrap_or("")
        )
        .to_lowercase()
    }

    fn insert_one(stmt: &mut rusqlite::Statement, t: &ScannedTrack) -> rusqlite::Result<()> {
        stmt.execute(params![
            t.path,
            t.title,
            t.artist,
            t.album,
            t.album_artist,
            t.genre,
            t.year,
            t.track_no,
            t.disc_no,
            t.duration,
            t.mtime,
            t.folder,
            Self::search_key(t),
        ])?;
        Ok(())
    }

    const INSERT_SQL: &'static str = "INSERT OR REPLACE INTO tracks \
        (path,title,artist,album,album_artist,genre,year,track_no,disc_no,duration,mtime,folder,search) \
        VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)";

    /// Wholesale replace the index with `tracks` (one transaction). Returns the row count.
    pub fn replace(&self, tracks: &[ScannedTrack]) -> rusqlite::Result<u32> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        tx.execute("DELETE FROM tracks", [])?;
        {
            let mut stmt = tx.prepare(Self::INSERT_SQL)?;
            for t in tracks {
                Self::insert_one(&mut stmt, t)?;
            }
        }
        tx.commit()?;
        Ok(tracks.len() as u32)
    }

    /// Insert-or-update a batch (used for incremental tag enrichment) without touching other rows.
    pub fn upsert(&self, tracks: &[ScannedTrack]) -> rusqlite::Result<()> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        {
            let mut stmt = tx.prepare(Self::INSERT_SQL)?;
            for t in tracks {
                Self::insert_one(&mut stmt, t)?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    pub fn clear(&self) -> rusqlite::Result<()> {
        self.conn.lock().unwrap().execute("DELETE FROM tracks", [])?;
        Ok(())
    }

    pub fn count(&self, f: &Filter) -> rusqlite::Result<i64> {
        let (w, p) = where_clause(f);
        let conn = self.conn.lock().unwrap();
        let sql = format!("SELECT COUNT(*) FROM tracks{w}");
        conn.query_row(&sql, params_from_iter(p.iter()), |r| r.get(0))
    }

    pub fn page(&self, req: &PageReq) -> rusqlite::Result<Vec<ScannedTrack>> {
        let (w, mut p) = where_clause(&req.filter);
        let order = order_sql(&req.sort, &req.dir);
        let sql = format!(
            "SELECT path,title,artist,album,album_artist,genre,year,track_no,disc_no,duration,mtime,folder \
             FROM tracks{w}{order} LIMIT ? OFFSET ?"
        );
        p.push(Value::Integer(req.limit.max(0)));
        p.push(Value::Integer(req.offset.max(0)));
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params_from_iter(p.iter()), row_to_track)?;
        rows.collect()
    }

    /// Distinct albums (grouped by album-artist + album) with a track count and a cover candidate.
    pub fn albums(&self, f: &Filter) -> rusqlite::Result<Vec<AlbumRow>> {
        let (w, p) = where_clause(f);
        let sql = format!(
            "SELECT album, COALESCE(NULLIF(album_artist,''), artist) AS aa, COUNT(*) c, MIN(path) cover \
             FROM tracks{w} GROUP BY aa, album ORDER BY album COLLATE NOCASE ASC"
        );
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params_from_iter(p.iter()), |r| {
            Ok(AlbumRow {
                album: r.get::<_, Option<String>>(0)?.unwrap_or_default(),
                artist: r.get::<_, Option<String>>(1)?.unwrap_or_default(),
                count: r.get(2)?,
                cover: r.get::<_, Option<String>>(3)?.unwrap_or_default(),
            })
        })?;
        rows.collect()
    }

    /// Distinct artists (album-artist preferred) with a track count and a cover candidate.
    pub fn artists(&self, f: &Filter) -> rusqlite::Result<Vec<ArtistRow>> {
        let (w, p) = where_clause(f);
        let sql = format!(
            "SELECT COALESCE(NULLIF(album_artist,''), artist) AS aa, COUNT(*) c, MIN(path) cover \
             FROM tracks{w} GROUP BY aa ORDER BY aa COLLATE NOCASE ASC"
        );
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params_from_iter(p.iter()), |r| {
            Ok(ArtistRow {
                artist: r.get::<_, Option<String>>(0)?.unwrap_or_default(),
                count: r.get(1)?,
                cover: r.get::<_, Option<String>>(2)?.unwrap_or_default(),
            })
        })?;
        rows.collect()
    }
}

/// Build a parameterised WHERE clause from a filter (empty string if no conditions).
fn where_clause(f: &Filter) -> (String, Vec<Value>) {
    let mut cond: Vec<&'static str> = Vec::new();
    let mut p: Vec<Value> = Vec::new();
    if let Some(s) = f.search.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
        cond.push("search LIKE ?");
        p.push(Value::Text(format!("%{}%", s.to_lowercase())));
    }
    if let Some(g) = &f.genre {
        cond.push("genre = ?");
        p.push(Value::Text(g.clone()));
    }
    if let Some(d) = f.decade {
        cond.push("(year >= ? AND year < ?)");
        p.push(Value::Integer(d));
        p.push(Value::Integer(d + 10));
    }
    if let Some(fo) = &f.folder {
        cond.push("folder = ?");
        p.push(Value::Text(fo.clone()));
    }
    if let Some(ar) = &f.artist {
        cond.push("(album_artist = ? OR artist = ?)");
        p.push(Value::Text(ar.clone()));
        p.push(Value::Text(ar.clone()));
    }
    if let Some(al) = &f.album {
        cond.push("album = ?");
        p.push(Value::Text(al.clone()));
    }
    let sql = if cond.is_empty() { String::new() } else { format!(" WHERE {}", cond.join(" AND ")) };
    (sql, p)
}

/// Whitelisted ORDER BY (never interpolate user input) with a stable tiebreaker.
fn order_sql(sort: &str, dir: &str) -> String {
    let col = match sort {
        "artist" => "artist COLLATE NOCASE",
        "album" => "album COLLATE NOCASE",
        "year" => "year",
        "duration" => "duration",
        "track" => "disc_no, track_no",
        "added" => "rowid",
        _ => "title COLLATE NOCASE",
    };
    let d = if dir.eq_ignore_ascii_case("desc") { "DESC" } else { "ASC" };
    format!(" ORDER BY {col} {d}, title COLLATE NOCASE ASC, path ASC")
}

fn row_to_track(r: &Row) -> rusqlite::Result<ScannedTrack> {
    Ok(ScannedTrack {
        path: r.get(0)?,
        title: r.get(1)?,
        artist: r.get(2)?,
        album: r.get(3)?,
        album_artist: r.get(4)?,
        genre: r.get(5)?,
        year: r.get(6)?,
        track_no: r.get(7)?,
        disc_no: r.get(8)?,
        duration: r.get(9)?,
        mtime: r.get(10)?,
        folder: r.get(11)?,
    })
}

// ── Tauri commands ───────────────────────────────────────────────────────────
#[tauri::command]
pub fn libdb_replace(state: State<LibDb>, tracks: Vec<ScannedTrack>) -> Result<u32, String> {
    state.replace(&tracks).map_err(|e| e.to_string())
}
#[tauri::command]
pub fn libdb_upsert(state: State<LibDb>, tracks: Vec<ScannedTrack>) -> Result<(), String> {
    state.upsert(&tracks).map_err(|e| e.to_string())
}
#[tauri::command]
pub fn libdb_clear(state: State<LibDb>) -> Result<(), String> {
    state.clear().map_err(|e| e.to_string())
}
#[tauri::command]
pub fn libdb_count(state: State<LibDb>, filter: Filter) -> Result<i64, String> {
    state.count(&filter).map_err(|e| e.to_string())
}
#[tauri::command]
pub fn libdb_page(state: State<LibDb>, req: PageReq) -> Result<Vec<ScannedTrack>, String> {
    state.page(&req).map_err(|e| e.to_string())
}
#[tauri::command]
pub fn libdb_albums(state: State<LibDb>, filter: Filter) -> Result<Vec<AlbumRow>, String> {
    state.albums(&filter).map_err(|e| e.to_string())
}
#[tauri::command]
pub fn libdb_artists(state: State<LibDb>, filter: Filter) -> Result<Vec<ArtistRow>, String> {
    state.artists(&filter).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(path: &str, title: &str, artist: &str, album: &str, year: Option<u32>) -> ScannedTrack {
        ScannedTrack {
            path: path.into(),
            title: Some(title.into()),
            artist: Some(artist.into()),
            album: Some(album.into()),
            album_artist: Some(artist.into()),
            genre: Some("Rock".into()),
            year,
            track_no: Some(1),
            disc_no: Some(1),
            duration: Some(180.0),
            mtime: Some(0.0),
            folder: Some("/music".into()),
        }
    }

    fn db() -> LibDb {
        let conn = Connection::open_in_memory().unwrap();
        LibDb::init(&conn);
        LibDb { conn: Mutex::new(conn) }
    }

    #[test]
    fn replace_count_page_sort() {
        let d = db();
        d.replace(&[
            t("/a.mp3", "Bravo", "Zeta", "Album X", Some(1999)),
            t("/b.mp3", "Alpha", "Yankee", "Album Y", Some(2005)),
            t("/c.mp3", "Charlie", "Xray", "Album X", Some(2011)),
        ])
        .unwrap();
        assert_eq!(d.count(&Filter::default()).unwrap(), 3);
        // default sort = title ascending
        let page = d.page(&PageReq { offset: 0, limit: 10, sort: "title".into(), dir: "asc".into(), filter: Filter::default() }).unwrap();
        let titles: Vec<_> = page.iter().map(|x| x.title.clone().unwrap()).collect();
        assert_eq!(titles, vec!["Alpha", "Bravo", "Charlie"]);
        // paging
        let p2 = d.page(&PageReq { offset: 1, limit: 1, sort: "title".into(), dir: "asc".into(), filter: Filter::default() }).unwrap();
        assert_eq!(p2.len(), 1);
        assert_eq!(p2[0].title.as_deref(), Some("Bravo"));
    }

    #[test]
    fn search_and_filters() {
        let d = db();
        d.replace(&[
            t("/a.mp3", "Sunrise", "Adele", "21", Some(2011)),
            t("/b.mp3", "Sunset", "Adele", "25", Some(2015)),
            t("/c.mp3", "Moon", "Beck", "Odelay", Some(1996)),
        ])
        .unwrap();
        // substring search over title/artist/album
        let f = Filter { search: Some("sun".into()), ..Default::default() };
        assert_eq!(d.count(&f).unwrap(), 2);
        // decade filter (2010s = 2011 + 2015; 1990s = 1996)
        let f = Filter { decade: Some(2010), ..Default::default() };
        assert_eq!(d.count(&f).unwrap(), 2);
        let f = Filter { decade: Some(1990), ..Default::default() };
        assert_eq!(d.count(&f).unwrap(), 1);
        // artist filter
        let f = Filter { artist: Some("Adele".into()), ..Default::default() };
        assert_eq!(d.count(&f).unwrap(), 2);
    }

    #[test]
    fn album_and_artist_aggregation() {
        let d = db();
        d.replace(&[
            t("/a.mp3", "One", "Adele", "21", Some(2011)),
            t("/b.mp3", "Two", "Adele", "21", Some(2011)),
            t("/c.mp3", "Three", "Beck", "Odelay", Some(1996)),
        ])
        .unwrap();
        let albums = d.albums(&Filter::default()).unwrap();
        assert_eq!(albums.len(), 2);
        let twentyone = albums.iter().find(|a| a.album == "21").unwrap();
        assert_eq!(twentyone.count, 2);
        let artists = d.artists(&Filter::default()).unwrap();
        assert_eq!(artists.len(), 2);
    }

    #[test]
    fn upsert_updates_in_place() {
        let d = db();
        d.replace(&[t("/a.mp3", "Old", "Unknown artist", "Folder", None)]).unwrap();
        d.upsert(&[t("/a.mp3", "New", "Real Artist", "Real Album", Some(2020))]).unwrap();
        assert_eq!(d.count(&Filter::default()).unwrap(), 1); // replaced, not duplicated
        let page = d.page(&PageReq { offset: 0, limit: 1, sort: "title".into(), dir: "asc".into(), filter: Filter::default() }).unwrap();
        assert_eq!(page[0].artist.as_deref(), Some("Real Artist"));
    }
}
