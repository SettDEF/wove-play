//! Local HTTP media-streaming server (the shared foundation for streamed playback, Chromecast and
//! LAN library sharing). Serves registered files over HTTP with **Range** support so `<audio>` (or a
//! cast device / another Wove device) can stream + seek instead of loading the whole file first.
//!
//! Bound to a chosen interface: `127.0.0.1` for in-app/loopback use, or `0.0.0.0` so devices on the
//! same Wi-Fi (Chromecast / another phone) can reach it. Tokens are a hash of the path, so the same
//! file always maps to the same URL (cacheable). Reading uses `File::take` → it streams the requested
//! byte range without buffering the whole file in memory.

use std::collections::HashMap;
use std::fs::File;
use std::hash::{Hash, Hasher};
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

type Registry = Arc<Mutex<HashMap<String, PathBuf>>>;

/// A running local media server. Dropping it stops serving (the thread ends when the `Server` drops).
pub struct StreamServer {
    port: u16,
    registry: Registry,
    _server: Arc<tiny_http::Server>,
}

impl StreamServer {
    /// Start on `host` (e.g. "127.0.0.1" loopback, or "0.0.0.0" for LAN). Picks a free port.
    pub fn start(host: &str) -> std::io::Result<StreamServer> {
        let server = Arc::new(
            tiny_http::Server::http(format!("{host}:0")).map_err(|e| std::io::Error::other(e.to_string()))?,
        );
        let port = server.server_addr().to_ip().map(|a| a.port()).unwrap_or(0);
        let registry: Registry = Arc::new(Mutex::new(HashMap::new()));
        let srv = server.clone();
        let reg = registry.clone();
        std::thread::spawn(move || {
            for req in srv.incoming_requests() {
                serve(req, &reg);
            }
        });
        Ok(StreamServer { port, registry, _server: server })
    }

    pub fn port(&self) -> u16 { self.port }

    /// Register a file and return a stable token (hash of the path).
    pub fn register(&self, path: PathBuf) -> String {
        let tok = token(&path.to_string_lossy());
        self.registry.lock().unwrap().insert(tok.clone(), path);
        tok
    }

    /// Full URL the WebView / a cast device can fetch (`http://<host>:<port>/f/<token>`).
    pub fn url(&self, host: &str, path: PathBuf) -> String {
        format!("http://{host}:{}/f/{}", self.port, self.register(path))
    }
}

/// Stable per-path token (hex of a std hash) so the same file → the same URL.
pub fn token(path: &str) -> String {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    path.hash(&mut h);
    format!("{:016x}", h.finish())
}

/// MIME type for a file extension (lowercased, no dot).
pub fn content_type(ext: &str) -> &'static str {
    match ext.to_ascii_lowercase().as_str() {
        "mp3" => "audio/mpeg",
        "flac" => "audio/flac",
        "wav" => "audio/wav",
        "ogg" | "oga" => "audio/ogg",
        "opus" => "audio/opus",
        "m4a" | "mp4" | "aac" => "audio/mp4",
        "aiff" | "aif" => "audio/aiff",
        _ => "application/octet-stream",
    }
}

/// Parse an HTTP `Range` header value against a known total size → inclusive `(start, end)`.
/// Supports `bytes=START-END`, `bytes=START-` and `bytes=-SUFFIX`. Returns `None` if unparseable or
/// out of range (caller then serves the whole file with 200).
pub fn parse_range(value: &str, total: u64) -> Option<(u64, u64)> {
    if total == 0 { return None; }
    let spec = value.trim().strip_prefix("bytes=")?;
    let (a, b) = spec.split_once('-')?;
    let (start, end) = match (a.trim(), b.trim()) {
        ("", "") => return None,
        ("", suf) => { let n: u64 = suf.parse().ok()?; (total.saturating_sub(n), total - 1) } // last N bytes
        (s, "") => (s.parse().ok()?, total - 1),
        (s, e) => (s.parse().ok()?, e.parse::<u64>().ok()?.min(total - 1)),
    };
    if start > end || start >= total { return None; }
    Some((start, end))
}

fn ext_of(path: &std::path::Path) -> String {
    path.extension().and_then(|e| e.to_str()).unwrap_or("").to_string()
}

fn serve(req: tiny_http::Request, reg: &Registry) {
    let tok = req.url().strip_prefix("/f/").unwrap_or("").to_string();
    let path = match reg.lock().unwrap().get(&tok).cloned() {
        Some(p) => p,
        None => { let _ = req.respond(tiny_http::Response::empty(404)); return; }
    };
    let mut file = match File::open(&path) {
        Ok(f) => f,
        Err(_) => { let _ = req.respond(tiny_http::Response::empty(404)); return; }
    };
    let total = file.metadata().map(|m| m.len()).unwrap_or(0);
    let ctype = content_type(&ext_of(&path));
    let range = req.headers().iter()
        .find(|h| h.field.equiv("Range"))
        .and_then(|h| parse_range(h.value.as_str(), total));

    let mk = |k: &str, v: &str| tiny_http::Header::from_bytes(k.as_bytes(), v.as_bytes()).unwrap();
    let _ = match range {
        Some((start, end)) => {
            let len = end - start + 1;
            if file.seek(SeekFrom::Start(start)).is_err() { let _ = req.respond(tiny_http::Response::empty(500)); return; }
            let headers = vec![
                mk("Content-Type", ctype),
                mk("Accept-Ranges", "bytes"),
                mk("Content-Range", &format!("bytes {start}-{end}/{total}")),
            ];
            req.respond(tiny_http::Response::new(tiny_http::StatusCode(206), headers, file.take(len), Some(len as usize), None))
        }
        None => {
            let headers = vec![mk("Content-Type", ctype), mk("Accept-Ranges", "bytes")];
            req.respond(tiny_http::Response::new(tiny_http::StatusCode(200), headers, file, Some(total as usize), None))
        }
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn range_parsing() {
        assert_eq!(parse_range("bytes=2-5", 10), Some((2, 5)));
        assert_eq!(parse_range("bytes=5-", 10), Some((5, 9)));
        assert_eq!(parse_range("bytes=-3", 10), Some((7, 9)));      // last 3 bytes
        assert_eq!(parse_range("bytes=8-100", 10), Some((8, 9)));   // end clamped to total-1
        assert_eq!(parse_range("bytes=20-25", 10), None);           // start past EOF
        assert_eq!(parse_range("bytes=5-2", 10), None);             // inverted
        assert_eq!(parse_range("nonsense", 10), None);
        assert_eq!(parse_range("bytes=0-0", 0), None);              // empty file
    }

    #[test]
    fn content_types() {
        assert_eq!(content_type("MP3"), "audio/mpeg");
        assert_eq!(content_type("flac"), "audio/flac");
        assert_eq!(content_type("xyz"), "application/octet-stream");
    }

    #[test]
    fn token_is_stable() {
        assert_eq!(token("/music/a.mp3"), token("/music/a.mp3"));
        assert_ne!(token("/music/a.mp3"), token("/music/b.mp3"));
    }

    #[test]
    fn serves_a_ranged_request() {
        // write a temp file, start the server, fetch bytes 2-5 over a raw socket, assert 206 + body.
        let dir = std::env::temp_dir().join(format!("wavr-stream-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("clip.mp3");
        std::fs::File::create(&path).unwrap().write_all(b"0123456789").unwrap();

        let srv = StreamServer::start("127.0.0.1").unwrap();
        let tok = srv.register(path.clone());

        use std::io::{Read as _, Write as _};
        let mut sock = std::net::TcpStream::connect(("127.0.0.1", srv.port())).unwrap();
        write!(sock, "GET /f/{tok} HTTP/1.1\r\nHost: localhost\r\nRange: bytes=2-5\r\nConnection: close\r\n\r\n").unwrap();
        let mut resp = String::new();
        sock.read_to_string(&mut resp).unwrap();

        assert!(resp.starts_with("HTTP/1.1 206"), "expected 206, got: {}", resp.lines().next().unwrap_or(""));
        assert!(resp.contains("Content-Range: bytes 2-5/10"), "missing/!wrong Content-Range:\n{resp}");
        assert!(resp.ends_with("2345"), "expected body 2345, got tail: {:?}", &resp[resp.len().saturating_sub(8)..]);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
