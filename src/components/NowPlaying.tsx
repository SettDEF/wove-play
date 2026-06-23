import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { usePlayer } from "@/store/player";
import { useViz } from "@/store/viz";
import { useNpLayout } from "@/store/npLayout";
import { useRatings } from "@/store/ratings";
import { useCover } from "./Cover";
import { buzz } from "@/lib/touch";
import { Sheet } from "./Sheet";
import { Icon } from "./Icons";
import { Seekbar } from "./Seekbar";
import { WaveSeek } from "./WaveSeek";
import { SongSeek } from "./SongSeek";
import { SquiggleSeek } from "./SquiggleSeek";
import { CrossArt } from "./CrossArt";
import { ArtistLinks } from "./ArtistLinks";
import { SectionStrip } from "./SectionStrip";
import { analyzeTrack, peekAnalysis, type TrackAnalysis, type Section } from "@/lib/trackAnalysis";
import { fileUrl, hasTauri, isWebkitGtk, analyzeTrackNative, waveformNative, openUrl, type NativeAnalysis } from "@/lib/backend";
import { engine } from "@/audio/engine";
import { sampleLive, liveSections } from "@/lib/liveSections";
import { useMixId, detectMix } from "@/store/mixId";
import * as taste from "@/lib/taste";
import { toast } from "@/store/toasts";
import { useSettings } from "@/store/settings";
import { Visualizer } from "./Visualizer";
import { QueueSheet } from "./QueueSheet";
import { TrackActions } from "./TrackActions";
import { SectionsEditor } from "./SectionsEditor";
import { useSectionEdits } from "@/store/sectionEdits";
import { NpCustomize } from "./NpCustomize";
import { VinylCover } from "./VinylCover";
import { SHOW_VISUALIZER } from "@/lib/features";
import { LyricsView } from "./LyricsView";
import { fmtTime } from "@/lib/format";
import { SoundDna } from "./SoundDna";
import { dnaHue } from "@/lib/soundDna";
import { AudioInfo } from "./AudioInfo";
import { CastSheet } from "./CastSheet";
import { CoverPicker } from "./CoverPicker";
import { pluginName } from "@/lib/outputConfig";

type View = "art" | "viz" | "lyrics";

// Native analysis per track id, kept ACROSS player open/close (the component unmounts on tab switch).
// Without this the sections re-fetched + flashed empty every time you re-entered the player.
const natCache = new Map<string, NativeAnalysis | null>();
const wavePeaksCache = new Map<string, number[]>(); // desktop real waveform peaks per track id (survives unmount)
const EMPTY_SECS: Section[] = []; // stable ref so the mixId selector doesn't churn renders

export function NowPlaying() {
  const t = usePlayer((s) => s.current());
  const playing = usePlayer((s) => s.playing);
  // NOTE: `position` is intentionally NOT subscribed here — it ticks several times a second and would
  // re-render this whole (large) screen each time. The seekbar + lyrics read it in isolated children
  // (NpSeek / NpLyrics below) so only that small subtree repaints per tick. [perf P0]
  const duration = usePlayer((s) => s.duration);
  const loop = usePlayer((s) => s.loop);
  const setLoop = usePlayer((s) => s.setLoop);
  const repeat = usePlayer((s) => s.repeat);
  const shuffle = usePlayer((s) => s.shuffle);
  const endless = usePlayer((s) => s.endless);
  const index = usePlayer((s) => s.index);
  const upcoming = endless ? endless.transitions[index] : null; // planned transition out of THIS track
  const { toggle, next, prev, seek, cycleRepeat, toggleShuffle } = usePlayer.getState();
  const setFullscreen = useViz((s) => s.setFullscreen);
  const layout = useNpLayout();
  const seekStyle = useSettings((s) => s.seekStyle);
  const audioSections = useSettings((s) => s.audioSections); // master switch: sections strip + skip-intro
  const showBpm = useSettings((s) => s.showBpm);
  const bpmAlgo = useSettings((s) => s.bpmAlgo);
  const sectionAlgo = useSettings((s) => s.sectionAlgo);
  const soundDna = useSettings((s) => s.soundDna);
  const playQueue = usePlayer((s) => s.queue);
  const libCount = usePlayer((s) => s.library.length);
  const npFooter = useSettings((s) => s.npFooter);
  const outputDefault = useSettings((s) => s.output.defaultPlugin);
  const art = useCover(t?.path);
  // "The seekbar is the song": decode + analyse the current track in the webview → real waveform +
  // energy sections painted on the scrubber (cached per track id).
  // Seed from the in-memory caches so re-opening the player shows the SAME waveform + sections instantly
  // — no re-decode, no flash of empty segments. (`peekAnalysis`/`natCache` survive the unmount on tab
  // switch; the heavy passes below only run the first time a track is analysed.)
  const [analysis, setAnalysis] = useState<TrackAnalysis | null>(() => (t ? peekAnalysis(t.id) ?? null : null));
  // Native analysis (Analysis v2): genre-robust BPM + Camelot key, cached on disk + in natCache.
  const [nat, setNat] = useState<NativeAnalysis | null>(() => (t ? natCache.get(t.id) ?? null : null));
  // Desktop (webkit2gtk) real waveform peaks for the segment bars (the webview decode is skipped there).
  const [natPeaks, setNatPeaks] = useState<number[] | null>(() => (t ? wavePeaksCache.get(t.id) ?? null : null));
  useEffect(() => {
    const cur = usePlayer.getState().current();
    if (!cur || !hasTauri) { setAnalysis(null); setNat(null); setNatPeaks(null); return; }
    let alive = true;
    let skipped = false; // skip-intro fires once, from whichever analyzer resolves first
    // Skip-intro from the native sections (only ever near a track's start, so re-opening mid-track is safe).
    const trySkip = (a: NativeAnalysis | null) => {
      if (skipped || !a?.sections?.length || !useSettings.getState().skipIntros || !useSettings.getState().audioSections) return;
      const p = usePlayer.getState();
      const d = p.duration || a.duration || 0;
      const target = a.sections.find((s) => s.energy >= 0.4 && s.start > d * 0.01 && s.start < d * 0.34);
      if (target && p.position < 5 && target.start > p.position + 1) { skipped = true; p.seek(target.start); }
    };
    // Native analysis: instant from cache, else fetch (disk-cached on the Rust side) once and remember.
    // When UNCACHED, defer it ~350ms so rapid skipping (cleanup fires per skip) doesn't kick off a fresh
    // native analysis for every track flown past — it only runs once you SETTLE on a track. [perf — skip]
    const cachedNat = natCache.get(cur.id);
    let natTimer = 0;
    if (natCache.has(cur.id)) { setNat(cachedNat ?? null); trySkip(cachedNat ?? null); }
    else {
      setNat(null);
      natTimer = window.setTimeout(() => {
        analyzeTrackNative(cur.path).then((a) => { if (!alive) return; natCache.set(cur.id, a); setNat(a); trySkip(a); });
      }, 350);
    }
    // Webview decode + full-sample passes are heavy (reads the WHOLE file off possibly-SD storage); doing
    // it as a track starts fights audio buffering → stutter. So: show the cached result immediately, and
    // only when UNCACHED defer the work past the open animation + to an idle moment. Cached per id.
    const cachedAna = peekAnalysis(cur.id);
    setAnalysis(cachedAna ?? null);
    let idleId = 0;
    let timer = 0;
    setNatPeaks(wavePeaksCache.get(cur.id) ?? null); // seed from cache; the fetch is opt-in (Waveform style only)
    // webkit2gtk (Linux desktop) blocks the main thread for SECONDS on decodeAudioData of a whole file —
    // the 10s player stall the lag monitor caught. Skip the webview waveform analysis there; the seekbar
    // falls back to the cheap synthetic WaveSeek and the native pass still drives BPM/key/sections.
    if (cachedAna === undefined && !isWebkitGtk) {
      const runAnalysis = () => {
        if (!alive) return;
        fileUrl(cur.path).then((url) => analyzeTrack(cur.id, url, useSettings.getState().bpmAlgo === "fast", () => alive)).then((a) => {
          if (!alive) return;
          setAnalysis(a);
          // fallback skip-intro from the webview energy sections (e.g. native not analysed yet)
          if (a && !skipped && useSettings.getState().skipIntros && useSettings.getState().audioSections) {
            const p = usePlayer.getState();
            const target = a.sections.find((s) => s.tier >= 1 && s.start > 0.01 && s.start < 0.34);
            if (target && p.position < 5) {
              const v = target.start * (p.duration || 0);
              if (v > p.position + 1) { skipped = true; p.seek(v); }
            }
          }
        });
      };
      timer = window.setTimeout(() => {
        if (typeof requestIdleCallback === "function") idleId = requestIdleCallback(runAnalysis, { timeout: 4000 });
        else runAnalysis();
      }, 500);
    }
    return () => { alive = false; if (natTimer) clearTimeout(natTimer); if (timer) clearTimeout(timer); if (idleId && typeof cancelIdleCallback === "function") cancelIdleCallback(idleId); };
  }, [t?.id]);

  // Real waveform peaks for the "Waveform" seek style ONLY — fetched natively (off the GTK main thread)
  // and IMMEDIATELY when that style is selected (or the track changes). The default "sections" + the other
  // styles are untouched, so the native waveform is purely opt-in. Desktop only (Android already has peaks).
  useEffect(() => {
    const cur = t;
    if (!cur || !hasTauri || seekStyle !== "waveform" || !isWebkitGtk) return;
    const hit = wavePeaksCache.get(cur.id);
    if (hit) { setNatPeaks(hit); return; }
    let alive = true;
    void waveformNative(cur.path, 480).then((p) => { if (alive && p?.length) { wavePeaksCache.set(cur.id, p); setNatPeaks(p); } });
    return () => { alive = false; };
  }, [t?.id, seekStyle]);
  // Phase 2 — LIVE sections: while a track plays, fold the analyser's energy into a provisional
  // structure map (shown until the precise pass lands). Cheap: one freq read every 300ms.
  useEffect(() => {
    if (!playing || !audioSections) return; // sections off → no live-structure sampling
    const iv = window.setInterval(() => {
      const cur = usePlayer.getState().current();
      if (cur && !engine.paused) sampleLive(cur.id, engine.currentTime);
    }, 300);
    return () => clearInterval(iv);
  }, [playing, t?.id, audioSections]);
  // BPM algorithm (Settings → Audio): "native" = genre-robust beatgrid, "fast" = webview autocorrelation.
  const natBpm = nat && nat.bpm > 0 ? Math.round(nat.bpm) : 0;
  const fastBpm = analysis && analysis.bpm > 0 ? analysis.bpm : 0;
  const bpm = bpmAlgo === "fast" ? (fastBpm || natBpm) : (natBpm || fastBpm);
  // Section algorithm: "structural" = native SSM/Foote, "energy" = webview energy tiers.
  const seekSections = useMemo(() => {
    if (!audioSections) return []; // sections turned off → none anywhere
    if (sectionAlgo === "structural" && nat?.sections?.length && duration > 0) {
      return nat.sections.map((s) => ({
        start: s.start / duration,
        end: s.end / duration,
        tier: (s.energy >= 0.72 ? 2 : s.energy >= 0.4 ? 1 : 0) as 0 | 1 | 2,
        label: s.label,
      }));
    }
    return analysis?.sections ?? [];
  }, [nat, analysis, duration, sectionAlgo, audioSections]);
  // user edits to this track's sections override detection everywhere (seekbar + editor)
  const secOverride = useSectionEdits((s) => (t ? s.edits[t.id] : undefined));
  // Phase 3 — in a long mix with mix-ID on, the identified library tracks BECOME the sections (labelled
  // with their titles). Falls back to detected structure when nothing's identified.
  const mixSections = useMixId((s) => (t && s.mixId === t.id ? s.sections : EMPTY_SECS));
  useEffect(() => { void detectMix(t ?? null); }, [t?.id]);
  const shownSections = !audioSections ? EMPTY_SECS : (secOverride ?? (mixSections.length >= 2 ? mixSections : seekSections));
  const [view, setView] = useState<View>("art");
  const [queue, setQueue] = useState(false);
  const [actions, setActions] = useState(false);
  const [coverMenu, setCoverMenu] = useState<{ x: number; y: number } | null>(null);
  const [coverPick, setCoverPick] = useState(false);
  const [artistMenu, setArtistMenu] = useState<{ name: string; x: number; y: number } | null>(null);
  const [customize, setCustomize] = useState(false);
  // Pause the visualizers' 60fps render loop whenever a sheet/menu covers the player — saves CPU/GPU
  // (and avoids audio stutter) while the queue etc. is open.
  const [shufMenu, setShufMenu] = useState(false); // hold-shuffle smart menu
  const [secEdit, setSecEdit] = useState(false);   // hold-timeline → fullscreen sections editor
  const [audioInfo, setAudioInfo] = useState(false); // hold-footer → Audio Info pipeline panel
  const [cast, setCast] = useState(false);         // cast-to-device picker
  const [fIdx, setFIdx] = useState(0);             // which footer info line is showing
  // NOTE: no back-guards here — these overlays (TrackActions, AudioInfo, CastSheet, NpCustomize,
  // QueueSheet, SectionsEditor) each self-guard on mount, so the back button closes them automatically.
  const overlayOpen = queue || actions || customize || shufMenu || secEdit || audioInfo || cast;

  // ── Now-Playing footer: a cycling status line (tap → next line, hold → Audio Info) ──────────
  const fHoldTimer = useRef<number | null>(null);
  const fHeld = useRef(false);
  const fDown = () => { fHeld.current = false; fHoldTimer.current = window.setTimeout(() => { fHeld.current = true; buzz(14); setAudioInfo(true); }, 420); };
  const fUp = () => { if (fHoldTimer.current) { clearTimeout(fHoldTimer.current); fHoldTimer.current = null; } };
  const fTap = () => { if (fHeld.current) { fHeld.current = false; return; } setFIdx((i) => i + 1); };
  const footer = (() => {
    if (!t) return null;
    const modes = npFooter.length ? npFooter : (["queue"] as const);
    const mode = modes[fIdx % modes.length];
    const dirOf = (p: string) => { const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\")); return i > 0 ? p.slice(0, i) : p; };
    const ext = (t.path.split(/[\\/]/).pop()?.split(".").pop() || "").toUpperCase();
    switch (mode) {
      case "path": { const d = t.folder || dirOf(t.path); return { icon: "folder", text: d.split(/[\\/]/).filter(Boolean).pop() || d }; }
      case "next": { const nx = playQueue[index + 1]; return { icon: "playNextIcon", text: nx ? nx.title : "End of queue" }; }
      case "format": return { icon: "graphicEq", text: `${ext}${duration ? ` · ${fmtTime(duration)}` : ""}` };
      case "output": return { icon: "volume", text: pluginName(outputDefault) };
      default: return { icon: "queue", text: `${index >= 0 ? index + 1 : 0} / ${playQueue.length || libCount}` };
    }
  })();
  const swipe = useRef<{ x: number; y: number } | null>(null);
  const [dragX, setDragX] = useState(0);   // live horizontal drag of the cover (follows your finger)
  const [dragY, setDragY] = useState(0);   // live DOWNWARD drag → pull-to-dismiss the player
  const dragging = useRef(false);
  const dragAxis = useRef<null | "h" | "v">(null); // lock to one axis once the gesture commits
  const SKIP = 64;                          // px past which a release skips the track
  const CLOSE = 120;                        // px pull-down past which a release closes the player

  // Hold the Play/Pause button → restart the track from 0 (a fill-ring sweeps while you hold).
  const HOLD_MS = 500;
  const [holding, setHolding] = useState(false);
  const holdTimer = useRef<number | null>(null);
  const holdFired = useRef(false);
  const fabDown = () => {
    holdFired.current = false; setHolding(true);
    holdTimer.current = window.setTimeout(() => { holdFired.current = true; setHolding(false); seek(0); buzz(18); }, HOLD_MS);
  };
  const fabUp = () => { if (holdTimer.current) { clearTimeout(holdTimer.current); holdTimer.current = null; } setHolding(false); };
  const fabClick = () => { if (holdFired.current) { holdFired.current = false; return; } toggle(); };

  // Hold ⏭/⏮ → scrub within the track (accelerating); a tap still skips tracks.
  const scrubStart = useRef<number | null>(null);
  const scrubInt = useRef<number | null>(null);
  const scrubPos = useRef(0);
  const scrubbed = useRef(false);
  const beginScrub = (dir: 1 | -1) => {
    scrubbed.current = false;
    scrubStart.current = window.setTimeout(() => {
      scrubbed.current = true; buzz(10);
      scrubPos.current = usePlayer.getState().position;
      let step = 1.5;
      scrubInt.current = window.setInterval(() => {
        const dur = usePlayer.getState().duration || 1;
        scrubPos.current = Math.max(0, Math.min(dur, scrubPos.current + dir * step));
        seek(scrubPos.current);
        step = Math.min(15, step * 1.18); // accelerate
      }, 130);
    }, 300);
  };
  const endScrub = () => {
    if (scrubStart.current) { clearTimeout(scrubStart.current); scrubStart.current = null; }
    if (scrubInt.current) { clearInterval(scrubInt.current); scrubInt.current = null; }
  };
  const prevTap = () => { if (scrubbed.current) { scrubbed.current = false; return; } prev(); };
  const nextTap = () => { if (scrubbed.current) { scrubbed.current = false; return; } next(); };

  // Hold repeat → set an A–B loop point. First hold drops A, second drops B; if a loop exists, hold clears it.
  const abA = useRef<number | null>(null);
  const repHoldTimer = useRef<number | null>(null);
  const repHeld = useRef(false);
  const repDown = () => {
    repHeld.current = false;
    repHoldTimer.current = window.setTimeout(() => {
      repHeld.current = true; buzz(14);
      if (loop) { setLoop(null); abA.current = null; toast.info("A–B loop cleared"); return; }
      const pos = usePlayer.getState().position;
      if (abA.current == null) { abA.current = pos; toast.success(`Loop A set · ${fmtTime(pos)}`); }
      else {
        const a = abA.current, b = pos; abA.current = null;
        setLoop({ start: Math.min(a, b), end: Math.max(a, b) });
        toast.success(`A–B loop · ${fmtTime(Math.min(a, b))}–${fmtTime(Math.max(a, b))}`);
      }
    }, 450);
  };
  const repUp = () => { if (repHoldTimer.current) { clearTimeout(repHoldTimer.current); repHoldTimer.current = null; } };
  const repTap = () => { if (repHeld.current) { repHeld.current = false; return; } cycleRepeat(); };

  // Hold shuffle → a smart-shuffle menu (all / similar / artist); tap toggles plain shuffle.
  const shufHoldTimer = useRef<number | null>(null);
  const shufHeld = useRef(false);
  const shufDown = () => { shufHeld.current = false; shufHoldTimer.current = window.setTimeout(() => { shufHeld.current = true; buzz(14); setShufMenu(true); }, 450); };
  const shufUp = () => { if (shufHoldTimer.current) { clearTimeout(shufHoldTimer.current); shufHoldTimer.current = null; } };
  const shufTap = () => { if (shufHeld.current) { shufHeld.current = false; return; } toggleShuffle(); };
  const shuffleAll = () => {
    const q = [...usePlayer.getState().library];
    for (let i = q.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [q[i], q[j]] = [q[j], q[i]]; }
    if (q.length) usePlayer.getState().playFrom(q, 0);
    setShufMenu(false); toast.success(`Shuffling ${q.length} songs`);
  };
  const shuffleArtist = () => {
    const cur = usePlayer.getState().current(); if (!cur) return;
    const q = usePlayer.getState().library.filter((x) => x.artist === cur.artist);
    for (let i = q.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [q[i], q[j]] = [q[j], q[i]]; }
    if (q.length) usePlayer.getState().playFrom(q, 0);
    setShufMenu(false); toast.success(`Shuffling ${cur.artist}`);
  };
  const shuffleSimilar = async () => {
    setShufMenu(false);
    const cur = usePlayer.getState().current(); if (!cur || !hasTauri) return;
    const sim = await taste.similar(cur.id, 80);
    const byId = new Map(usePlayer.getState().library.map((x) => [x.id, x]));
    const q = [cur, ...sim.map(([id]) => byId.get(id)).filter((x): x is typeof cur => !!x && x.id !== cur.id)];
    if (q.length < 2) { toast.info("Analyze your library in Settings → For You first."); return; }
    usePlayer.getState().playFrom(q, 0); toast.success(`Shuffling ${q.length} similar songs`);
  };
  // Long-press the cover → the track options menu (Radio / More-like-this lives inside it).
  const lpTimer = useRef<number | null>(null);
  const lpFired = useRef(false);
  const clearLp = () => { if (lpTimer.current != null) { clearTimeout(lpTimer.current); lpTimer.current = null; } };

  const onTouchStart = (e: React.TouchEvent) => {
    const t0 = e.touches[0]; swipe.current = { x: t0.clientX, y: t0.clientY };
    lpFired.current = false; dragAxis.current = null; clearLp();
    if (view === "art") lpTimer.current = window.setTimeout(() => { lpFired.current = true; buzz(14); setActions(true); }, 500);
  };
  const onTouchMove = (e: React.TouchEvent) => {
    const s = swipe.current; if (!s) return;
    const dx = e.touches[0].clientX - s.x, dy = e.touches[0].clientY - s.y;
    if (Math.abs(dx) > 10 || Math.abs(dy) > 10) clearLp(); // moved → it's a swipe, not a hold
    // commit to one axis on the first real movement (so a horizontal flick and a downward pull don't fight)
    if (!dragAxis.current && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) dragAxis.current = Math.abs(dx) > Math.abs(dy) ? "h" : "v";
    if (dragAxis.current === "h") {
      // horizontal → the cover follows your finger live (rubber-banded), like flicking a card.
      dragging.current = true;
      setDragX(Math.max(-160, Math.min(160, dx * 0.9)));
    } else if (dragAxis.current === "v" && dy > 0) {
      // downward → pull-to-dismiss: the whole player follows your finger (rubber-banded).
      dragging.current = true;
      setDragY(Math.min(420, dy));
    }
  };
  const coverTapGuard = useRef(false); // suppress the click that follows a drag / long-press
  const onTouchEnd = (e: React.TouchEvent) => {
    clearLp();
    const s = swipe.current; swipe.current = null;
    const wasDragging = dragging.current; dragging.current = false;
    const axis = dragAxis.current; dragAxis.current = null;
    coverTapGuard.current = wasDragging || lpFired.current;
    const pulledY = dragY;
    setDragX(0); setDragY(0); // spring back (the new track's cover springs in if we skip)
    if (lpFired.current || !s) return; // long-press already handled → don't also swipe
    const dx = e.changedTouches[0].clientX - s.x, dy = e.changedTouches[0].clientY - s.y;
    // pull-down past the threshold → close the player and reveal the track in its list.
    if (axis === "v" && pulledY > CLOSE) { usePlayer.getState().leavePlayer(); return; }
    if (axis === "h" && Math.abs(dx) > SKIP && Math.abs(dx) > Math.abs(dy) * 1.2) {
      if (dx < 0) usePlayer.getState().next(); else usePlayer.getState().prev();
    }
  };

  if (!t) {
    return <div className="wp-screen wp-empty"><Icon name="music" size={48} color="var(--md-on-surface-variant)" />
      <div className="md-title-m">Nothing playing</div>
      <div className="md-body-m wp-muted">Pick a track from your library.</div></div>;
  }

  // Visualizer gated by the release feature flag: never show the viz view, and fall a saved "viz"
  // background back to blurred art. [release]
  const showViz = SHOW_VISUALIZER && layout.showViz;
  const npBg = (!SHOW_VISUALIZER && layout.bg === "viz") ? "blur" : layout.bg;
  return (
    <div className={`wp-screen wp-np wp-np-bg-${npBg} wp-np-dim-${layout.bgDim} wp-np-acc-${layout.accent} wp-np-ctrl-${layout.controls} ${layout.compact ? "wp-np-compact" : ""}`}
      style={{
        // Accent "from art": derive a stable hue from the track path so the FAB / glow / active controls
        // pick up the cover's colour. "theme" leaves --np-accent unset → falls back to --md-primary in CSS.
        ...(layout.accent === "art" ? { "--np-accent": `hsl(${dnaHue(t.path)} 72% 56%)` } as React.CSSProperties : {}),
        ...(dragY ? { transform: `translateY(${dragY}px)`, opacity: 1 - Math.min(0.5, dragY / 600), transition: dragging.current ? "none" : "transform .3s cubic-bezier(.2,.9,.2,1), opacity .3s" } : {}),
      }}>
      {npBg === "blur" && art && <div className="wp-np-backdrop"><div className="wp-np-backdrop-img" style={{ backgroundImage: `url(${art})` }} /></div>}
      {SHOW_VISUALIZER && npBg === "viz" && <div className="wp-np-backdrop wp-np-backdrop-viz"><Visualizer showText={false} paused={overlayOpen} /></div>}

      <div className={`wp-np-stage wp-shape-${layout.shape} ${layout.bigArt ? "wp-np-stage-big" : ""} ${layout.glow ? "wp-np-glow" : ""} ${layout.spinArt && playing ? "wp-np-spinart" : ""} ${view === "lyrics" ? "wp-np-stage-lyrics" : ""}`}
        onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd}
        style={{
          transform: dragX ? `translateX(${dragX}px) rotate(${dragX * 0.03}deg)` : undefined,
          transition: dragging.current ? "none" : "transform .3s cubic-bezier(.2,.9,.2,1)",
          opacity: 1 - Math.min(0.35, Math.abs(dragX) / 460),
        }}
        onClick={() => { if (coverTapGuard.current) { coverTapGuard.current = false; return; } if (view === "viz") setFullscreen(true); else usePlayer.getState().revealCurrent(); }}
        onContextMenu={(e) => { e.preventDefault(); setCoverMenu({ x: Math.min(e.clientX, window.innerWidth - 210), y: Math.min(e.clientY, window.innerHeight - 130) }); }}
        title={view === "viz" ? "Fullscreen" : "Show the song in the library — right-click for cover options"}>
        {view === "viz" && showViz ? (
          <Visualizer paused={overlayOpen} />
        ) : view === "lyrics" ? (
          <NpLyrics id={t.id} />
        ) : layout.shape === "vinyl" ? (
          <VinylCover art={art} playing={playing} />
        ) : art ? (
          <CrossArt className="wp-np-cover" src={art} />
        ) : (
          <div className="wp-np-cover wp-np-cover-empty" style={{ "--dna-h": dnaHue(t.path) } as React.CSSProperties}>
            {soundDna ? <SoundDna id={t.path} size={520} /> : <Icon name="music" size={120} color="var(--md-on-surface-variant)" />}
          </div>
        )}
      </div>

      <div className="wp-np-controls">
      <div className="wp-np-meta">
        <div className="wp-np-meta-text">
          <div className="md-headline-s ellipsis">{t.title}</div>
          <ArtistLinks className="md-body-l wp-muted ellipsis" value={t.artist}
            onActivate={(a) => usePlayer.getState().goToArtist(a)}
            onMenu={(a, ev) => setArtistMenu({ name: a, x: Math.min(ev.clientX, window.innerWidth - 210), y: Math.max(8, Math.min(ev.clientY, window.innerHeight - 360)) })} />
          <div className="md-body-s wp-muted ellipsis">{t.album}</div>
          {layout.showStars && <Stars id={t.id} />}
        </div>
        {hasTauri && <button className="md-icon-btn" title="Cast to device" onClick={() => setCast(true)}><Icon name="cast" /></button>}
        <button className="md-icon-btn" title="More" onClick={() => setActions(true)}><Icon name="more" /></button>
      </div>

      <NpSeek analysis={analysis} natPeaks={natPeaks} seekStyle={seekStyle} sections={shownSections} nat={nat}
        loop={loop} setLoop={setLoop} seek={seek} onExpand={() => setSecEdit(true)} seed={t.id}
        duration={duration} showBpm={showBpm} bpm={bpm} endless={endless} upcoming={upcoming} />

      <div className="wp-np-transport">
        <button className={`md-icon-btn ${shuffle ? "wp-on" : ""}`} onClick={shufTap}
          onPointerDown={shufDown} onPointerUp={shufUp} onPointerLeave={shufUp} onPointerCancel={shufUp}
          title="Shuffle (hold for smart shuffle)">
          <Icon name="shuffle" />
        </button>
        <button className="md-icon-btn wp-big" onClick={prevTap}
          onPointerDown={() => beginScrub(-1)} onPointerUp={endScrub} onPointerLeave={endScrub} onPointerCancel={endScrub}
          title="Previous (hold to rewind)"><Icon name="prev" size={32} /></button>
        <button className={`wp-fab ${holding ? "wp-fab-holding" : ""}`} onClick={fabClick}
          onPointerDown={fabDown} onPointerUp={fabUp} onPointerLeave={fabUp} onPointerCancel={fabUp}
          title={playing ? "Pause" : "Play (hold to restart)"}>
          {holding && (
            <svg className="wp-fab-ring" viewBox="0 0 44 44"><circle cx="22" cy="22" r="20" /></svg>
          )}
          <Icon name={playing ? "pause" : "play"} size={32} />
        </button>
        <button className="md-icon-btn wp-big" onClick={nextTap}
          onPointerDown={() => beginScrub(1)} onPointerUp={endScrub} onPointerLeave={endScrub} onPointerCancel={endScrub}
          title="Next (hold to fast-forward)"><Icon name="next" size={32} /></button>
        <button className={`md-icon-btn ${repeat !== "off" || loop ? "wp-on" : ""}`} onClick={repTap}
          onPointerDown={repDown} onPointerUp={repUp} onPointerLeave={repUp} onPointerCancel={repUp}
          title={loop ? "A–B loop active (hold to clear)" : `Repeat: ${repeat} (hold to set A–B loop)`}>
          <Icon name={loop ? "repeatOne" : repeat === "one" ? "repeatOne" : "repeat"} />
        </button>
      </div>

      <div className="wp-np-footer">
        <button className="wp-text-btn md-label-l" onClick={() => setQueue(true)}><Icon name="queue" size={18} /> Up Next</button>
      </div>

      {footer && (
        <button className="wp-np-info" onClick={fTap} onPointerDown={fDown} onPointerUp={fUp} onPointerLeave={fUp} onPointerCancel={fUp}
          title="Tap to cycle · hold for Audio Info">
          <Icon name={footer.icon} size={14} /> <span className="ellipsis">{footer.text}</span>
        </button>
      )}
      </div>

      {audioInfo && <AudioInfo onClose={() => setAudioInfo(false)} />}
      {cast && <CastSheet track={t} onClose={() => setCast(false)} />}

      {queue && <QueueSheet onClose={() => setQueue(false)} />}
      {coverMenu && createPortal(<>
        <div className="wp-cursorpop-scrim" onClick={() => setCoverMenu(null)} onContextMenu={(e) => { e.preventDefault(); setCoverMenu(null); }} />
        <div className="wp-cursorpop" style={{ left: coverMenu.x, top: coverMenu.y }}>
          <button className="wp-cursorpop-item" onClick={() => { setCoverMenu(null); setCoverPick(true); }}><Icon name="image" size={16} /> Change cover…</button>
          <button className="wp-cursorpop-item" onClick={() => { setCoverMenu(null); usePlayer.getState().revealCurrent(); }}><Icon name="prev" size={16} /> Show song in library</button>
        </div>
      </>, document.body)}
      {coverPick && <CoverPicker track={t} onClose={() => setCoverPick(false)} onApplied={() => {}} />}
      {artistMenu && (() => {
        const name = artistMenu.name;
        const enc = encodeURIComponent(name);
        const close = () => setArtistMenu(null);
        const byArtist = () => usePlayer.getState().library.filter((x) => (x.artist || "").toLowerCase().includes(name.toLowerCase()));
        return createPortal(<>
          <div className="wp-cursorpop-scrim" onClick={close} onContextMenu={(e) => { e.preventDefault(); close(); }} />
          <div className="wp-cursorpop" style={{ left: artistMenu.x, top: artistMenu.y }}>
            <div className="wp-cursorpop-title ellipsis md-label-m">{name}</div>
            <button className="wp-cursorpop-item" onClick={() => { close(); usePlayer.getState().goToArtist(name); }}><Icon name="search" size={16} /> Go to artist</button>
            <button className="wp-cursorpop-item" onClick={() => { const ts = byArtist(); close(); if (ts.length) usePlayer.getState().playFrom(ts, 0, name); }}><Icon name="play" size={16} /> Play all by artist</button>
            <button className="wp-cursorpop-item" onClick={() => { const ts = byArtist(); close(); usePlayer.getState().startEndlessSet(ts[0]); }}><Icon name="allInclusive" size={16} /> Artist radio</button>
            <button className="wp-cursorpop-item" onClick={() => { close(); openUrl(`https://www.last.fm/music/${enc}`); }}><Icon name="image" size={16} /> Open on Last.fm</button>
            <button className="wp-cursorpop-item" onClick={() => { close(); openUrl(`https://www.youtube.com/results?search_query=${enc}`); }}><Icon name="play" size={16} /> Search on YouTube</button>
            <button className="wp-cursorpop-item" onClick={() => { close(); openUrl(`https://open.spotify.com/search/${enc}`); }}><Icon name="music" size={16} /> Open on Spotify</button>
            <button className="wp-cursorpop-item" onClick={() => { close(); try { void navigator.clipboard.writeText(name); } catch { /* ignore */ } }}><Icon name="edit" size={16} /> Copy artist name</button>
          </div>
        </>, document.body);
      })()}
      {actions && (
        <TrackActions
          tracks={[t]}
          onClose={() => setActions(false)}
          player={{ view, setView, showViz, onCustomize: () => setCustomize(true) }}
        />
      )}
      {customize && <NpCustomize onClose={() => setCustomize(false)} />}

      {secEdit && analysis && (
        <SectionsEditor
          trackId={t.id} peaks={analysis.peaks} wave={analysis.wave} detected={seekSections}
          bpm={nat?.bpm} firstBeat={nat?.first_beat} duration={duration || 0}
          onClose={() => setSecEdit(false)}
        />
      )}

      {shufMenu && (
        <Sheet onClose={() => setShufMenu(false)} tall={false}>
          <header className="wp-sheet-head">
            <Icon name="shuffle" size={22} color="var(--md-primary)" />
            <div className="wp-row-text"><div className="md-title-s">Smart shuffle</div>
              <div className="md-body-s wp-muted">Fill the queue a smarter way</div></div>
          </header>
          <div className="wp-sheet-actions">
            <button className="wp-sheet-item" onClick={shuffleAll}>
              <Icon name="shuffle" size={22} /><span className="md-body-l">Shuffle all songs</span>
            </button>
            {hasTauri && (
              <button className="wp-sheet-item wp-sheet-hero" onClick={shuffleSimilar}>
                <Icon name="graphicEq" size={22} color="var(--md-primary)" /><span className="md-body-l">Shuffle similar</span>
                <span className="md-body-s wp-muted">For You</span>
              </button>
            )}
            <button className="wp-sheet-item" onClick={shuffleArtist}>
              <Icon name="artist" size={22} /><span className="md-body-l">Shuffle this artist</span>
            </button>
          </div>
        </Sheet>
      )}
    </div>
  );
}

/** The position-driven part of the player (seekbar + section strip + time/BPM row), split out so it
 *  can subscribe to `position` — which ticks several times a second — WITHOUT re-rendering the whole
 *  (large) Now-Playing screen on every tick. Only this small subtree repaints per tick. [perf P0] */
function NpSeek({ analysis, natPeaks, seekStyle, sections, nat, loop, setLoop, seek, onExpand, seed, duration, showBpm, bpm, endless, upcoming }: {
  analysis: TrackAnalysis | null;
  natPeaks: number[] | null;
  seekStyle: "sections" | "waveform" | "slider" | "wavy";
  sections: Section[];
  nat: NativeAnalysis | null;
  loop: { start: number; end: number } | null;
  setLoop: (r: { start: number; end: number } | null) => void;
  seek: (sec: number) => void;
  onExpand: () => void;
  seed: string;
  duration: number;
  showBpm: boolean;
  bpm: number;
  endless: { flow: number } | null;
  upcoming: { beatmatch?: boolean; harmonic?: boolean; overlap_secs: number } | null;
}) {
  const position = usePlayer((s) => s.position);
  const playing = usePlayer((s) => s.playing);
  // tap the right-hand time to toggle total duration ↔ time remaining (e.g. -0:02); persisted
  const [remain, setRemain] = useState(() => { try { return localStorage.getItem("wp-time-remain") === "1"; } catch { return false; } });
  const toggleRemain = () => setRemain((r) => { const n = !r; try { localStorage.setItem("wp-time-remain", n ? "1" : "0"); } catch { /* ignore */ } return n; });
  const waveAmp = useSettings((s) => s.waveAmp);
  const waveSpeed = useSettings((s) => s.waveSpeed);
  const sectionAnim = useSettings((s) => s.sectionAnim);
  const sectionFocus = useSettings((s) => s.sectionFocus);
  // Heights for the bar + section strip are RESERVED (CSS) so the waveform/sections refine IN PLACE as
  // analysis sharpens — no shimmer, no layout jump: a real (pseudo) waveform shows instantly, sections
  // populate from the native pass, then the precise waveform + sections morph in live. [player]
  // Until the precise sections are ready, fall back to the LIVE map (built from playback) so long
  // tracks / mixes show structure filling in instead of an empty strip; precise replaces it when it lands.
  const usingLive = sections.length < 2;            // precise offline sections not ready yet → provisional map
  const shown = usingLive ? liveSections(seed, duration) : sections;
  // Shared timeline ZOOM (double-tap the waveform): the waveform AND the section strip zoom together into
  // the same window, which follows the playhead while playing — so you can read the real waveform detail
  // up close and the matching sections beneath it. [waveform zoom]
  const [zoomed, setZoomed] = useState(false);
  const Z = 14;
  const zoom = zoomed ? Z : 1;
  const frac = duration > 0 ? position / duration : 0;
  const offset = zoomed ? Math.max(0, Math.min(1 - 1 / Z, frac - 0.5 / Z)) : 0;
  return (
    <div className="wp-np-seek">
      <div className="wp-np-seek-bar">
        {seekStyle === "wavy"
          ? <SquiggleSeek value={position} max={duration || 1} onChange={seek} playing={playing} amp={waveAmp} speed={waveSpeed} />
          : (analysis?.peaks?.length || (seekStyle === "waveform" && natPeaks?.length)) && seekStyle !== "slider"
          ? <SongSeek value={position} max={duration || 1} peaks={analysis?.peaks ?? natPeaks ?? []} wave={analysis?.wave} sections={shown} sectionTint={seekStyle === "sections"} onChange={seek} bpm={nat?.bpm} firstBeat={nat?.first_beat} loop={loop} onLoop={setLoop} onExpand={onExpand} liveZoom zoom={zoom} offset={offset} onToggleZoom={() => setZoomed((z) => !z)} />
          : seekStyle !== "slider"
            ? <WaveSeek value={position} max={duration || 1} seed={seed} onChange={seek} />
            : <Seekbar value={position} max={duration || 1} onChange={seek} height={6} />}
        {zoomed && <button className="wp-seek-zoomout md-label-m" onClick={() => setZoomed(false)} title="Zoom out">1×</button>}
      </div>
      {seekStyle !== "slider" && (
        <div className="wp-np-strip">
          {shown.length >= 2 && <SectionStrip sections={shown} value={position} max={duration || 1} onSeek={seek} animate={sectionAnim} loading={usingLive} mode={duration > 480 ? sectionFocus : "off"} trackId={seed} bpm={nat?.bpm} firstBeat={nat?.first_beat} win0={offset} winSpan={1 / zoom} />}
        </div>
      )}
      <div className="wp-np-times md-body-s wp-muted">
        <span>{fmtTime(position)}</span>
        {showBpm && bpm > 0 && <span className="wp-np-bpm">{bpm} BPM</span>}
        {showBpm && nat?.camelot && <span className="wp-np-key" title={nat.key}>{nat.camelot}</span>}
        {showBpm && nat?.genre && nat.genre.confidence >= 0.45 && (
          <span className="wp-np-genre" title={`${nat.genre.genre} · ${Math.round(nat.genre.energy * 100)}% energy${nat.genre.tags.length ? " · " + nat.genre.tags.join(", ") : ""}`}>
            {nat.genre.subgenre}
          </span>
        )}
        {endless && (
          <span className="wp-np-endless"
            title={upcoming
              ? `Next blend ${upcoming.beatmatch ? "· beatmatched " : ""}${upcoming.harmonic ? "· harmonic " : ""}· ${Math.round(upcoming.overlap_secs)}s`
              : "Final track of the set"}>
            <Icon name="allInclusive" size={13} /> {Math.round(endless.flow * 100)}%
            {upcoming?.beatmatch && <Icon name="graphicEq" size={12} />}
            {upcoming?.harmonic && <Icon name="music" size={12} />}
          </span>
        )}
        <span className="wp-np-time-right" onClick={toggleRemain} title="Tap for time remaining">
          {remain ? `-${fmtTime(Math.max(0, duration - position))}` : fmtTime(duration)}
        </span>
      </div>
    </div>
  );
}

/** Lyrics view wrapper that subscribes to `position` in isolation (same reason as NpSeek). [perf P0] */
function NpLyrics({ id }: { id: string }) {
  const position = usePlayer((s) => s.position);
  return <LyricsView id={id} position={position} />;
}

/** 5-star rating row (tap a star; tap the current rating again to clear). */
function Stars({ id }: { id: string }) {
  const rating = useRatings((s) => (s.stats[id]?.rating ?? 0));
  const setRating = useRatings((s) => s.setRating);
  return (
    <div className="wp-stars">
      {[1, 2, 3, 4, 5].map((n) => (
        <button key={n} className="wp-star" onClick={() => setRating(id, rating === n ? 0 : n)} title={`${n} star${n > 1 ? "s" : ""}`}>
          <Icon name={n <= rating ? "star" : "starOutline"} size={20} color={n <= rating ? "var(--md-primary)" : "var(--md-on-surface-variant)"} />
        </button>
      ))}
    </div>
  );
}
