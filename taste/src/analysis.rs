//! Audio → raw feature extraction (Section 2). Pure DSP, no external deps (hand-rolled radix-2 FFT),
//! so it compiles fast and is testable with synthetic signals. Produces RAW (un-normalized) features;
//! z-scoring across the library happens in `normalize`. File decode (symphonia) is added in the host.

use crate::fingerprint::DIMS;

pub const TARGET_SR: u32 = 22_050;
const N: usize = 2048;
const HOP: usize = 512;
const MEL_BANDS: usize = 40;
const MFCC_COUNT: usize = 13;
const FMIN: f32 = 20.0;
const ANALYZE_SECS: f32 = 90.0;

/// Raw (un-normalized) feature vector in FEATURE_NAMES order; `v[44]` is the octave-folded BPM.
/// `v[38]` is the raw BPM. The library normalizer z-scores all 45 dims.
#[derive(Clone, Debug)]
pub struct RawFeatures {
    pub v: [f32; DIMS],
    pub bpm: f32,
    pub tempo_conf: f32,
}

/// Analyze mono f32 samples at `sr` → raw features. Resamples to 22.05 kHz and uses a 90 s window
/// from the temporal centre (skips intro/outro bias). `< 10× realtime` on one core.
pub fn analyze_samples(input: &[f32], sr: u32) -> RawFeatures {
    let mono = resample_linear(input, sr, TARGET_SR);
    let sig = center_window(&mono, TARGET_SR, ANALYZE_SECS);
    if sig.len() < N {
        return RawFeatures { v: [0.0; DIMS], bpm: 0.0, tempo_conf: 0.0 };
    }

    let hann = hann_window(N);
    let mel_fb = mel_filterbank(MEL_BANDS, N, TARGET_SR, FMIN, (TARGET_SR / 2) as f32);
    let nbins = N / 2 + 1;
    let bin_hz = TARGET_SR as f32 / N as f32;

    // accumulators
    let nframes = (sig.len() - N) / HOP + 1;
    let mut frames_mfcc: Vec<[f32; MFCC_COUNT]> = Vec::with_capacity(nframes);
    let mut feat_series: [Vec<f32>; 6] = Default::default(); // centroid,rolloff,flux,flatness,rms,zcr
    let mut onset_env: Vec<f32> = Vec::with_capacity(nframes);
    let mut prev_mag = vec![0.0f32; nbins];
    let mut chroma = [0.0f32; 12];
    let (mut e_low, mut e_mid, mut e_tot) = (0.0f64, 0.0f64, 0.0f64);

    let mut re = vec![0.0f32; N];
    let mut im = vec![0.0f32; N];
    let mut mag = vec![0.0f32; nbins];

    let mut pos = 0;
    while pos + N <= sig.len() {
        let frame = &sig[pos..pos + N];
        // windowed time domain → RMS + ZCR computed pre-FFT
        let mut rms = 0.0f32;
        let mut zc = 0u32;
        for i in 0..N {
            let s = frame[i];
            rms += s * s;
            if i > 0 && (frame[i - 1] < 0.0) != (s < 0.0) {
                zc += 1;
            }
            re[i] = s * hann[i];
            im[i] = 0.0;
        }
        rms = (rms / N as f32).sqrt();
        let zcr = zc as f32 / N as f32;

        fft(&mut re, &mut im);
        for k in 0..nbins {
            mag[k] = (re[k] * re[k] + im[k] * im[k]).sqrt();
        }

        // spectral descriptors
        let mut msum = 0.0f32;
        let mut fsum = 0.0f32;
        let mut geo = 0.0f32; // sum log
        let mut flux = 0.0f32;
        for k in 0..nbins {
            let m = mag[k];
            msum += m;
            fsum += m * (k as f32 * bin_hz);
            geo += (m + 1e-9).ln();
            let d = m - prev_mag[k];
            if d > 0.0 {
                flux += d;
            }
            let hz = k as f32 * bin_hz;
            let p = m * m;
            e_tot += p as f64;
            if hz < 150.0 {
                e_low += p as f64;
            }
            if hz >= 500.0 && hz <= 2000.0 {
                e_mid += p as f64;
            }
            // chroma fold
            if hz > 20.0 {
                let midi = 69.0 + 12.0 * (hz / 440.0).log2();
                let pc = ((midi.round() as i32 % 12) + 12) % 12;
                chroma[pc as usize] += m;
            }
        }
        let centroid = if msum > 0.0 { fsum / msum } else { 0.0 };
        // 85% rolloff
        let thresh = 0.85 * msum;
        let mut acc = 0.0f32;
        let mut rolloff = 0.0f32;
        for k in 0..nbins {
            acc += mag[k];
            if acc >= thresh {
                rolloff = k as f32 * bin_hz;
                break;
            }
        }
        let amean = msum / nbins as f32;
        let gmean = (geo / nbins as f32).exp();
        let flatness = if amean > 0.0 { gmean / amean } else { 0.0 };

        feat_series[0].push(centroid);
        feat_series[1].push(rolloff);
        feat_series[2].push(flux);
        feat_series[3].push(flatness);
        feat_series[4].push(rms);
        feat_series[5].push(zcr);
        onset_env.push(flux);
        frames_mfcc.push(mfcc(&mag, &mel_fb));
        prev_mag.copy_from_slice(&mag);
        pos += HOP;
    }

    // aggregate MFCC mean+std (26 dims)
    let mut v = [0.0f32; DIMS];
    for c in 0..MFCC_COUNT {
        let series: Vec<f32> = frames_mfcc.iter().map(|f| f[c]).collect();
        let (m, s) = mean_std(&series);
        v[c] = m;
        v[13 + c] = s;
    }
    // spectral descriptors mean+std → dims 26..38
    for (j, series) in feat_series.iter().enumerate() {
        let (m, s) = mean_std(series);
        v[26 + j * 2] = m;
        v[27 + j * 2] = s;
    }

    // track-level scalars (dims 38..44)
    let (bpm, tempo_conf) = estimate_tempo(&onset_env, TARGET_SR);
    v[38] = bpm; // raw BPM (normalizer z-scores this as tempo_z)
    v[39] = onset_density(&onset_env, TARGET_SR);
    v[40] = (e_low / e_tot.max(1e-9)) as f32; // low-end ratio
    v[41] = (e_mid / e_tot.max(1e-9)) as f32; // mid hoover ratio
    v[42] = crest_factor_db(&sig);
    v[43] = chroma_entropy(&chroma);
    v[44] = fold_bpm(bpm); // octave-folded BPM (raw; normalizer z-scores it)

    RawFeatures { v, bpm, tempo_conf }
}

/// Averaged, normalized 12-bin chroma (pitch-class energy) over the analysis
/// window — the input to Krumhansl key detection (`key.rs`). Reuses the same
/// hand-rolled STFT as the fingerprint so the crate stays dependency-free.
pub(crate) fn chroma_vector(input: &[f32], sr: u32) -> [f32; 12] {
    let mono = resample_linear(input, sr, TARGET_SR);
    let sig = center_window(&mono, TARGET_SR, ANALYZE_SECS);
    let mut chroma = [0.0f32; 12];
    if sig.len() < N {
        return chroma;
    }
    let hann = hann_window(N);
    let nbins = N / 2 + 1;
    let bin_hz = TARGET_SR as f32 / N as f32;
    let mut re = vec![0.0f32; N];
    let mut im = vec![0.0f32; N];
    let mut pos = 0;
    while pos + N <= sig.len() {
        for i in 0..N {
            re[i] = sig[pos + i] * hann[i];
            im[i] = 0.0;
        }
        fft(&mut re, &mut im);
        for k in 1..nbins {
            let m = (re[k] * re[k] + im[k] * im[k]).sqrt();
            let hz = k as f32 * bin_hz;
            // C1..~C8: ignore sub-bass rumble and very high partials.
            if hz > 30.0 && hz < 5000.0 {
                let midi = 69.0 + 12.0 * (hz / 440.0).log2();
                let pc = (((midi.round() as i32) % 12) + 12) % 12;
                chroma[pc as usize] += m;
            }
        }
        pos += HOP;
    }
    let s: f32 = chroma.iter().sum();
    if s > 0.0 {
        for c in chroma.iter_mut() {
            *c /= s;
        }
    }
    chroma
}

/// Per-frame feature matrix for STRUCTURE analysis (sections.rs): each STFT frame
/// → [13 MFCC (timbre), 12 chroma (harmony), 1 logRMS (energy)] = 26 dims, plus
/// frames-per-second. Reuses the same hand-rolled STFT; analyzes a centred window.
pub(crate) fn frame_features(input: &[f32], sr: u32) -> (Vec<[f32; 26]>, f32) {
    // From the START (not centred) so frame times are absolute and align with the
    // beat grid; capped so a long DJ mix doesn't blow up the SSM.
    const SECTION_SECS: usize = 360;
    let mono = resample_linear(input, sr, TARGET_SR);
    let cap = SECTION_SECS * TARGET_SR as usize;
    let sig: &[f32] = if mono.len() > cap { &mono[..cap] } else { &mono };
    let fps = TARGET_SR as f32 / HOP as f32;
    let mut frames: Vec<[f32; 26]> = Vec::new();
    if sig.len() < N {
        return (frames, fps);
    }
    let hann = hann_window(N);
    let mel_fb = mel_filterbank(MEL_BANDS, N, TARGET_SR, FMIN, (TARGET_SR / 2) as f32);
    let nbins = N / 2 + 1;
    let bin_hz = TARGET_SR as f32 / N as f32;
    let mut re = vec![0.0f32; N];
    let mut im = vec![0.0f32; N];
    let mut mag = vec![0.0f32; nbins];
    let mut pos = 0;
    while pos + N <= sig.len() {
        let frame = &sig[pos..pos + N];
        let mut rms = 0.0f32;
        for i in 0..N {
            let s = frame[i];
            rms += s * s;
            re[i] = s * hann[i];
            im[i] = 0.0;
        }
        rms = (rms / N as f32).sqrt();
        fft(&mut re, &mut im);
        for k in 0..nbins {
            mag[k] = (re[k] * re[k] + im[k] * im[k]).sqrt();
        }
        let mf = mfcc(&mag, &mel_fb);
        let mut chroma = [0.0f32; 12];
        for k in 1..nbins {
            let m = mag[k];
            let hz = k as f32 * bin_hz;
            if hz > 30.0 && hz < 5000.0 {
                let midi = 69.0 + 12.0 * (hz / 440.0).log2();
                let pc = (((midi.round() as i32) % 12) + 12) % 12;
                chroma[pc as usize] += m;
            }
        }
        let cs: f32 = chroma.iter().sum();
        if cs > 0.0 {
            for c in chroma.iter_mut() {
                *c /= cs;
            }
        }
        let mut v = [0.0f32; 26];
        v[..13].copy_from_slice(&mf);
        v[13..25].copy_from_slice(&chroma);
        v[25] = (rms + 1e-9).ln();
        frames.push(v);
        pos += HOP;
    }
    (frames, fps)
}

/// Fold a BPM into [70, 180) by octave doubling/halving (140 and 70 are rhythmically related).
pub fn fold_bpm(mut bpm: f32) -> f32 {
    if bpm <= 0.0 {
        return 0.0;
    }
    while bpm < 70.0 {
        bpm *= 2.0;
    }
    while bpm >= 180.0 {
        bpm /= 2.0;
    }
    bpm
}

// ── DSP helpers ───────────────────────────────────────────────────────────────

fn mean_std(xs: &[f32]) -> (f32, f32) {
    if xs.is_empty() {
        return (0.0, 0.0);
    }
    let n = xs.len() as f32;
    let m = xs.iter().sum::<f32>() / n;
    let var = xs.iter().map(|x| (x - m) * (x - m)).sum::<f32>() / n;
    (m, var.sqrt())
}

fn hann_window(n: usize) -> Vec<f32> {
    (0..n).map(|i| 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / (n as f32 - 1.0)).cos()).collect()
}

/// Linear resampler (good enough for feature analysis; not for playback).
fn resample_linear(input: &[f32], from: u32, to: u32) -> Vec<f32> {
    if from == to || input.is_empty() {
        return input.to_vec();
    }
    let ratio = from as f64 / to as f64;
    let out_len = ((input.len() as f64) / ratio) as usize;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let src = i as f64 * ratio;
        let i0 = src.floor() as usize;
        let frac = (src - i0 as f64) as f32;
        let a = input[i0.min(input.len() - 1)];
        let b = input[(i0 + 1).min(input.len() - 1)];
        out.push(a + (b - a) * frac);
    }
    out
}

fn center_window(sig: &[f32], sr: u32, secs: f32) -> Vec<f32> {
    let want = (secs * sr as f32) as usize;
    if sig.len() <= want {
        return sig.to_vec();
    }
    let start = (sig.len() - want) / 2;
    sig[start..start + want].to_vec()
}

/// In-place iterative radix-2 FFT (N must be a power of two).
fn fft(re: &mut [f32], im: &mut [f32]) {
    let n = re.len();
    // bit-reversal permutation
    let mut j = 0usize;
    for i in 1..n {
        let mut bit = n >> 1;
        while j & bit != 0 {
            j ^= bit;
            bit >>= 1;
        }
        j ^= bit;
        if i < j {
            re.swap(i, j);
            im.swap(i, j);
        }
    }
    let mut len = 2;
    while len <= n {
        let ang = -2.0 * std::f32::consts::PI / len as f32;
        let (wr, wi) = (ang.cos(), ang.sin());
        let half = len / 2;
        let mut i = 0;
        while i < n {
            let (mut cr, mut ci) = (1.0f32, 0.0f32);
            for k in 0..half {
                let a = i + k;
                let b = i + k + half;
                let tr = cr * re[b] - ci * im[b];
                let ti = cr * im[b] + ci * re[b];
                re[b] = re[a] - tr;
                im[b] = im[a] - ti;
                re[a] += tr;
                im[a] += ti;
                let ncr = cr * wr - ci * wi;
                ci = cr * wi + ci * wr;
                cr = ncr;
            }
            i += len;
        }
        len <<= 1;
    }
}

fn hz_to_mel(f: f32) -> f32 {
    2595.0 * (1.0 + f / 700.0).log10()
}
fn mel_to_hz(m: f32) -> f32 {
    700.0 * (10f32.powf(m / 2595.0) - 1.0)
}

/// Triangular mel filterbank → weights[band][bin].
fn mel_filterbank(bands: usize, n: usize, sr: u32, fmin: f32, fmax: f32) -> Vec<Vec<f32>> {
    let nbins = n / 2 + 1;
    let bin_hz = sr as f32 / n as f32;
    let mlo = hz_to_mel(fmin);
    let mhi = hz_to_mel(fmax);
    let points: Vec<f32> = (0..bands + 2).map(|i| mel_to_hz(mlo + (mhi - mlo) * i as f32 / (bands + 1) as f32)).collect();
    let mut fb = vec![vec![0.0f32; nbins]; bands];
    for b in 0..bands {
        let (lo, ce, hi) = (points[b], points[b + 1], points[b + 2]);
        for k in 0..nbins {
            let f = k as f32 * bin_hz;
            let w = if f >= lo && f <= ce {
                (f - lo) / (ce - lo).max(1e-6)
            } else if f > ce && f <= hi {
                (hi - f) / (hi - ce).max(1e-6)
            } else {
                0.0
            };
            fb[b][k] = w;
        }
    }
    fb
}

/// log-mel energies → DCT-II → first 13 MFCC.
fn mfcc(mag: &[f32], fb: &[Vec<f32>]) -> [f32; MFCC_COUNT] {
    let mut logmel = vec![0.0f32; fb.len()];
    for (b, filt) in fb.iter().enumerate() {
        let mut e = 0.0f32;
        for k in 0..mag.len() {
            e += mag[k] * mag[k] * filt[k];
        }
        logmel[b] = (e + 1e-9).ln();
    }
    let m = fb.len();
    let mut out = [0.0f32; MFCC_COUNT];
    for c in 0..MFCC_COUNT {
        let mut s = 0.0f32;
        for (b, &lm) in logmel.iter().enumerate() {
            s += lm * (std::f32::consts::PI * c as f32 * (b as f32 + 0.5) / m as f32).cos();
        }
        out[c] = s;
    }
    out
}

/// Min/max BPM the tempo detector searches. The wide upper bound covers fast genres — DnB ~170,
/// hardcore ~190, frenchcore ~200–220 — so they aren't reported at half tempo.
const TEMPO_MIN: i32 = 60;
const TEMPO_MAX: i32 = 240;

/// Tempo from the onset envelope via autocorrelation over [`TEMPO_MIN`, `TEMPO_MAX`] BPM, with an
/// octave correction so very fast tracks don't lock to half tempo.
fn estimate_tempo(env: &[f32], sr: u32) -> (f32, f32) {
    if env.len() < 64 {
        return (0.0, 0.0);
    }
    let fps = sr as f32 / HOP as f32;
    let (m, _) = mean_std(env);
    let e: Vec<f32> = env.iter().map(|x| (x - m).max(0.0)).collect();
    // autocorrelation strength of a candidate tempo
    let ac_at = |bpm: f32| -> f32 {
        let lag = (60.0 * fps / bpm).round() as usize;
        if lag == 0 || lag >= e.len() {
            return 0.0;
        }
        let mut ac = 0.0f32;
        for i in lag..e.len() {
            ac += e[i] * e[i - lag];
        }
        ac
    };
    let (mut best_bpm, mut best_val, mut sum) = (0.0f32, 0.0f32, 0.0f32);
    let mut count = 0.0f32;
    for bpm in TEMPO_MIN..=TEMPO_MAX {
        let ac = ac_at(bpm as f32);
        if ac == 0.0 {
            continue;
        }
        sum += ac;
        count += 1.0;
        if ac > best_val {
            best_val = ac;
            best_bpm = bpm as f32;
        }
    }
    // Octave correction: fast genres usually peak strongest at HALF tempo (every other beat aligns
    // too), so a 204 BPM frenchcore track gets read as ~102. If doubling stays in range and its
    // peak is nearly as strong, take the faster (true) tempo.
    if best_bpm > 0.0 && best_bpm < 110.0 {
        let dbl = best_bpm * 2.0;
        if dbl <= TEMPO_MAX as f32 && ac_at(dbl) >= 0.85 * best_val {
            best_bpm = dbl;
        }
    }
    let avg = if count > 0.0 { sum / count } else { 1.0 };
    let conf = if avg > 0.0 { (best_val / avg - 1.0).clamp(0.0, 1.0) } else { 0.0 };
    (best_bpm, conf)
}

fn onset_density(env: &[f32], sr: u32) -> f32 {
    if env.is_empty() {
        return 0.0;
    }
    let (m, s) = mean_std(env);
    let th = m + s;
    let mut onsets = 0u32;
    for i in 1..env.len() - 1 {
        if env[i] > th && env[i] >= env[i - 1] && env[i] > env[i + 1] {
            onsets += 1;
        }
    }
    let dur = env.len() as f32 * HOP as f32 / sr as f32;
    if dur > 0.0 {
        onsets as f32 / dur
    } else {
        0.0
    }
}

fn crest_factor_db(sig: &[f32]) -> f32 {
    let peak = sig.iter().fold(0.0f32, |a, &x| a.max(x.abs()));
    let rms = (sig.iter().map(|x| x * x).sum::<f32>() / sig.len() as f32).sqrt();
    if rms > 1e-9 {
        20.0 * (peak / rms).log10()
    } else {
        0.0
    }
}

fn chroma_entropy(chroma: &[f32; 12]) -> f32 {
    let sum: f32 = chroma.iter().sum();
    if sum <= 0.0 {
        return 0.0;
    }
    let mut h = 0.0f32;
    for &c in chroma {
        let p = c / sum;
        if p > 0.0 {
            h -= p * p.ln();
        }
    }
    h / (12f32).ln() // normalize to [0,1]
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f32::consts::PI;

    fn sine(freq: f32, sr: u32, secs: f32) -> Vec<f32> {
        let n = (sr as f32 * secs) as usize;
        (0..n).map(|i| (2.0 * PI * freq * i as f32 / sr as f32).sin()).collect()
    }
    fn noise(sr: u32, secs: f32) -> Vec<f32> {
        let n = (sr as f32 * secs) as usize;
        let mut st = 12345u64;
        (0..n)
            .map(|_| {
                st = st.wrapping_mul(6364136223846793005).wrapping_add(1);
                (((st >> 33) as f32) / (1u32 << 31) as f32) * 2.0 - 1.0
            })
            .collect()
    }

    #[test]
    fn tone_is_more_tonal_than_noise() {
        let t = analyze_samples(&sine(220.0, TARGET_SR, 4.0), TARGET_SR);
        let nz = analyze_samples(&noise(TARGET_SR, 4.0), TARGET_SR);
        // flatness mean (dim 32): noise >> tone
        assert!(nz.v[32] > t.v[32], "noise flatness {} should exceed tone {}", nz.v[32], t.v[32]);
        // ZCR mean (dim 36): noise higher; centroid (dim 26): noise brighter
        assert!(nz.v[36] > t.v[36], "noise ZCR {} > tone {}", nz.v[36], t.v[36]);
        assert!(nz.v[26] > t.v[26], "noise centroid {} > tone {}", nz.v[26], t.v[26]);
    }

    #[test]
    fn click_track_tempo_detect() {
        // 120 BPM = a click every 0.5 s
        let sr = TARGET_SR;
        let secs = 12.0;
        let mut sig = vec![0.0f32; (sr as f32 * secs) as usize];
        let period = (sr as f32 * 0.5) as usize;
        let mut i = 0;
        while i < sig.len() {
            for j in 0..200.min(sig.len() - i) {
                sig[i + j] = (1.0 - j as f32 / 200.0) * (2.0 * PI * 1200.0 * j as f32 / sr as f32).sin();
            }
            i += period;
        }
        let f = analyze_samples(&sig, sr);
        let folded = fold_bpm(f.bpm);
        assert!((folded - 120.0).abs() <= 6.0, "expected ~120 BPM, got {} (folded {})", f.bpm, folded);
    }

    #[test]
    fn fast_tempo_not_halved() {
        // 200 BPM = a click every 0.3 s (frenchcore territory). Must NOT be reported as ~100.
        let sr = TARGET_SR;
        let secs = 12.0;
        let mut sig = vec![0.0f32; (sr as f32 * secs) as usize];
        let period = (sr as f32 * 0.3) as usize;
        let mut i = 0;
        while i < sig.len() {
            for j in 0..120.min(sig.len() - i) {
                sig[i + j] = (1.0 - j as f32 / 120.0) * (2.0 * PI * 1200.0 * j as f32 / sr as f32).sin();
            }
            i += period;
        }
        let f = analyze_samples(&sig, sr);
        assert!((f.bpm - 200.0).abs() <= 10.0, "expected ~200 BPM, got {} — likely halved", f.bpm);
    }

    #[test]
    fn analysis_is_faster_than_10x_realtime() {
        let secs = 90.0;
        let sig = noise(TARGET_SR, secs);
        let t = std::time::Instant::now();
        let _ = analyze_samples(&sig, TARGET_SR);
        let el = t.elapsed().as_secs_f32();
        assert!(el < secs / 10.0, "analyzing {secs}s took {el:.2}s (budget {}s)", secs / 10.0);
        println!("analyzed {secs}s in {el:.3}s");
    }
}
