/** Web Audio player engine: one <audio> element feeding a graph
 *  source → preamp → [10 peaking biquads] → analyser → destination.
 *  Runs identically on desktop + Android webviews — no native audio needed.
 *  The EQ is a Poweramp-style 10-band graphic equaliser; the analyser drives
 *  the Avee-style visualiser. */

import {
  naLoad, naPlay, naPause, naSeek, naSetVolume, naState,
  naSetEq, naSetTone, naSetVocal, naSetLoop, naClearLoop, naLoadNext, naCrossfade, naSetOutput,
} from "@/lib/backend";
import { timed } from "@/lib/lagMonitor";
import {
  naSetBalance, naSetMono,
} from "@/lib/backend";

export const EQ_FREQS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

/** webkit2gtk (Linux desktop Tauri webview) has a long-standing bug where routing an <audio> element
 *  through createMediaElementSource() yields SILENCE — the element is captured by Web Audio but never
 *  reaches the output. (Works fine in Safari/WKWebView/Chromium, hence Android + Windows are unaffected.)
 *  When detected we DON'T build the graph and let the <audio> play straight to the system mixer
 *  (GStreamer→PulseAudio/PipeWire), so desktop Linux actually produces sound. Trade-off: the in-webview EQ
 *  + visualiser need that graph, so they're inert here — use Settings → Audio → Native engine (cpal) for
 *  full DSP on Linux. UA: webkit2gtk is "…Linux… AppleWebKit…" with NO Chrome/Chromium token. */
const WEBKIT_GTK_SILENT = typeof navigator !== "undefined"
  && /linux/i.test(navigator.userAgent)
  && /applewebkit/i.test(navigator.userAgent)
  && !/chrome|chromium|android/i.test(navigator.userAgent);

type Listener = () => void;

class PlayerEngine {
  // Two <audio> decks so a crossfade can play the outgoing + incoming tracks AT ONCE (a real blend,
  // not a fade-out→gap→fade-in). The "active" deck is the primary one whose position + events drive
  // playback; with crossfade off only deck A is ever used, so that path is unchanged. [transitions]
  private elA = new Audio();
  private elB = new Audio();
  private deck: "A" | "B" = "A";
  private preloadedUrl: string | null = null; // url buffered into the IDLE deck → an instant-skip swap
  private gainA: GainNode | null = null; // per-deck gain into the shared EQ/DSP chain (crossfade blend)
  private gainB: GainNode | null = null;
  /** The active deck — its currentTime/duration/events ARE "the player". */
  get el(): HTMLAudioElement { return this.deck === "A" ? this.elA : this.elB; }
  private get elIdle(): HTMLAudioElement { return this.deck === "A" ? this.elB : this.elA; }
  private ctx: AudioContext | null = null;
  private preamp: GainNode | null = null;
  private bands: BiquadFilterNode[] = [];
  private _analyser: AnalyserNode | null = null;
  private streamDest: MediaStreamAudioDestinationNode | null = null;
  private eqEnabled = true;
  private bandGains = new Array(EQ_FREQS.length).fill(0);
  private bandFreqs = [...EQ_FREQS];                       // per-band centre freq (adjustable in Advanced)
  private bandQs = new Array(EQ_FREQS.length).fill(1.1);   // per-band Q (band "shape"/width)
  private preampDb = 0;
  // tone + effects
  private bass: BiquadFilterNode | null = null;
  private treble: BiquadFilterNode | null = null;
  private reverbSend: GainNode | null = null;
  private echoSend: GainNode | null = null;
  private masterGain: GainNode | null = null;   // crossfade / track-change fades (separate from el.volume)
  private balanceNode: StereoPannerNode | null = null; // stereo balance (L↔R)
  private stereoGate: GainNode | null = null;   // 1 = stereo passthrough on, 0 = muted (mono active)
  private monoGate: GainNode | null = null;     // 1 = summed-mono path on, 0 = off
  private balanceVal = 0;
  private monoOn = false;
  private vocalCut: GainNode | null = null;     // vocal-fader: negative gain on the band-limited center
  private vocalAmt = 0;                          // 0 = off, 1 = full center cancel
  private rate = 1;
  private pitchLock = true;
  private clipPrevent = true;   // native output: soft limiter @ 0 dBFS
  private ditherBits = 0;       // native output: 0 = off, else 16/24-bit TPDF dither
  private bassDb = 0;
  private trebleDb = 0;
  private reverbAmt = 0;
  private echoAmt = 0;

  private pendingSeek: number | null = null; // a seek requested before the media could accept it
  private timeListeners = new Set<Listener>();
  private endListeners = new Set<Listener>();
  private stateListeners = new Set<Listener>();

  constructor() {
    this.initDeck(this.elA);
    this.initDeck(this.elB);
  }

  /** Wire one deck. Events only count when this deck is the ACTIVE one — so the outgoing deck during a
   *  crossfade never fires `ended` (→ no spurious next-track) or flips the play state. */
  private initDeck(el: HTMLAudioElement) {
    el.preload = "auto";
    // NOTE: crossOrigin is set per-URL in setDeckSrc(), NOT here. A static "anonymous" makes WebKitGTK
    // (Linux/macOS desktop) REQUIRE CORS on the asset:// protocol, which it doesn't satisfy → the audio
    // fails to load and nothing plays. That was the desktop "can't play a track" bug.
    const active = () => el === this.el;
    el.addEventListener("loadedmetadata", () => { if (active()) this.applyPendingSeek(); });
    el.addEventListener("canplay", () => { if (active()) this.applyPendingSeek(); });
    el.addEventListener("progress", () => { if (active()) this.applyPendingSeek(); });
    el.addEventListener("timeupdate", () => { if (active()) this.timeListeners.forEach((l) => l()); });
    el.addEventListener("durationchange", () => { if (active()) this.timeListeners.forEach((l) => l()); });
    el.addEventListener("ended", () => { if (active()) this.endListeners.forEach((l) => l()); });
    el.addEventListener("play", () => { if (active()) this.stateListeners.forEach((l) => l()); });
    el.addEventListener("pause", () => { if (active()) this.stateListeners.forEach((l) => l()); });
  }

  /** Set a deck's src, choosing crossOrigin per-URL: "anonymous" ONLY for genuinely remote http(s) media
   *  (so the analyser can read it untainted); UNSET for local schemes (asset:/blob:/file:/data:) and
   *  loopback stream URLs — WebKitGTK rejects asset:// under a CORS-required load, which broke playback. */
  private setDeckSrc(el: HTMLAudioElement, url: string, stream = false) {
    const isLocal = !/^https?:\/\//i.test(url) || /\b(localhost|127\.0\.0\.1|asset\.localhost|tauri\.localhost)\b/i.test(url);
    // Streams (radio/M3U) usually send NO CORS headers → crossOrigin="anonymous" would block playback.
    // Leave it null so they just play (no Web-Audio analysis for live streams, which is fine).
    el.crossOrigin = isLocal || stream ? null : "anonymous";
    el.src = url;
  }

  /** Lazily build the AudioContext graph (must follow a user gesture on some platforms). */
  private ensureGraph() {
    if (this.ctx) return;
    // webkit2gtk: building the graph (createMediaElementSource) would mute playback — skip it so the
    // <audio> element plays straight to the system output. ctx/_analyser stay null; every graph-dependent
    // path below is guarded by `if (this.ctx …)`, and play()/load() still call el.play() directly.
    if (WEBKIT_GTK_SILENT) return;
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx();
    // Each deck has its own source + gain; both feed the shared EQ/DSP chain so a crossfade blends them
    // through the same processing. With crossfade off, gainB stays 0 and only deck A is heard.
    const srcA = ctx.createMediaElementSource(this.elA);
    const srcB = ctx.createMediaElementSource(this.elB);
    const gainA = ctx.createGain(); gainA.gain.value = this.deck === "A" ? 1 : 0;
    const gainB = ctx.createGain(); gainB.gain.value = this.deck === "B" ? 1 : 0;
    srcA.connect(gainA); srcB.connect(gainB);
    const preamp = ctx.createGain();
    preamp.gain.value = this.dbToGain(this.preampDb);

    // 10 cascaded peaking filters
    const bands = EQ_FREQS.map((f, i) => {
      const b = ctx.createBiquadFilter();
      b.type = "peaking";
      b.frequency.value = this.bandFreqs[i] ?? f;
      b.Q.value = this.bandQs[i] ?? 1.1;
      b.gain.value = this.eqEnabled ? this.bandGains[i] : 0;
      return b;
    });

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    // Mild fixed smoothing; the visualizer adds its OWN per-layer smoothing in JS (it must never
    // write this shared node, or layers + the EQ Spectrum panel would fight over one value).
    analyser.smoothingTimeConstant = 0.5;

    // Vocal fader: subtract a band-limited CENTER (mono) component from both channels — lead vocals
    // sit centered + in the 180–5k band, so this fades them out while keeping stereo bass/cymbals.
    //   out_L = L − k·BP(mid),  out_R = R − k·BP(mid),  mid = (L+R)/2.  k=0 → perfectly transparent.
    const vSplit = ctx.createChannelSplitter(2);
    const vMid = ctx.createGain(); vMid.gain.value = 0.5;          // (L+R)/2
    vSplit.connect(vMid, 0); vSplit.connect(vMid, 1);
    const vHp = ctx.createBiquadFilter(); vHp.type = "highpass"; vHp.frequency.value = 180;
    const vLp = ctx.createBiquadFilter(); vLp.type = "lowpass"; vLp.frequency.value = 5000;
    vMid.connect(vHp); vHp.connect(vLp);
    const vocalCut = ctx.createGain(); vocalCut.gain.value = -this.vocalAmt; // negative = subtract
    vLp.connect(vocalCut);
    const vMerge = ctx.createChannelMerger(2);
    vSplit.connect(vMerge, 0, 0); vSplit.connect(vMerge, 1, 1);    // original L/R through
    vocalCut.connect(vMerge, 0, 0); vocalCut.connect(vMerge, 0, 1); // minus the centered vocal band

    // wire the chain: (deckA|deckB) → preamp → vocal-fader → 10 bands → tone (bass/treble shelves) → mix
    gainA.connect(preamp);
    gainB.connect(preamp);
    preamp.connect(vSplit);
    let node: AudioNode = vMerge;
    for (const b of bands) { node.connect(b); node = b; }

    const bass = ctx.createBiquadFilter();
    bass.type = "lowshelf"; bass.frequency.value = 120; bass.gain.value = this.bassDb;
    const treble = ctx.createBiquadFilter();
    treble.type = "highshelf"; treble.frequency.value = 3500; treble.gain.value = this.trebleDb;
    node.connect(bass); bass.connect(treble);
    const mix: AudioNode = treble;

    // parallel wet sends: reverb (convolver) + echo (delay with feedback)
    const reverb = ctx.createConvolver();
    reverb.buffer = this.makeImpulse(ctx, 2.2, 3.2); // 2.2s tail, exp decay → smooth dark fade-out
    const reverbSend = ctx.createGain(); reverbSend.gain.value = this.reverbAmt;
    mix.connect(reverbSend); reverbSend.connect(reverb);

    const delay = ctx.createDelay(1.0); delay.delayTime.value = 0.3;
    const feedback = ctx.createGain(); feedback.gain.value = 0.35;
    const echoSend = ctx.createGain(); echoSend.gain.value = this.echoAmt;
    mix.connect(echoSend); echoSend.connect(delay); delay.connect(feedback); feedback.connect(delay);

    mix.connect(analyser);     // dry
    reverb.connect(analyser);  // wet reverb
    delay.connect(analyser);   // wet echo

    // master fade gain (crossfade / track-change fades)
    const masterGain = ctx.createGain();
    masterGain.gain.value = 1;
    analyser.connect(masterGain);

    // output stage: balance (stereo pan) feeds two parallel paths — a stereo passthrough and a
    // summed-mono path — each behind a gain "gate" so "mono output" toggles live without a rebuild.
    const balanceNode = ctx.createStereoPanner();
    balanceNode.pan.value = this.balanceVal;
    masterGain.connect(balanceNode);

    const stereoGate = ctx.createGain();
    stereoGate.gain.value = this.monoOn ? 0 : 1;
    balanceNode.connect(stereoGate);
    stereoGate.connect(ctx.destination);

    const monoSplit = ctx.createChannelSplitter(2);
    balanceNode.connect(monoSplit);
    const monoSum = ctx.createGain(); monoSum.gain.value = 0.5;          // (L+R)/2
    monoSplit.connect(monoSum, 0); monoSplit.connect(monoSum, 1);        // both outputs into one input = sum
    const monoMerge = ctx.createChannelMerger(2);
    monoSum.connect(monoMerge, 0, 0); monoSum.connect(monoMerge, 0, 1);  // same mono signal to both channels
    const monoGate = ctx.createGain(); monoGate.gain.value = this.monoOn ? 1 : 0;
    monoMerge.connect(monoGate); monoGate.connect(ctx.destination);

    // a parallel tap so the visualiser export can record the (post-EQ) audio
    const streamDest = ctx.createMediaStreamDestination();
    analyser.connect(streamDest);

    this.ctx = ctx;
    this.gainA = gainA;
    this.gainB = gainB;
    this.preamp = preamp;
    this.bands = bands;
    this.bass = bass;
    this.treble = treble;
    this.reverbSend = reverbSend;
    this.echoSend = echoSend;
    this.masterGain = masterGain;
    this.balanceNode = balanceNode;
    this.stereoGate = stereoGate;
    this.monoGate = monoGate;
    this.vocalCut = vocalCut;
    this._analyser = analyser;
    this.streamDest = streamDest;
    this.applyRate();
  }

  private applyRate() { this.applyRateTo(this.elA); this.applyRateTo(this.elB); }
  private applyRateTo(el: HTMLAudioElement) {
    el.playbackRate = this.rate;
    // preservesPitch keeps vocals natural while changing tempo (vendor-prefixed on older webkit)
    const e = el as HTMLAudioElement & { preservesPitch?: boolean; webkitPreservesPitch?: boolean };
    e.preservesPitch = this.pitchLock;
    e.webkitPreservesPitch = this.pitchLock;
  }

  /** White-noise impulse response with exponential decay → a cheap, dependency-free reverb. */
  /** A smooth, dark reverb impulse. Raw white-noise * polynomial decay (the old version) sounds harsh
   *  and metallic; real rooms decay EXPONENTIALLY and lose highs faster (air absorption). So we damp
   *  the noise with a one-pole low-pass whose cutoff falls as the tail decays, shape it with an
   *  exponential envelope, fade the first few ms in to avoid a click, and normalise per channel. */
  private makeImpulse(ctx: AudioContext, seconds: number, decay: number): AudioBuffer {
    const rate = ctx.sampleRate, len = Math.max(1, Math.floor(rate * seconds));
    const fadeIn = Math.max(1, rate * 0.006); // ~6ms de-click ramp
    const buf = ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let lp = 0, peak = 1e-6;
      for (let i = 0; i < len; i++) {
        const t = i / len;
        // HF damping: low-pass coefficient eases from ~0.55 (open) to ~0.06 (dark) across the tail.
        const cutoff = 0.55 * (1 - t) + 0.06;
        lp += ((Math.random() * 2 - 1) - lp) * cutoff;
        const env = Math.exp(-decay * t) * Math.min(1, i / fadeIn);
        const v = lp * env;
        d[i] = v;
        const a = Math.abs(v); if (a > peak) peak = a;
      }
      const norm = 0.6 / peak; // consistent wet level regardless of the random seed
      for (let i = 0; i < len; i++) d[i] *= norm;
    }
    return buf;
  }

  /** A MediaStream of the live (post-EQ) audio, for muxing into a recorded video. */
  captureStream(): MediaStream | null {
    this.ensureGraph();
    return this.streamDest ? this.streamDest.stream : null;
  }

  private dbToGain(db: number) { return Math.pow(10, db / 20); }

  get analyser(): AnalyserNode | null { return this._analyser; }
  get currentTime() { return this.native ? this.naPos : (this.el.currentTime || 0); }
  get duration() { return this.native ? this.naDur : (Number.isFinite(this.el.duration) ? this.el.duration : 0); }
  get paused() { return this.native ? !this.naPlaying : this.el.paused; }

  // ── audio-info / output routing (Audio Info panel + per-output profiles) ──────
  get sampleRate() { return this.ctx?.sampleRate ?? 0; }
  get blockSize() { return this._analyser?.fftSize ?? 0; }
  get baseLatency() { return this.ctx?.baseLatency ?? 0; }
  get outputLatency() { return (this.ctx as unknown as { outputLatency?: number })?.outputLatency ?? 0; }
  get contextState() { return this.ctx?.state ?? "uninitialised"; }
  get sinkId() { return (this.el as HTMLAudioElement & { sinkId?: string }).sinkId || "default"; }

  /** List selectable audio output devices (empty if the webview blocks enumeration). */
  async listOutputs(): Promise<{ id: string; label: string }[]> {
    try {
      const devs = await navigator.mediaDevices.enumerateDevices();
      return devs.filter((d) => d.kind === "audiooutput").map((d, i) => ({ id: d.deviceId, label: d.label || `Output ${i + 1}` }));
    } catch { return []; }
  }
  /** Route playback to an output device (HTMLMediaElement.setSinkId). False if unsupported. */
  async setOutput(id: string): Promise<boolean> {
    const el = this.el as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
    if (typeof el.setSinkId !== "function") return false;
    try { await el.setSinkId(id); return true; } catch { return false; }
  }

  // ── native engine backend (NATIVE_ENGINE_PLAN S2; desktop, behind a flag) ──
  private native = false;
  private naPos = 0;
  private naDur = 0;
  private naPlaying = false;
  private naTimer: number | null = null;
  private lastLoadMs = 0; // when we last (re)loaded the native deck — suppresses the false "natural end" the
                          // reload transient would otherwise trigger right after a manual skip [skip bug]
  private naVol = 1;

  /** Switch playback backend. ON routes to the native engine (decode→DSP→cpal);
   *  OFF is the `<audio>`/Web Audio path. Takes effect on the next track load. */
  setNativeMode(on: boolean) {
    // desktop-only until slice S4 (Android gets AAudio/oboe); never route Android here.
    if (on && typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent)) on = false;
    if (on === this.native) return;
    this.native = on;
    if (on) {
      this.el.pause();
      this.pushNativeEq();
      this.startNativePoll();
    } else {
      void naPause();
      this.stopNativePoll();
    }
  }
  isNative() { return this.native; }

  /** Native sample-accurate loop (S3): no seam click. Returns true if handled here
   *  (native); false ⇒ the caller should use the Web Audio fallback (rAF seek). */
  setLoopRegion(region: { start: number; end: number } | null): boolean {
    if (!this.native) return false;
    if (region) void naSetLoop(region.start, region.end); else void naClearLoop();
    return true;
  }

  private startNativePoll() {
    if (this.naTimer != null) return;
    const tick = async () => {
      const wasPlaying = this.naPlaying;
      const s = await naState();
      this.naPos = s.position; this.naDur = s.duration; this.naPlaying = s.playing;
      this.timeListeners.forEach((l) => l());
      // natural end: was playing, now stopped at/after the end — but NOT the reload transient right after a
      // manual skip (which momentarily reports stopped near the old track's end → spurious extra advances).
      if (wasPlaying && !s.playing && s.duration > 0 && s.position >= s.duration - 0.25 && Date.now() - this.lastLoadMs > 600) {
        this.endListeners.forEach((l) => l());
      }
    };
    this.naTimer = window.setInterval(() => void tick(), 100);
  }
  private stopNativePoll() {
    if (this.naTimer != null) { clearInterval(this.naTimer); this.naTimer = null; }
  }

  async load(url: string, autoplay = true, path?: string, stream = false) {
    this.lastLoadMs = Date.now(); // mark the (re)load so the poll won't read the transition as a natural end
    // Online streams (http URLs) can't go through the file-based native engine — force the <audio> path.
    if (this.native && path && !stream && !/^https?:\/\//i.test(path)) {
      this.naPos = 0;
      // time the whole native start path → terminal (the prefix decode now makes this ~instant)
      this.naDur = await timed("native-load", () => naLoad(path));
      this.naPlaying = autoplay;
      await naSetVolume(this.naVol);
      this.pushNativeEq();
      if (autoplay) await timed("native-play", () => naPlay()); else await naPause();
      return;
    }
    // Instant-skip fast path: the next track was preloaded into the IDLE deck → just activate it (a deck
    // swap), skipping the fetch + decode a cold load on the active deck would pay. [perf — skip]
    if (autoplay && url && url === this.preloadedUrl && this.ctx && this.gainA && this.gainB) {
      await this.activatePreloaded();
      return;
    }
    this.pendingSeek = null;
    this.setDeckSrc(this.el, url, stream);
    this.el.load();
    // Normalise deck gains: active deck → unity, idle → silent (cancels any in-flight crossfade ramp),
    // so a hard load that INTERRUPTS a crossfade (e.g. skip-spam) plays at full volume, not mid-fade.
    if (this.ctx && this.gainA && this.gainB) {
      const tt = this.ctx.currentTime;
      this.gainA.gain.cancelScheduledValues(tt); this.gainB.gain.cancelScheduledValues(tt);
      this.gainA.gain.setValueAtTime(this.deck === "A" ? 1 : 0, tt);
      this.gainB.gain.setValueAtTime(this.deck === "B" ? 1 : 0, tt);
      // De-click the start: hold the master fade at 0 NOW (while the source still buffers) so the very
      // first samples are silent, then fadeInStart() ramps up once playback actually begins. A fresh
      // source rarely begins on a zero-crossing, so starting at full gain produces an audible pop. [audio]
      if (autoplay && this.masterGain) { this.masterGain.gain.cancelScheduledValues(tt); this.masterGain.gain.setValueAtTime(0, tt); }
    }
    if (autoplay) { await this.play(); this.fadeInStart(); }
  }

  /**
   * Crossfade into the next track. Native: sample-accurate engine crossfade. Web Audio: start the
   * incoming track on the IDLE deck and crossfade the two per-deck gains (a REAL overlap blend, no
   * silent gap), then make the incoming deck active. Returns false if it couldn't (→ caller hard-loads).
   */
  async crossfadeToNext(path: string, ms: number, curve: "linear" | "equal" | "smooth" = "equal"): Promise<boolean> {
    if (this.native) {
      this.naPos = 0;
      await naLoadNext(path);
      this.pushNativeEq();
      this.naPlaying = true;
      await naCrossfade(ms);
      return true;
    }
    this.ensureGraph();
    const ctx = this.ctx;
    if (!ctx || !this.gainA || !this.gainB) return false;
    if (ctx.state === "suspended") await ctx.resume();
    const gOut = this.deck === "A" ? this.gainA : this.gainB;
    const gIn = this.deck === "A" ? this.gainB : this.gainA;
    const incoming = this.elIdle;
    this.pendingSeek = null;
    if (this.preloadedUrl !== path) { this.setDeckSrc(incoming, path); incoming.load(); } // reuse the preloaded buffer if it's this track
    this.preloadedUrl = null;
    incoming.volume = this.naVol;
    this.applyRateTo(incoming);
    if (this.masterGain) { this.masterGain.gain.cancelScheduledValues(ctx.currentTime); this.masterGain.gain.setValueAtTime(1, ctx.currentTime); }
    try { await incoming.play(); } catch { return false; } // autoplay blocked → caller falls back to a hard load
    const t = ctx.currentTime, sec = Math.max(0.05, ms / 1000);
    const N = 48, inC = new Float32Array(N), outC = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const x = i / (N - 1);
      if (curve === "equal") { inC[i] = Math.sin((x * Math.PI) / 2); outC[i] = Math.cos((x * Math.PI) / 2); } // constant-power
      else { const a = curve === "smooth" ? x * x * (3 - 2 * x) : x; inC[i] = a; outC[i] = 1 - a; }
    }
    try {
      gIn.gain.cancelScheduledValues(t); gOut.gain.cancelScheduledValues(t);
      gIn.gain.setValueAtTime(0, t); gOut.gain.setValueAtTime(1, t);
      gIn.gain.setValueCurveAtTime(inC, t, sec); gOut.gain.setValueCurveAtTime(outC, t, sec);
    } catch { gIn.gain.value = 1; gOut.gain.value = 0; }
    const outgoing = this.el;                          // active = outgoing (before the swap)
    this.deck = this.deck === "A" ? "B" : "A";          // incoming is now the primary deck (events follow it)
    window.setTimeout(() => {
      if (outgoing === this.el) return; // a newer/faster skip already reused+reactivated this deck → leave it playing
      try { outgoing.pause(); outgoing.removeAttribute("src"); outgoing.load(); } catch { /* ignore */ }
    }, ms + 150);
    return true;
  }

  /** Warm the NEXT track into the idle deck so a forthcoming skip is instant. Web Audio only (the native
   *  engine has its own gapless preload). Cheap to call repeatedly — no-op if already preloaded. */
  preloadNext(url: string): void {
    if (this.native || !url || url === this.preloadedUrl) return;
    const idle = this.elIdle;
    try { this.setDeckSrc(idle, url); idle.preload = "auto"; idle.load(); idle.pause(); this.preloadedUrl = url; } catch { /* ignore */ }
  }

  /** Activate the preloaded idle deck instantly (deck swap), with the gains set so it's full + the old
   *  deck silent. Used by load() when the target was already buffered. */
  private async activatePreloaded(): Promise<void> {
    const ctx = this.ctx!;
    const incoming = this.elIdle;
    const t = ctx.currentTime;
    const gIn = this.deck === "A" ? this.gainB! : this.gainA!;
    const gOut = this.deck === "A" ? this.gainA! : this.gainB!;
    gIn.gain.cancelScheduledValues(t); gOut.gain.cancelScheduledValues(t);
    gIn.gain.setValueAtTime(1, t); gOut.gain.setValueAtTime(0, t);
    // Same start-of-track de-click as load(): silent until playback begins, then a short fade-in. [audio]
    if (this.masterGain) { this.masterGain.gain.cancelScheduledValues(t); this.masterGain.gain.setValueAtTime(0, t); }
    incoming.volume = this.naVol;
    this.applyRateTo(incoming);
    try { incoming.currentTime = 0; } catch { /* not seekable yet — plays from 0 anyway */ }
    const outgoing = this.el;
    this.deck = this.deck === "A" ? "B" : "A"; // idle deck is now primary
    this.preloadedUrl = null;
    if (ctx.state === "suspended") await ctx.resume();
    try { await incoming.play(); } catch { /* autoplay edge → leave; caller state still set */ }
    this.fadeInStart();
    try { outgoing.pause(); outgoing.removeAttribute("src"); outgoing.load(); } catch { /* ignore */ }
  }

  async play() {
    if (this.native) { this.naPlaying = true; await naPlay(); return; }
    this.ensureGraph();
    if (this.ctx?.state === "suspended") await this.ctx.resume();
    try { await this.el.play(); } catch { /* autoplay blocked until gesture */ }
  }

  pause() {
    if (this.native) { this.naPlaying = false; void naPause(); return; }
    this.el.pause();
    // Suspend the audio graph while paused so the EQ/analyser/effects nodes aren't clocked for nothing
    // — meaningful battery saving in the background. play() resumes it (the <audio> element keeps the
    // position independently, so the lock-screen scrubber is unaffected).
    if (this.ctx && this.ctx.state === "running") void this.ctx.suspend();
  }
  toggle() { return this.paused ? this.play() : (this.pause(), Promise.resolve()); }
  seek(sec: number) {
    const t = Math.max(0, Math.min(this.duration || sec, sec));
    if (this.native) { this.naPos = t; void naSeek(t); return; }
    // If the element can't seek yet (no metadata / not seekable — common right after load() on a fresh
    // source), setting currentTime is dropped and skip-intro/skip-to-drop silently fails (track plays
    // from 0). Queue it and apply the instant it becomes seekable, so the jump lands with no "load" wait.
    if (this.el.readyState < 1 || !this.canSeekTo(t)) { this.pendingSeek = t; return; } // applied by applyPendingSeek()
    this.el.currentTime = t;
  }
  /** Apply a queued seek once the media can accept it (wired to loadedmetadata/canplay/progress). */
  private applyPendingSeek = () => {
    if (this.pendingSeek == null) return;
    if (this.canSeekTo(this.pendingSeek)) { this.el.currentTime = this.pendingSeek; this.pendingSeek = null; }
  };
  /** Is `t` inside a buffered/seekable range yet? (Avoids a no-op currentTime set that gets clamped.) */
  private canSeekTo(t: number): boolean {
    const s = this.el.seekable;
    if (s && s.length) { for (let i = 0; i < s.length; i++) if (t >= s.start(i) - 0.01 && t <= s.end(i) + 0.01) return true; return false; }
    return this.el.readyState >= 1; // no seekable info → trust metadata-ready
  }
  setVolume(v: number) {
    const vol = Math.max(0, Math.min(1, v));
    this.naVol = vol;
    if (this.native) { void naSetVolume(vol); return; }
    this.elA.volume = vol; this.elB.volume = vol; // both decks (idle one inherits it when it goes active)
  }

  // ── EQ ──
  /** Push the full EQ/tone/vocal state to the native engine (called when native). */
  private pushNativeEq() {
    if (!this.native) return;
    void naSetEq(this.eqEnabled, this.preampDb, this.bandGains.slice(), this.bandFreqs.slice(), this.bandQs.slice());
    void naSetTone(this.bassDb, this.trebleDb);
    void naSetVocal(this.vocalAmt);
    void naSetOutput(this.clipPrevent, this.ditherBits);
    void naSetBalance(this.balanceVal);
    void naSetMono(this.monoOn);
  }
  /** Native output stage: clip prevention + dither (no-op on the Web Audio path). */
  setOutputStage(clipPrevent: boolean, ditherBits: number) {
    this.clipPrevent = clipPrevent; this.ditherBits = ditherBits;
    if (this.native) void naSetOutput(clipPrevent, ditherBits);
  }
  setBand(i: number, db: number) {
    this.bandGains[i] = db;
    if (this.bands[i] && this.eqEnabled) this.bands[i].gain.value = db;
    this.pushNativeEq();
  }
  setPreamp(db: number) {
    this.preampDb = db;
    if (this.preamp) this.preamp.gain.value = this.dbToGain(db);
    this.pushNativeEq();
  }
  /** Vocal fader: 0 = off (transparent), 1 = full centered-vocal cancel. ~1.1 over-cancels for stubborn mixes. */
  setVocal(amount: number) {
    this.vocalAmt = Math.max(0, Math.min(1.2, amount));
    if (this.vocalCut) this.vocalCut.gain.value = -this.vocalAmt;
    if (this.native) void naSetVocal(this.vocalAmt);
  }
  get vocal() { return this.vocalAmt; }
  setEqEnabled(on: boolean) {
    this.eqEnabled = on;
    this.bands.forEach((b, i) => { b.gain.value = on ? this.bandGains[i] : 0; });
    this.pushNativeEq();
  }
  setEqFreq(i: number, hz: number) {
    this.bandFreqs[i] = hz;
    if (this.bands[i]) this.bands[i].frequency.value = hz;
    this.pushNativeEq();
  }
  setEqQ(i: number, q: number) {
    this.bandQs[i] = q;
    if (this.bands[i]) this.bands[i].Q.value = q;
    this.pushNativeEq();
  }
  applyPreset(gains: number[], preamp: number, enabled: boolean) {
    gains.forEach((g, i) => { this.bandGains[i] = g; });
    this.preampDb = preamp;
    this.eqEnabled = enabled;
    if (this.preamp) this.preamp.gain.value = this.dbToGain(preamp);
    this.bands.forEach((b, i) => { b.gain.value = enabled ? this.bandGains[i] : 0; });
    this.pushNativeEq();
  }

  // ── speed / pitch / crossfade ──
  setRate(rate: number) { this.rate = Math.max(0.25, Math.min(4, rate)); this.applyRate(); }
  setPitchLock(on: boolean) { this.pitchLock = on; this.applyRate(); }
  /** Ramp the master fade gain to `target` over `ms`, shaped by `curve`; resolves when done.
   *  equal = equal-power (sin), smooth = smoothstep — both keep a constant-energy crossfade. */
  fadeTo(target: number, ms: number, curve: "linear" | "equal" | "smooth" = "linear"): Promise<void> {
    if (!this.ctx || !this.masterGain || ms <= 0) { if (this.masterGain) this.masterGain.gain.value = target; return Promise.resolve(); }
    const g = this.masterGain.gain, now = this.ctx.currentTime, from = g.value;
    g.cancelScheduledValues(now); g.setValueAtTime(from, now);
    if (curve === "linear") {
      g.linearRampToValueAtTime(target, now + ms / 1000);
    } else {
      const N = 32, arr = new Float32Array(N + 1);
      for (let i = 0; i <= N; i++) {
        const x = i / N;
        const shaped = curve === "equal" ? Math.sin((x * Math.PI) / 2) : x * x * (3 - 2 * x);
        arr[i] = from + (target - from) * shaped;
      }
      g.setValueCurveAtTime(arr, now, ms / 1000);
    }
    return new Promise((res) => setTimeout(res, ms));
  }

  /** Short de-click fade-in applied right after a hard load / preloaded-deck activation begins playing.
   *  Ramps the master fade from its current value (0, set just before play) up to unity over a few ms,
   *  so the leading edge of a fresh source can't pop. Always lands at 1, so it self-heals even if the
   *  preceding play() was blocked. No-op without the audio graph (native path / pre-gesture). */
  private fadeInStart(ms = 22) {
    if (!this.ctx || !this.masterGain) return;
    const t = this.ctx.currentTime;
    const g = this.masterGain.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(Math.max(0, g.value), t);
    g.linearRampToValueAtTime(1, t + ms / 1000);
  }

  // ── tone + effects ──
  setBass(db: number) { this.bassDb = db; if (this.bass) this.bass.gain.value = db; if (this.native) void naSetTone(this.bassDb, this.trebleDb); }
  setTreble(db: number) { this.trebleDb = db; if (this.treble) this.treble.gain.value = db; if (this.native) void naSetTone(this.bassDb, this.trebleDb); }
  /** Stereo balance: -1 = full left, 0 = center, 1 = full right. Web Audio path only. */
  setBalance(v: number) { this.balanceVal = Math.max(-1, Math.min(1, v)); if (this.balanceNode) this.balanceNode.pan.value = this.balanceVal; if (this.native) void naSetBalance(this.balanceVal); }
  /** Sum both channels to mono (single earbud / accessibility). Applies on both backends. */
  setMono(on: boolean) { this.monoOn = on; if (this.stereoGate) this.stereoGate.gain.value = on ? 0 : 1; if (this.monoGate) this.monoGate.gain.value = on ? 1 : 0; if (this.native) void naSetMono(on); }
  setReverb(amount: number) { this.reverbAmt = amount; if (this.reverbSend) this.reverbSend.gain.value = amount; }
  setEcho(amount: number) { this.echoAmt = amount; if (this.echoSend) this.echoSend.gain.value = amount; }

  // ── subscriptions ──
  onTime(l: Listener) { this.timeListeners.add(l); return () => this.timeListeners.delete(l); }
  onEnded(l: Listener) { this.endListeners.add(l); return () => this.endListeners.delete(l); }
  onState(l: Listener) { this.stateListeners.add(l); return () => this.stateListeners.delete(l); }
}

/** Single shared engine instance. */
export const engine = new PlayerEngine();
