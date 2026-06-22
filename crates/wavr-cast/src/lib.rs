//! Discover cast targets on the local network and push a media URL to them.
//!
//! Two device families:
//!  * **DLNA / UPnP MediaRenderer** (most smart TVs, AV receivers, some speakers) — discovered over
//!    SSDP (UDP multicast) and driven with plain SOAP (`SetAVTransportURI` + `Play`). Fully wired
//!    here: a track served by `wavr-stream` on the LAN plays on the TV.
//!  * **Chromecast** — discovered over mDNS (`_googlecast._tcp.local`). Casting to it needs the Cast
//!    v2 channel (TLS + protobuf), which is a follow-up; discovery lists them so the picker is honest.
//!
//! Everything runs on std sockets (no async runtime / TLS), matching `wavr-stream`. The wire parsing
//! (SSDP headers, device-description XML, mDNS packets, URL joining, SOAP bodies) is split into pure
//! functions so it's unit-testable without a device on the bench.

use std::io::{Read, Write};
use std::net::{TcpStream, UdpSocket};
use std::time::Duration;

mod cast_v2;

#[derive(Clone, Debug, PartialEq)]
pub enum Kind { Dlna, Chromecast }

#[derive(Clone, Debug)]
pub struct CastDevice {
    pub id: String,       // stable per device (the USN / mDNS instance)
    pub name: String,     // friendly name shown in the picker
    pub kind: Kind,
    pub address: String,  // "host:port"
    /// DLNA only: absolute AVTransport control URL. Empty for Chromecast.
    pub control_url: String,
}

// ───────────────────────────── discovery ─────────────────────────────

/// Discover both DLNA renderers and Chromecasts, waiting up to `timeout` for replies.
pub fn discover(timeout: Duration) -> Vec<CastDevice> {
    let mut out = discover_dlna(timeout).unwrap_or_default();
    out.extend(discover_chromecast(timeout).unwrap_or_default());
    // de-dup by id (a device can answer more than once)
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out.dedup_by(|a, b| a.id == b.id);
    out
}

/// SSDP M-SEARCH for MediaRenderers, then fetch each device description for its name + control URL.
fn discover_dlna(timeout: Duration) -> std::io::Result<Vec<CastDevice>> {
    let sock = UdpSocket::bind("0.0.0.0:0")?;
    sock.set_read_timeout(Some(timeout))?;
    let msg = "M-SEARCH * HTTP/1.1\r\n\
        HOST: 239.255.255.250:1900\r\n\
        MAN: \"ssdp:discover\"\r\n\
        MX: 2\r\n\
        ST: urn:schemas-upnp-org:device:MediaRenderer:1\r\n\r\n";
    sock.send_to(msg.as_bytes(), "239.255.255.250:1900")?;

    let mut seen = Vec::new();
    let mut buf = [0u8; 2048];
    while let Ok((n, _)) = sock.recv_from(&mut buf) { // loop ends on the read timeout
        let resp = String::from_utf8_lossy(&buf[..n]);
        if let Some(loc) = header_value(&resp, "LOCATION") {
            let usn = header_value(&resp, "USN").unwrap_or_else(|| loc.clone());
            if seen.iter().any(|(u, _): &(String, String)| u == &usn) { continue; }
            seen.push((usn, loc));
        }
    }

    Ok(seen.into_iter().filter_map(|(usn, loc)| {
        let xml = http_get(&loc).ok()?;
        let (name, control) = parse_device_desc(&xml)?;
        Some(CastDevice {
            id: usn,
            name,
            kind: Kind::Dlna,
            address: host_of(&loc),
            control_url: join_url(&loc, &control),
        })
    }).collect())
}

/// mDNS query for `_googlecast._tcp.local` and parse the answers into discoverable Chromecasts.
fn discover_chromecast(timeout: Duration) -> std::io::Result<Vec<CastDevice>> {
    let sock = UdpSocket::bind("0.0.0.0:0")?;
    sock.set_read_timeout(Some(timeout))?;
    sock.send_to(&mdns_query("_googlecast._tcp.local"), "224.0.0.251:5353")?;

    let mut out: Vec<CastDevice> = Vec::new();
    let mut buf = [0u8; 4096];
    while let Ok((n, src)) = sock.recv_from(&mut buf) { // loop ends on the read timeout
        for d in parse_chromecast(&buf[..n]) {
            let id = d.instance.clone();
            if out.iter().any(|c| c.id == id) { continue; }
            out.push(CastDevice {
                id,
                name: d.friendly.unwrap_or(d.instance),
                kind: Kind::Chromecast,
                address: if d.port > 0 { format!("{}:{}", src.ip(), d.port) } else { src.ip().to_string() },
                control_url: String::new(),
            });
        }
    }
    Ok(out)
}

// ───────────────────────────── casting ─────────────────────────────

/// Push a media URL to a device. DLNA: SetAVTransportURI + Play. Chromecast: launch the Default
/// Media Receiver over the Cast-v2 TLS channel and LOAD the URL.
pub fn play(device: &CastDevice, media_url: &str, title: &str, mime: &str) -> std::io::Result<()> {
    match device.kind {
        Kind::Dlna => {
            soap(&device.control_url, "SetAVTransportURI", &set_uri_body(media_url, title, mime))?;
            soap(&device.control_url, "Play", &play_body())?;
            Ok(())
        }
        Kind::Chromecast => {
            let addr = if device.address.contains(':') { device.address.clone() }
                       else { format!("{}:8009", device.address) };
            cast_v2::load(&addr, media_url, title, mime)
        }
    }
}

/// Stop playback on a device (DLNA AVTransport Stop, or quit the Chromecast receiver app).
pub fn stop(device: &CastDevice) -> std::io::Result<()> {
    match device.kind {
        Kind::Dlna => { soap(&device.control_url, "Stop", &stop_body())?; Ok(()) }
        Kind::Chromecast => {
            let addr = if device.address.contains(':') { device.address.clone() }
                       else { format!("{}:8009", device.address) };
            cast_v2::stop(&addr)
        }
    }
}

// ───────────────────────────── pure wire helpers (tested) ─────────────────────────────

/// Case-insensitive lookup of an HTTP/SSDP header value.
pub fn header_value(response: &str, key: &str) -> Option<String> {
    let key = key.to_ascii_lowercase();
    response.lines().find_map(|line| {
        let (k, v) = line.split_once(':')?;
        (k.trim().to_ascii_lowercase() == key).then(|| v.trim().to_string())
    })
}

/// "scheme://host:port" of a URL (used as the device address).
pub fn host_of(url: &str) -> String {
    let rest = url.split("://").nth(1).unwrap_or(url);
    rest.split('/').next().unwrap_or(rest).to_string()
}

/// Resolve a (possibly relative) control path against the device-description URL.
pub fn join_url(base: &str, path: &str) -> String {
    if path.starts_with("http://") || path.starts_with("https://") { return path.to_string(); }
    let scheme_host = match base.split_once("://") {
        Some((scheme, rest)) => format!("{scheme}://{}", rest.split('/').next().unwrap_or(rest)),
        None => return path.to_string(),
    };
    if path.starts_with('/') { format!("{scheme_host}{path}") } else { format!("{scheme_host}/{path}") }
}

/// Pull the friendly name and the AVTransport `controlURL` out of a UPnP device description XML.
pub fn parse_device_desc(xml: &str) -> Option<(String, String)> {
    let name = tag_text(xml, "friendlyName").unwrap_or_else(|| "DLNA device".to_string());
    // Find the <service> block whose serviceType is AVTransport, then its <controlURL>.
    let mut rest = xml;
    while let Some(start) = rest.find("<service") {
        let block = &rest[start..];
        let end = block.find("</service>").map(|e| e + "</service>".len()).unwrap_or(block.len());
        let svc = &block[..end];
        if svc.contains("AVTransport") {
            if let Some(ctrl) = tag_text(svc, "controlURL") { return Some((name, ctrl)); }
        }
        rest = &block[end..];
    }
    None
}

/// Text content of the first `<tag>…</tag>` (namespace-insensitive on the open tag).
fn tag_text(xml: &str, tag: &str) -> Option<String> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let s = xml.find(&open)? + open.len();
    let e = xml[s..].find(&close)? + s;
    Some(xml[s..e].trim().to_string())
}

fn escape_xml(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// DIDL-Lite metadata + SetAVTransportURI SOAP body.
pub fn set_uri_body(url: &str, title: &str, mime: &str) -> String {
    let didl = format!(
        "<DIDL-Lite xmlns=\"urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/\" \
xmlns:dc=\"http://purl.org/dc/elements/1.1/\" \
xmlns:upnp=\"urn:schemas-upnp-org:metadata-1-0/upnp/\">\
<item id=\"0\" parentID=\"-1\" restricted=\"1\">\
<dc:title>{}</dc:title><upnp:class>object.item.audioItem.musicTrack</upnp:class>\
<res protocolInfo=\"http-get:*:{}:*\">{}</res></item></DIDL-Lite>",
        escape_xml(title), mime, escape_xml(url));
    format!(
        "<u:SetAVTransportURI xmlns:u=\"urn:schemas-upnp-org:service:AVTransport:1\">\
<InstanceID>0</InstanceID><CurrentURI>{}</CurrentURI><CurrentURIMetaData>{}</CurrentURIMetaData>\
</u:SetAVTransportURI>",
        escape_xml(url), escape_xml(&didl))
}

pub fn play_body() -> String {
    "<u:Play xmlns:u=\"urn:schemas-upnp-org:service:AVTransport:1\">\
<InstanceID>0</InstanceID><Speed>1</Speed></u:Play>".to_string()
}
pub fn stop_body() -> String {
    "<u:Stop xmlns:u=\"urn:schemas-upnp-org:service:AVTransport:1\">\
<InstanceID>0</InstanceID></u:Stop>".to_string()
}

/// Build a minimal mDNS query packet (one PTR question for `name`).
pub fn mdns_query(name: &str) -> Vec<u8> {
    let mut p = vec![0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]; // id=0, flags=0, qd=1
    for label in name.split('.') {
        p.push(label.len() as u8);
        p.extend_from_slice(label.as_bytes());
    }
    p.push(0);                 // end of name
    p.extend_from_slice(&[0, 12]); // QTYPE = PTR
    p.extend_from_slice(&[0, 1]);  // QCLASS = IN
    p
}

struct McHit { instance: String, friendly: Option<String>, port: u16 }

/// Parse an mDNS response for `_googlecast._tcp` answers → instance name, port (SRV), friendly (TXT `fn=`).
pub(crate) fn parse_chromecast(pkt: &[u8]) -> Vec<McHit> {
    let mut hits: Vec<McHit> = Vec::new();
    let recs = match parse_dns_records(pkt) { Some(r) => r, None => return hits };
    for r in &recs {
        match r.rtype {
            12 => { // PTR → "<instance>._googlecast._tcp.local"
                if let Some(target) = read_name(pkt, r.rdata_off) {
                    let instance = target.split("._googlecast").next().unwrap_or(&target).to_string();
                    if !instance.is_empty() && !hits.iter().any(|h| h.instance == instance) {
                        hits.push(McHit { instance, friendly: None, port: 0 });
                    }
                }
            }
            33 => { // SRV → port at rdata+4
                if r.rdata_off + 6 <= pkt.len() {
                    let port = u16::from_be_bytes([pkt[r.rdata_off + 4], pkt[r.rdata_off + 5]]);
                    let inst = r.name.split("._googlecast").next().unwrap_or(&r.name).to_string();
                    if let Some(h) = hits.iter_mut().find(|h| h.instance == inst) { h.port = port; }
                    else if !inst.is_empty() { hits.push(McHit { instance: inst, friendly: None, port }); }
                }
            }
            16 => { // TXT → look for "fn=<friendly name>"
                if let Some(fr) = txt_value(pkt, r.rdata_off, r.rdlen, "fn") {
                    let inst = r.name.split("._googlecast").next().unwrap_or(&r.name).to_string();
                    if let Some(h) = hits.iter_mut().find(|h| h.instance == inst) { h.friendly = Some(fr); }
                }
            }
            _ => {}
        }
    }
    hits
}

struct DnsRec { name: String, rtype: u16, rdlen: usize, rdata_off: usize }

/// Walk a DNS message past the questions and return its resource records (name + type + rdata span).
fn parse_dns_records(pkt: &[u8]) -> Option<Vec<DnsRec>> {
    if pkt.len() < 12 { return None; }
    let qd = u16::from_be_bytes([pkt[4], pkt[5]]) as usize;
    let an = u16::from_be_bytes([pkt[6], pkt[7]]) as usize;
    let ns = u16::from_be_bytes([pkt[8], pkt[9]]) as usize;
    let ar = u16::from_be_bytes([pkt[10], pkt[11]]) as usize;
    let mut off = 12;
    for _ in 0..qd { off = skip_name(pkt, off)? + 4; } // name + qtype(2) + qclass(2)
    let mut recs = Vec::new();
    for _ in 0..(an + ns + ar) {
        let name = read_name(pkt, off)?;
        off = skip_name(pkt, off)?;
        if off + 10 > pkt.len() { break; }
        let rtype = u16::from_be_bytes([pkt[off], pkt[off + 1]]);
        let rdlen = u16::from_be_bytes([pkt[off + 8], pkt[off + 9]]) as usize;
        let rdata_off = off + 10;
        if rdata_off + rdlen > pkt.len() { break; }
        recs.push(DnsRec { name, rtype, rdlen, rdata_off });
        off = rdata_off + rdlen;
    }
    Some(recs)
}

/// Advance past a (possibly compressed) DNS name, returning the offset just after it.
fn skip_name(pkt: &[u8], mut off: usize) -> Option<usize> {
    loop {
        let len = *pkt.get(off)?;
        if len & 0xc0 == 0xc0 { return Some(off + 2); }   // pointer = 2 bytes, name ends
        if len == 0 { return Some(off + 1); }              // root label
        off += 1 + len as usize;
    }
}

/// Read a (possibly compressed) DNS name into a dotted string.
fn read_name(pkt: &[u8], mut off: usize) -> Option<String> {
    let mut out = String::new();
    let mut hops = 0;
    loop {
        let len = *pkt.get(off)?;
        if len & 0xc0 == 0xc0 {
            let ptr = (((len & 0x3f) as usize) << 8) | *pkt.get(off + 1)? as usize;
            off = ptr;
            hops += 1;
            if hops > 64 { return None; } // guard against pointer loops
            continue;
        }
        if len == 0 { break; }
        let s = off + 1;
        let e = s + len as usize;
        if e > pkt.len() { return None; }
        if !out.is_empty() { out.push('.'); }
        out.push_str(&String::from_utf8_lossy(&pkt[s..e]));
        off = e;
    }
    Some(out)
}

/// Find `key=value` inside a TXT record's length-prefixed strings.
fn txt_value(pkt: &[u8], mut off: usize, rdlen: usize, key: &str) -> Option<String> {
    let end = off + rdlen;
    let prefix = format!("{key}=");
    while off < end {
        let len = *pkt.get(off)? as usize;
        off += 1;
        if off + len > pkt.len() { return None; }
        let s = String::from_utf8_lossy(&pkt[off..off + len]);
        if let Some(v) = s.strip_prefix(&prefix) { return Some(v.to_string()); }
        off += len;
    }
    None
}

// ───────────────────────────── tiny blocking HTTP ─────────────────────────────

fn http_get(url: &str) -> std::io::Result<String> {
    let (host, path) = split_url(url)?;
    let mut sock = TcpStream::connect(&host)?;
    sock.set_read_timeout(Some(Duration::from_secs(4)))?;
    write!(sock, "GET {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n")?;
    let mut resp = String::new();
    sock.read_to_string(&mut resp)?;
    Ok(resp.split_once("\r\n\r\n").map(|(_, b)| b).unwrap_or(&resp).to_string())
}

/// POST a SOAP action to a control URL.
fn soap(control_url: &str, action: &str, body: &str) -> std::io::Result<()> {
    let (host, path) = split_url(control_url)?;
    let envelope = format!(
        "<?xml version=\"1.0\"?><s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" \
s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\"><s:Body>{body}</s:Body></s:Envelope>");
    let mut sock = TcpStream::connect(&host)?;
    sock.set_read_timeout(Some(Duration::from_secs(4)))?;
    write!(sock,
        "POST {path} HTTP/1.1\r\nHost: {host}\r\nContent-Type: text/xml; charset=\"utf-8\"\r\n\
SOAPACTION: \"urn:schemas-upnp-org:service:AVTransport:1#{action}\"\r\n\
Content-Length: {}\r\nConnection: close\r\n\r\n{envelope}",
        envelope.len())?;
    let mut resp = String::new();
    sock.read_to_string(&mut resp)?;
    if resp.starts_with("HTTP/1.1 200") || resp.starts_with("HTTP/1.0 200") { Ok(()) }
    else { Err(std::io::Error::other(format!("cast control failed: {}", resp.lines().next().unwrap_or("")))) }
}

/// "http://host:port/path" → ("host:port", "/path").
fn split_url(url: &str) -> std::io::Result<(String, String)> {
    let rest = url.strip_prefix("http://").ok_or_else(|| std::io::Error::other("not http"))?;
    let (host, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, "/"),
    };
    Ok((host.to_string(), path.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn header_lookup_is_case_insensitive() {
        let r = "HTTP/1.1 200 OK\r\nLOCATION: http://10.0.0.5:8080/desc.xml\r\nST: x\r\n";
        assert_eq!(header_value(r, "location"), Some("http://10.0.0.5:8080/desc.xml".into()));
        assert_eq!(header_value(r, "missing"), None);
    }

    #[test]
    fn url_joining() {
        assert_eq!(join_url("http://10.0.0.5:8080/desc.xml", "/ctrl/AVT"), "http://10.0.0.5:8080/ctrl/AVT");
        assert_eq!(join_url("http://10.0.0.5:8080/desc.xml", "ctrl/AVT"), "http://10.0.0.5:8080/ctrl/AVT");
        assert_eq!(join_url("http://h/d.xml", "http://other/x"), "http://other/x");
        assert_eq!(host_of("http://10.0.0.5:8080/desc.xml"), "10.0.0.5:8080");
    }

    #[test]
    fn device_desc_finds_avtransport_control() {
        let xml = r#"<root><device><friendlyName>Living Room TV</friendlyName>
            <serviceList>
              <service><serviceType>urn:schemas-upnp-org:service:RenderingControl:1</serviceType>
                <controlURL>/rc/ctrl</controlURL></service>
              <service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType>
                <controlURL>/avt/ctrl</controlURL></service>
            </serviceList></device></root>"#;
        assert_eq!(parse_device_desc(xml), Some(("Living Room TV".into(), "/avt/ctrl".into())));
    }

    #[test]
    fn soap_bodies_are_well_formed() {
        let b = set_uri_body("http://10.0.0.2:9000/f/abc", "Song & <Friends>", "audio/mpeg");
        assert!(b.contains("SetAVTransportURI"));
        assert!(!b.contains("<Friends>"));                         // raw title never leaks unescaped
        assert!(b.contains("&lt;DIDL-Lite"));                      // metadata escaped into the element
        assert!(b.contains("http://10.0.0.2:9000/f/abc"));
        assert!(play_body().contains("<Speed>1</Speed>"));
    }

    #[test]
    fn mdns_query_is_a_valid_ptr_question() {
        let q = mdns_query("_googlecast._tcp.local");
        assert_eq!(&q[0..12], &[0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]); // header, 1 question
        assert_eq!(&q[q.len() - 4..], &[0, 12, 0, 1]);                  // QTYPE=PTR, QCLASS=IN
        // labels: 11 "_googlecast", 4 "_tcp", 5 "local"
        assert_eq!(q[12], 11);
        assert_eq!(&q[13..24], b"_googlecast");
    }

    #[test]
    fn parses_a_chromecast_mdns_answer() {
        // Hand-build a response: PTR + SRV + TXT for "Kitchen._googlecast._tcp.local".
        let mut p: Vec<u8> = vec![0, 0, 0x84, 0, 0, 0, 0, 3, 0, 0, 0, 0]; // 3 answers
        let name_at = |p: &mut Vec<u8>, labels: &[&str]| {
            for l in labels { p.push(l.len() as u8); p.extend_from_slice(l.as_bytes()); }
            p.push(0);
        };
        // PTR record: name=_googlecast._tcp.local, rdata=Kitchen._googlecast._tcp.local
        name_at(&mut p, &["_googlecast", "_tcp", "local"]);
        p.extend_from_slice(&[0, 12, 0, 1, 0, 0, 0, 120]); // type PTR, class IN, ttl
        let rd_ptr = b"\x07Kitchen\x0b_googlecast\x04_tcp\x05local\x00";
        p.extend_from_slice(&(rd_ptr.len() as u16).to_be_bytes());
        p.extend_from_slice(rd_ptr);
        // SRV record: name=Kitchen._googlecast._tcp.local, port 8009
        name_at(&mut p, &["Kitchen", "_googlecast", "_tcp", "local"]);
        p.extend_from_slice(&[0, 33, 0, 1, 0, 0, 0, 120]);
        let rd_srv = [0u8, 0, 0, 0, 0x1f, 0x49, 0]; // prio,weight,port=8009,target-root
        p.extend_from_slice(&(rd_srv.len() as u16).to_be_bytes());
        p.extend_from_slice(&rd_srv);
        // TXT record: name=Kitchen._googlecast._tcp.local, "fn=Kitchen speaker"
        name_at(&mut p, &["Kitchen", "_googlecast", "_tcp", "local"]);
        p.extend_from_slice(&[0, 16, 0, 1, 0, 0, 0, 120]);
        let txt = b"\x12fn=Kitchen speaker";
        p.extend_from_slice(&(txt.len() as u16).to_be_bytes());
        p.extend_from_slice(txt);

        let hits = parse_chromecast(&p);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].instance, "Kitchen");
        assert_eq!(hits[0].port, 8009);
        assert_eq!(hits[0].friendly.as_deref(), Some("Kitchen speaker"));
    }
}
