//! Chromecast Cast-v2 sender: launch the Default Media Receiver and LOAD a media URL.
//!
//! The protocol is length-prefixed (4-byte big-endian) protobuf `CastMessage`s over a TLS socket on
//! port 8009. Devices present a self-signed cert, so the TLS layer accepts any certificate (the
//! channel is only ever a LAN hop to a device the user picked). The `CastMessage` protobuf and the
//! JSON payloads are hand-built — the wire format is small and fixed — so there's no codegen / serde
//! dependency, and the encode/decode + JSON helpers are unit-tested without a device on the bench.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::Arc;
use std::time::Duration;

const NS_CONNECTION: &str = "urn:x-cast:com.google.cast.tp.connection";
const NS_HEARTBEAT: &str = "urn:x-cast:com.google.cast.tp.heartbeat";
const NS_RECEIVER: &str = "urn:x-cast:com.google.cast.receiver";
const NS_MEDIA: &str = "urn:x-cast:com.google.cast.media";
const DEFAULT_MEDIA_RECEIVER: &str = "CC1AD845";
const SENDER: &str = "sender-0";
const PLATFORM: &str = "receiver-0";

/// Connect to a Chromecast (`host:port`), launch the media receiver and load `url`.
pub fn load(addr: &str, url: &str, title: &str, mime: &str) -> std::io::Result<()> {
    let host = addr.split(':').next().unwrap_or(addr);
    let mut tls = connect_tls(addr, host)?;

    // Open the virtual connection to the platform receiver, then ask it to launch the media app.
    send(&mut tls, PLATFORM, NS_CONNECTION, r#"{"type":"CONNECT"}"#)?;
    send(&mut tls, PLATFORM, NS_RECEIVER, &launch_payload(1))?;

    // Pump messages until the receiver reports the launched app's transportId, answering PINGs.
    let mut buf = Vec::new();
    let mut transport: Option<String> = None;
    for _ in 0..40 {
        let msg = match read_message(&mut tls, &mut buf) { Ok(m) => m, Err(_) => break };
        let Some((ns, payload)) = msg else { continue };
        if ns == NS_HEARTBEAT && payload.contains("\"PING\"") {
            send(&mut tls, PLATFORM, NS_HEARTBEAT, r#"{"type":"PONG"}"#)?;
        } else if ns == NS_RECEIVER {
            if let Some(t) = transport_id_for(&payload, DEFAULT_MEDIA_RECEIVER) {
                transport = Some(t);
                break;
            }
        }
    }

    let transport = transport.ok_or_else(|| std::io::Error::other("Chromecast didn't launch the receiver"))?;
    // Connect to the app instance, then LOAD the media.
    send(&mut tls, &transport, NS_CONNECTION, r#"{"type":"CONNECT"}"#)?;
    send(&mut tls, &transport, NS_MEDIA, &load_payload(2, url, title, mime))?;
    Ok(())
}

/// Stop a Chromecast: ask the platform for its status, find the running app's sessionId and STOP it
/// (quitting the receiver app, which ends playback).
pub fn stop(addr: &str) -> std::io::Result<()> {
    let host = addr.split(':').next().unwrap_or(addr);
    let mut tls = connect_tls(addr, host)?;
    send(&mut tls, PLATFORM, NS_CONNECTION, r#"{"type":"CONNECT"}"#)?;
    send(&mut tls, PLATFORM, NS_RECEIVER, r#"{"type":"GET_STATUS","requestId":1}"#)?;

    let mut buf = Vec::new();
    for _ in 0..40 {
        let msg = match read_message(&mut tls, &mut buf) { Ok(m) => m, Err(_) => break };
        let Some((ns, payload)) = msg else { continue };
        if ns == NS_HEARTBEAT && payload.contains("\"PING\"") {
            send(&mut tls, PLATFORM, NS_HEARTBEAT, r#"{"type":"PONG"}"#)?;
        } else if ns == NS_RECEIVER {
            if let Some(session) = session_id_for(&payload, DEFAULT_MEDIA_RECEIVER) {
                send(&mut tls, PLATFORM, NS_RECEIVER, &stop_payload(2, &session))?;
                return Ok(());
            }
        }
    }
    Ok(()) // nothing running → already stopped
}

fn connect_tls(addr: &str, host: &str) -> std::io::Result<rustls::StreamOwned<rustls::ClientConnection, TcpStream>> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let config = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(std::io::Error::other)?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(AcceptAnyCert))
        .with_no_client_auth();
    let server = rustls::pki_types::ServerName::try_from(host.to_string())
        .map_err(|_| std::io::Error::other("bad host"))?;
    let conn = rustls::ClientConnection::new(Arc::new(config), server).map_err(std::io::Error::other)?;
    let sock = TcpStream::connect(addr)?;
    sock.set_read_timeout(Some(Duration::from_secs(5)))?;
    Ok(rustls::StreamOwned::new(conn, sock))
}

fn send(tls: &mut impl Write, dest: &str, namespace: &str, payload: &str) -> std::io::Result<()> {
    let msg = encode_cast_message(SENDER, dest, namespace, payload);
    tls.write_all(&(msg.len() as u32).to_be_bytes())?;
    tls.write_all(&msg)?;
    tls.flush()
}

/// Read one framed message; returns `(namespace, payload_utf8)`. `buf` carries leftover bytes between
/// calls (the TLS reader can hand back more than one frame at a time).
fn read_message(tls: &mut impl Read, buf: &mut Vec<u8>) -> std::io::Result<Option<(String, String)>> {
    // ensure we have the 4-byte length prefix
    while buf.len() < 4 { fill(tls, buf)?; }
    let len = u32::from_be_bytes([buf[0], buf[1], buf[2], buf[3]]) as usize;
    while buf.len() < 4 + len { fill(tls, buf)?; }
    let frame: Vec<u8> = buf.drain(..4 + len).skip(4).collect();
    Ok(decode_cast_message(&frame))
}

fn fill(tls: &mut impl Read, buf: &mut Vec<u8>) -> std::io::Result<()> {
    let mut chunk = [0u8; 2048];
    let n = tls.read(&mut chunk)?;
    if n == 0 { return Err(std::io::Error::other("connection closed")); }
    buf.extend_from_slice(&chunk[..n]);
    Ok(())
}

// ───────────────────────────── CastMessage protobuf (tested) ─────────────────────────────

/// Encode a CastMessage with a STRING payload. Fields: 1 protocol_version(=0), 2 source_id,
/// 3 destination_id, 4 namespace, 5 payload_type(=STRING=0), 6 payload_utf8.
pub fn encode_cast_message(source: &str, dest: &str, namespace: &str, payload: &str) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(&[0x08, 0x00]);                 // field 1 varint = 0 (CASTV2_1_0)
    write_string_field(&mut out, 2, source);
    write_string_field(&mut out, 3, dest);
    write_string_field(&mut out, 4, namespace);
    out.extend_from_slice(&[0x28, 0x00]);                 // field 5 varint = 0 (STRING)
    write_string_field(&mut out, 6, payload);
    out
}

/// Decode the `namespace` (field 4) and `payload_utf8` (field 6) out of a CastMessage.
pub fn decode_cast_message(buf: &[u8]) -> Option<(String, String)> {
    let mut i = 0;
    let mut namespace = String::new();
    let mut payload = String::new();
    while i < buf.len() {
        let (tag, n) = read_varint(buf, i)?;
        i += n;
        let field = tag >> 3;
        let wire = tag & 7;
        match wire {
            0 => { let (_, n) = read_varint(buf, i)?; i += n; }            // varint field, skip
            2 => {                                                          // length-delimited
                let (len, n) = read_varint(buf, i)?;
                i += n;
                let end = i + len as usize;
                if end > buf.len() { return None; }
                let s = String::from_utf8_lossy(&buf[i..end]).into_owned();
                if field == 4 { namespace = s; } else if field == 6 { payload = s; }
                i = end;
            }
            _ => return None,
        }
    }
    Some((namespace, payload))
}

fn write_string_field(out: &mut Vec<u8>, field: u8, s: &str) {
    out.push((field << 3) | 2); // wire type 2 (length-delimited)
    write_varint(out, s.len() as u64);
    out.extend_from_slice(s.as_bytes());
}

fn write_varint(out: &mut Vec<u8>, mut v: u64) {
    loop {
        let mut b = (v & 0x7f) as u8;
        v >>= 7;
        if v != 0 { b |= 0x80; }
        out.push(b);
        if v == 0 { break; }
    }
}

fn read_varint(buf: &[u8], mut i: usize) -> Option<(u64, usize)> {
    let start = i;
    let mut v = 0u64;
    let mut shift = 0;
    loop {
        let b = *buf.get(i)?;
        i += 1;
        v |= ((b & 0x7f) as u64) << shift;
        if b & 0x80 == 0 { break; }
        shift += 7;
        if shift > 63 { return None; }
    }
    Some((v, i - start))
}

// ───────────────────────────── JSON payloads (tested) ─────────────────────────────

fn json_escape(s: &str) -> String {
    let mut o = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            '\n' => o.push_str("\\n"),
            '\r' => o.push_str("\\r"),
            '\t' => o.push_str("\\t"),
            c if (c as u32) < 0x20 => o.push_str(&format!("\\u{:04x}", c as u32)),
            c => o.push(c),
        }
    }
    o
}

pub fn launch_payload(request_id: u32) -> String {
    format!("{{\"type\":\"LAUNCH\",\"requestId\":{request_id},\"appId\":\"{DEFAULT_MEDIA_RECEIVER}\"}}")
}

pub fn load_payload(request_id: u32, url: &str, title: &str, mime: &str) -> String {
    format!(
        "{{\"type\":\"LOAD\",\"requestId\":{request_id},\"autoplay\":true,\"media\":{{\
\"contentId\":\"{}\",\"streamType\":\"BUFFERED\",\"contentType\":\"{}\",\
\"metadata\":{{\"metadataType\":0,\"title\":\"{}\"}}}}}}",
        json_escape(url), json_escape(mime), json_escape(title))
}

pub fn stop_payload(request_id: u32, session_id: &str) -> String {
    format!("{{\"type\":\"STOP\",\"requestId\":{request_id},\"sessionId\":\"{}\"}}", json_escape(session_id))
}

/// Find the `transportId` of the application running `app_id` inside a RECEIVER_STATUS payload.
pub fn transport_id_for(payload: &str, app_id: &str) -> Option<String> {
    app_field_for(payload, app_id, "transportId")
}

/// Find the `sessionId` of the application running `app_id`.
pub fn session_id_for(payload: &str, app_id: &str) -> Option<String> {
    app_field_for(payload, app_id, "sessionId")
}

/// Read a field from the app object matching `app_id`. The receiver lists apps in an array; the
/// fields sit in the same `{…}` object as appId, in either order.
fn app_field_for(payload: &str, app_id: &str, key: &str) -> Option<String> {
    let app_pos = payload.find(&format!("\"appId\":\"{app_id}\""))?;
    let lo = payload[..app_pos].rfind('{').unwrap_or(0);
    let hi = payload[app_pos..].find('}').map(|e| app_pos + e).unwrap_or(payload.len());
    json_string_value(&payload[lo..hi], key)
}

/// Extract the string value of `"key":"value"` from a JSON fragment.
fn json_string_value(frag: &str, key: &str) -> Option<String> {
    let needle = format!("\"{key}\":\"");
    let s = frag.find(&needle)? + needle.len();
    let e = frag[s..].find('"')? + s;
    Some(frag[s..e].to_string())
}

// rustls verifier that accepts any server certificate (Chromecasts use self-signed certs).
#[derive(Debug)]
struct AcceptAnyCert;
impl rustls::client::danger::ServerCertVerifier for AcceptAnyCert {
    fn verify_server_cert(
        &self,
        _end_entity: &rustls::pki_types::CertificateDer<'_>,
        _intermediates: &[rustls::pki_types::CertificateDer<'_>],
        _server_name: &rustls::pki_types::ServerName<'_>,
        _ocsp_response: &[u8],
        _now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }
    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &rustls::pki_types::CertificateDer<'_>,
        _dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
    }
    fn verify_tls13_signature(
        &self,
        _message: &[u8],
        _cert: &rustls::pki_types::CertificateDer<'_>,
        _dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
    }
    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        use rustls::SignatureScheme::*;
        vec![
            RSA_PKCS1_SHA256, RSA_PKCS1_SHA384, RSA_PKCS1_SHA512,
            ECDSA_NISTP256_SHA256, ECDSA_NISTP384_SHA384,
            RSA_PSS_SHA256, RSA_PSS_SHA384, RSA_PSS_SHA512,
            ED25519,
        ]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cast_message_round_trips() {
        let m = encode_cast_message("sender-0", "receiver-0", NS_RECEIVER, r#"{"type":"LAUNCH"}"#);
        // 4-byte frame prefix is added by the sender, not by encode itself.
        let (ns, payload) = decode_cast_message(&m).unwrap();
        assert_eq!(ns, NS_RECEIVER);
        assert_eq!(payload, r#"{"type":"LAUNCH"}"#);
        // protocol_version + payload_type varints are present and zero
        assert_eq!(&m[0..2], &[0x08, 0x00]);
    }

    #[test]
    fn load_payload_is_escaped_json() {
        let p = load_payload(2, "http://10.0.0.2:9000/f/x", "He said \"hi\"\n", "audio/mpeg");
        assert!(p.contains("\"type\":\"LOAD\""));
        assert!(p.contains("\"contentId\":\"http://10.0.0.2:9000/f/x\""));
        assert!(p.contains("\"contentType\":\"audio/mpeg\""));
        assert!(p.contains("He said \\\"hi\\\"\\n"));          // quotes + newline escaped
        assert!(p.contains("\"autoplay\":true"));
    }

    #[test]
    fn finds_transport_id_in_receiver_status() {
        let status = r#"{"type":"RECEIVER_STATUS","status":{"applications":[
            {"appId":"CC1AD845","sessionId":"abc","transportId":"web-12","displayName":"Default Media Receiver"}
        ]}}"#;
        assert_eq!(transport_id_for(status, "CC1AD845").as_deref(), Some("web-12"));
        assert_eq!(transport_id_for(status, "OTHER"), None);
    }

    #[test]
    fn finds_session_id_and_builds_stop() {
        let status = r#"{"status":{"applications":[{"appId":"CC1AD845","sessionId":"sess-7","transportId":"web-1"}]}}"#;
        assert_eq!(session_id_for(status, "CC1AD845").as_deref(), Some("sess-7"));
        assert!(stop_payload(2, "sess-7").contains("\"sessionId\":\"sess-7\""));
    }

    #[test]
    fn transport_id_handles_reordered_fields() {
        let status = r#"{"applications":[{"transportId":"web-9","appId":"CC1AD845"}]}"#;
        assert_eq!(transport_id_for(status, "CC1AD845").as_deref(), Some("web-9"));
    }

    #[test]
    fn varint_round_trip() {
        for v in [0u64, 1, 127, 128, 300, 16384, 1 << 35] {
            let mut b = Vec::new();
            write_varint(&mut b, v);
            assert_eq!(read_varint(&b, 0), Some((v, b.len())));
        }
    }
}
