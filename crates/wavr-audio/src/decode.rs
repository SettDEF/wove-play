//! File decode (symphonia → interleaved f32) + linear resample / channel remap to
//! the output device's format. Self-contained; no host deps.

use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

/// Cap decode length so a runaway/huge file can't exhaust memory in S0 (in-memory
/// PCM). Streaming in S3 removes this.
const MAX_SECS: usize = 1200; // 20 min

/// Decode an audio file to INTERLEAVED f32 + (sample_rate, channels). Whole file.
pub fn decode_interleaved(path: &str) -> Result<(Vec<f32>, u32, u16), String> {
    let (pcm, sr, ch, _, _) = decode_interleaved_until(path, None)?;
    Ok((pcm, sr, ch))
}

/// Decode up to `max_samples` interleaved f32 (None = whole file, capped at MAX_SECS). Returns
/// `(samples, sample_rate, channels, complete, est_total_frames)` where `complete` is true iff EOF was
/// reached (false ⇒ stopped early at the cap — there's more to decode), and `est_total_frames` is the
/// track's total frame count from the header (0 if unknown) for a duration estimate while streaming.
pub fn decode_interleaved_until(path: &str, max_samples: Option<usize>) -> Result<(Vec<f32>, u32, u16, bool, u64), String> {
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
    let track = format
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
        .ok_or("no audio track")?;
    let track_id = track.id;
    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|e| format!("codec: {e}"))?;

    let mut out: Vec<f32> = Vec::new();
    let mut sr = track.codec_params.sample_rate.unwrap_or(44_100);
    let mut ch: u16 = track.codec_params.channels.map(|c| c.count() as u16).unwrap_or(2);
    let n_frames = track.codec_params.n_frames.unwrap_or(0); // total frames from header (0 = unknown)
    let mut sbuf: Option<SampleBuffer<f32>> = None;
    // memory bound from the track header; the caller's limit (a short prefix for instant start) is applied too.
    let cap = (sr as usize).max(1) * (ch as usize).max(1) * MAX_SECS;
    let limit = max_samples.map(|m| m.min(cap)).unwrap_or(cap);
    let mut complete = true; // set false if we stop early at the limit (more remains)

    while let Ok(packet) = format.next_packet() {
        if packet.track_id() != track_id {
            continue;
        }
        let decoded = match decoder.decode(&packet) {
            Ok(d) => d,
            Err(_) => continue, // tolerate a bad packet
        };
        let spec = *decoded.spec();
        sr = spec.rate;
        ch = spec.channels.count() as u16;
        if sbuf.as_ref().map(|b| b.capacity() < decoded.capacity()).unwrap_or(true) {
            sbuf = Some(SampleBuffer::<f32>::new(decoded.capacity() as u64, spec));
        }
        let sb = sbuf.as_mut().unwrap();
        sb.copy_interleaved_ref(decoded);
        out.extend_from_slice(sb.samples());
        if out.len() >= limit {
            complete = false; // hit the prefix cap — there's more to decode in the background
            break;
        }
    }
    if out.is_empty() {
        return Err("decoded no audio".into());
    }
    Ok((out, sr, ch.max(1), complete, n_frames))
}

/// Single-pass streaming decode: invokes `on_pcm(&interleaved, sr, ch)` for each decoded packet (f32 at
/// the FILE's rate/channels). Return `false` from the callback to STOP early (cancellation). Lets the
/// caller append progressively so playback can stay ahead of a slow full-file decode.
pub fn decode_stream(path: &str, mut on_pcm: impl FnMut(&[f32], u32, u16) -> bool) -> Result<(), String> {
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
    let track = format
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
        .ok_or("no audio track")?;
    let track_id = track.id;
    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|e| format!("codec: {e}"))?;
    let mut sbuf: Option<SampleBuffer<f32>> = None;
    while let Ok(packet) = format.next_packet() {
        if packet.track_id() != track_id {
            continue;
        }
        let decoded = match decoder.decode(&packet) {
            Ok(d) => d,
            Err(_) => continue,
        };
        let spec = *decoded.spec();
        if sbuf.as_ref().map(|b| b.capacity() < decoded.capacity()).unwrap_or(true) {
            sbuf = Some(SampleBuffer::<f32>::new(decoded.capacity() as u64, spec));
        }
        let sb = sbuf.as_mut().unwrap();
        sb.copy_interleaved_ref(decoded);
        if !on_pcm(sb.samples(), spec.rate, spec.channels.count() as u16) {
            break;
        }
    }
    Ok(())
}

/// CONTINUOUS resample for progressive decode: emit as many output frames as the GROWING `src` (full
/// source-so-far) currently allows, advancing `src_pos` (a fractional source-frame cursor) so repeated
/// calls produce a seamless stream with NO per-chunk boundary glitch. Appends to `out`. The final source
/// frame is emitted only once more source (or EOF) is known — i.e. one frame of latency, inaudible.
pub fn resample_append(src: &[f32], sr: u32, ch: u16, dr: u32, dch: u16, src_pos: &mut f64, out: &mut Vec<f32>) {
    if ch == 0 || dch == 0 || sr == 0 || dr == 0 {
        return;
    }
    let ch = ch as usize;
    let dch = dch as usize;
    let frames = src.len() / ch;
    if frames < 2 {
        return;
    }
    let ratio = sr as f64 / dr as f64;
    let map = |tc: usize| -> usize { if ch == 1 { 0 } else { tc % ch } };
    while (src_pos.floor() as usize) + 1 < frames {
        let i0 = src_pos.floor() as usize;
        let i1 = i0 + 1;
        let frac = (*src_pos - i0 as f64) as f32;
        for tc in 0..dch {
            let sc = map(tc);
            let a = src[i0 * ch + sc];
            let b = src[i1 * ch + sc];
            out.push(a + (b - a) * frac);
        }
        *src_pos += ratio;
    }
}

/// Linear-resample + channel-remap interleaved `src` (`sr`/`ch`) to `dr`/`dch`.
/// Mono → duplicated to all output channels; multi → wrapped/truncated. Good enough
/// for playback; a polyphase resampler can replace this later if needed.
pub fn resample_remap(src: &[f32], sr: u32, ch: u16, dr: u32, dch: u16) -> Vec<f32> {
    if src.is_empty() || ch == 0 || dch == 0 || sr == 0 || dr == 0 {
        return Vec::new();
    }
    let ch = ch as usize;
    let dch = dch as usize;
    let frames = src.len() / ch;
    if frames == 0 {
        return Vec::new();
    }
    let ratio = sr as f64 / dr as f64;
    let out_frames = ((frames as f64) / ratio).floor() as usize;
    let mut out = vec![0.0f32; out_frames * dch];
    let map = |tc: usize| -> usize { if ch == 1 { 0 } else { tc % ch } };
    for of in 0..out_frames {
        let src_f = of as f64 * ratio;
        let i0 = (src_f.floor() as usize).min(frames - 1);
        let i1 = (i0 + 1).min(frames - 1);
        let frac = (src_f - src_f.floor()) as f32;
        for tc in 0..dch {
            let sc = map(tc);
            let a = src[i0 * ch + sc];
            let b = src[i1 * ch + sc];
            out[of * dch + tc] = a + (b - a) * frac;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Minimal 16-bit PCM WAV so we can round-trip decode without any fixture file.
    fn write_wav(path: &std::path::Path, samples: &[i16], sr: u32, ch: u16) {
        let bytes_per = 2u32;
        let data_len = (samples.len() as u32) * bytes_per;
        let byte_rate = sr * ch as u32 * bytes_per;
        let mut b: Vec<u8> = Vec::new();
        b.extend_from_slice(b"RIFF");
        b.extend_from_slice(&(36 + data_len).to_le_bytes());
        b.extend_from_slice(b"WAVE");
        b.extend_from_slice(b"fmt ");
        b.extend_from_slice(&16u32.to_le_bytes());
        b.extend_from_slice(&1u16.to_le_bytes()); // PCM
        b.extend_from_slice(&ch.to_le_bytes());
        b.extend_from_slice(&sr.to_le_bytes());
        b.extend_from_slice(&byte_rate.to_le_bytes());
        b.extend_from_slice(&(ch * 2).to_le_bytes()); // block align
        b.extend_from_slice(&16u16.to_le_bytes());    // bits
        b.extend_from_slice(b"data");
        b.extend_from_slice(&data_len.to_le_bytes());
        for s in samples {
            b.extend_from_slice(&s.to_le_bytes());
        }
        std::fs::write(path, b).unwrap();
    }

    #[test]
    fn decodes_a_wav_roundtrip() {
        // 0.1 s of a 440 Hz tone, stereo @ 44.1k.
        let sr = 44_100u32;
        let n = (sr as f32 * 0.1) as usize;
        let mut s: Vec<i16> = Vec::with_capacity(n * 2);
        for i in 0..n {
            let v = ((2.0 * std::f32::consts::PI * 440.0 * i as f32 / sr as f32).sin() * 12000.0) as i16;
            s.push(v);
            s.push(v);
        }
        let dir = std::env::temp_dir();
        let path = dir.join(format!("wavr_audio_test_{}.wav", std::process::id()));
        write_wav(&path, &s, sr, 2);
        let (pcm, dsr, dch) = decode_interleaved(path.to_str().unwrap()).expect("decode");
        let _ = std::fs::remove_file(&path);
        assert_eq!(dsr, sr);
        assert_eq!(dch, 2);
        assert!((pcm.len() as i64 - (n as i64 * 2)).abs() <= 8, "got {} samples", pcm.len());
        assert!(pcm.iter().any(|v| v.abs() > 0.1), "decoded silence");
    }

    #[test]
    fn resample_halves_at_double_rate_and_dups_mono() {
        // mono 1000 Hz-ish ramp at 48k → stereo at 24k: ~half the frames, L==R.
        let src: Vec<f32> = (0..480).map(|i| (i as f32 / 480.0) * 2.0 - 1.0).collect();
        let out = resample_remap(&src, 48_000, 1, 24_000, 2);
        let out_frames = out.len() / 2;
        assert!((out_frames as i64 - 240).abs() <= 1, "frames {out_frames}");
        for f in 0..out_frames {
            assert_eq!(out[f * 2], out[f * 2 + 1], "mono must duplicate to L+R");
        }
    }

    #[test]
    fn resample_identity_keeps_length() {
        let src: Vec<f32> = (0..200).map(|i| (i % 7) as f32 * 0.1).collect();
        let out = resample_remap(&src, 44_100, 2, 44_100, 2);
        assert_eq!(out.len(), src.len());
    }
}
