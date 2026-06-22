//! Dev probe: run the player's beatgrid (A1) on REAL files from disk and print
//! the detected tempo / grid so we can sanity-check it across genres.
//!
//!   cargo run --release --example bpm_probe -- <file1> <file2> ...
//!
//! Prints, per file: the OLD fingerprint BPM (analysis.rs) vs the NEW beatgrid
//! BPM, plus confidence, first-beat phase, is_stable and tracked-beat count.

use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::DecoderOptions;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

fn decode_to_mono_f32(path: &str, max_secs: u32) -> Result<(Vec<f32>, u32), String> {
    let file = std::fs::File::open(path).map_err(|e| format!("open: {e}"))?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = std::path::Path::new(path).extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }
    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &FormatOptions::default(), &MetadataOptions::default())
        .map_err(|e| format!("probe: {e}"))?;
    let mut format = probed.format;
    let track = format.default_track().ok_or("no audio track")?;
    let sample_rate = track.codec_params.sample_rate.ok_or("unknown sample rate")?;
    let codec_params = track.codec_params.clone();
    let track_id = track.id;
    let mut decoder = symphonia::default::get_codecs()
        .make(&codec_params, &DecoderOptions::default())
        .map_err(|e| format!("codec: {e}"))?;

    let mut mono = Vec::new();
    let cap = sample_rate as usize * max_secs as usize;
    loop {
        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(_) => break,
        };
        if packet.track_id() != track_id {
            continue;
        }
        let decoded = match decoder.decode(&packet) {
            Ok(d) => d,
            Err(_) => continue,
        };
        let spec = *decoded.spec();
        let frames = decoded.capacity() as u64;
        let mut sb = SampleBuffer::<f32>::new(frames, spec);
        sb.copy_interleaved_ref(decoded);
        let samples = sb.samples();
        let ch = spec.channels.count().max(1);
        let mut i = 0;
        while i + ch <= samples.len() {
            let sum: f32 = (0..ch).map(|c| samples[i + c]).sum();
            mono.push(sum / ch as f32);
            i += ch;
        }
        if mono.len() > cap {
            break;
        }
    }
    Ok((mono, sample_rate))
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() {
        eprintln!("usage: bpm_probe <audio files...>");
        std::process::exit(2);
    }
    println!(
        "{:<46} {:>5} {:>6}  {:>6} {:>5} {:>4} {:>10} {:>6}",
        "file", "sr", "oldBPM", "BPM", "conf", "cam", "key", "stable"
    );
    for path in &args {
        let name = std::path::Path::new(path)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or(path);
        let short: String = name.chars().take(45).collect();
        let (samples, sr) = match decode_to_mono_f32(path, 600) {
            Ok(v) => v,
            Err(e) => {
                println!("{:<46} decode error: {}", short, e);
                continue;
            }
        };
        let old = taste::analyze_samples(&samples, sr).bpm;
        let t0 = std::time::Instant::now();
        let an = taste::beatgrid::analyze_beats(&samples, sr);
        let key = taste::detect_key(&samples, sr);
        let ms = t0.elapsed().as_millis();
        println!(
            "{:<46} {:>5} {:>6.1}  {:>6.1} {:>5.2} {:>4} {:>10} {:>6}  ({} ms)",
            short, sr, old, an.bpm, an.confidence,
            key.camelot, key.key, if an.is_stable { "yes" } else { "DRIFT" }, ms,
        );
        if std::env::var("PROBE_REG").is_ok() {
            let (b, rms, n, t1, t2, t3) = taste::beatgrid::debug_regression(&samples, sr);
            println!(
                "        grid {:.2}  residRMS {:.1}ms  matched {}  thirds {:.2}/{:.2}/{:.2}",
                b, rms, n, t1, t2, t3
            );
        }
        if std::env::var("PROBE_SWEEP").is_ok() {
            for (band, peaks) in taste::beatgrid::debug_tempo_sweep(&samples, sr, 5) {
                let s: Vec<String> = peaks.iter().map(|(b, v)| format!("{:.1}={:.2}x", b, v)).collect();
                println!("        {:<6} {}", band, s.join("  "));
            }
        }
    }
}
