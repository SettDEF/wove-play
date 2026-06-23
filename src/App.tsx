import { useEffect, useRef, lazy, Suspense } from "react";
import { usePlayer } from "@/store/player";
import { bindEngine, startIdleAnalysis, lastExitTab } from "@/store/player";
import { coverArt, hasTauri, isAndroid } from "@/lib/backend";
import { engine } from "@/audio/engine";
import { useSleep } from "@/store/sleep";
import { useTheme } from "@/store/theme";
import { setupMediaSession, updateMediaMetadata, setPlaybackState, setPositionState } from "@/lib/mediaSession";
import { applyDynamicColor, clearDynamicColor, dynamicColorEnabled, applyBgLuminance, clearBgLuminance } from "@/theme/dynamicColor";
// Home (the For-You feed) is heavy and NOT the launch screen (Library/Browse is) → code-split it out of
// the initial bundle so launch parses less JS. Mounted on first open, then kept mounted (instant switch).
const Home = lazy(() => import("@/components/Home").then((m) => ({ default: m.Home })));
import { Library } from "@/components/Library";
import { MiniPlayer } from "@/components/MiniPlayer";
// Code-split the heavy, non-launch screens into their own chunks → smaller initial bundle, faster
// launch. Each is conditionally mounted, so it only downloads + parses the first time it's opened.
const NowPlaying = lazy(() => import("@/components/NowPlaying").then((m) => ({ default: m.NowPlaying })));
const Equalizer = lazy(() => import("@/components/Equalizer").then((m) => ({ default: m.Equalizer })));
const VizStudio = lazy(() => import("@/components/VizStudio").then((m) => ({ default: m.VizStudio })));
const Settings = lazy(() => import("@/components/Settings").then((m) => ({ default: m.Settings })));
const DawLink = lazy(() => import("@/components/DawLink").then((m) => ({ default: m.DawLink })));
import { NavBar } from "@/components/NavBar";
// VizFullscreen renders nothing until you open fullscreen, but it statically pulls in the WebGL
// renderer + the whole viz editor. Lazy + mount-on-demand keeps all of that OUT of the launch bundle.
const VizFullscreen = lazy(() => import("@/components/VizFullscreen").then((m) => ({ default: m.VizFullscreen })));
import { useViz } from "@/store/viz";
import { Toaster } from "@/components/Toaster";
import { LagHud } from "@/components/LagHud";
import { AppBackground } from "@/components/AppBackground";
import { EdgeBack } from "@/components/EdgeBack";
import { Onboarding } from "@/components/Onboarding";
import { Intro } from "@/components/Intro";
import { WhatsNew } from "@/components/WhatsNew";
import { useUi } from "@/store/ui";
import { useSettings } from "@/store/settings";
import { useRatings } from "@/store/ratings";
import { nativeSetLiked } from "@/lib/nativeMedia";
import { useBackGuard } from "@/lib/backStack";
import { installKeyboard } from "@/lib/keyboard";
import { SHOW_VISUALIZER } from "@/lib/features";
import "./app.scss";

export function App() {
  const tab = usePlayer((s) => s.tab);
  // Mount Home once it's first opened, then keep it mounted (instant re-switch). Until then it's not in
  // the tree at all, so its chunk never loads on a Library/Browse launch. [perf]
  const homeSeen = useRef(false);
  if (tab === "home") homeSeen.current = true;
  const vizFull = useViz((s) => s.fullscreen); // only mount the (heavy) fullscreen visualizer when open
  const rescan = usePlayer((s) => s.rescan);
  const onboarded = useSettings((s) => s.onboarded);
  const introSeen = useSettings((s) => s.introSeen);
  const introOpen = useUi((s) => s.introOpen);
  const currentPath = usePlayer((s) => s.current()?.path);
  const playing = usePlayer((s) => s.playing);
  const hydrated = usePlayer((s) => s.hydrated);
  const keepScreenOn = useSettings((s) => s.keepScreenOn);

  // Android back / Esc: from the player, return to wherever it was opened from; from any other non-library
  // tab, go back to the library before exiting the app.
  useBackGuard(tab !== "library", () => {
    const p = usePlayer.getState();
    if (p.tab === "playing") p.leavePlayer(); else p.setTab("library");
  });

  // Desktop keyboard shortcuts + vim-style navigation (Space, ←/→/h/l seek, ↑/↓/j/k vol, [ ] track,
  // m/s/r, / search, 1-5 tabs, gg/G top/bottom, ? help). No-op when typing or with no keyboard.
  useEffect(() => installKeyboard(), []);
  // Desktop app: suppress the webview's DEFAULT right-click behaviour (its native menu / decorationless-
  // window resize) everywhere except text fields — so right-click only does what the app wires (our
  // cover/artist popups). Without this, right-click on the decorationless window resized the layout.
  useEffect(() => {
    if (!hasTauri || isAndroid) return;
    const inText = (el: HTMLElement | null) => !!el?.closest('input, textarea, [contenteditable="true"], .wp-selectable');
    // Only suppress the native webview context menu (so our own popups are the only right-click UI). Do NOT
    // touch mousedown — that swallowed the follow-up `contextmenu` and broke the popups. The window-resize-
    // on-right-click was the decorationless window; that's fixed by re-enabling decorations (tauri.conf).
    const onCtx = (e: MouseEvent) => { if (!inText(e.target as HTMLElement)) e.preventDefault(); };
    window.addEventListener("contextmenu", onCtx);
    return () => window.removeEventListener("contextmenu", onCtx);
  }, []);
  // Re-normalise the UI zoom if the device-pixel-ratio changes (e.g. dragging the window between monitors
  // with different scales) — keeps the UI a consistent on-screen size.
  useEffect(() => {
    if (!hasTauri || isAndroid) return;
    let last = window.devicePixelRatio;
    const onResize = () => {
      if (window.devicePixelRatio !== last) {
        last = window.devicePixelRatio;
        void import("@/store/settings").then((m) => m.useSettings.getState().applyUi());
      }
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // flag whether the mini-player is on screen, so floating FABs can clear it (vs. floating mid-screen).
  const miniShowing = tab !== "playing" && tab !== "settings" && !!currentPath;
  useEffect(() => { document.documentElement.dataset.mini = miniShowing ? "1" : "0"; }, [miniShowing]);
  // expose the active tab so the nav can blend on immersive screens (player/visualizer have their own bg)
  useEffect(() => { document.documentElement.dataset.tab = tab; void import("@/lib/lagMonitor").then((m) => m.markLag("tab:" + tab)); }, [tab]);

  // Lag monitor (Settings → Performance): live frame-time + main-thread-stall HUD to catch the big lags.
  const lagMonitor = useSettings((s) => s.lagMonitor);
  useEffect(() => {
    if (!lagMonitor) return;
    let stop: (() => void) | undefined;
    void import("@/lib/lagMonitor").then((m) => { m.startLagMonitor(); stop = m.stopLagMonitor; });
    return () => stop?.();
  }, [lagMonitor]);

  useEffect(() => {
    // ── critical for the first paint + initial library load (keep synchronous) ──
    // first launch → show the feature introduction (re-openable later from Settings → About)
    if (!useSettings.getState().introSeen) useUi.getState().openIntro();
    // open the user's chosen launch screen. "last" (the default) restores the screen they exited on,
    // so the app reopens exactly where they left it; otherwise honour the explicit choice.
    const ss = useSettings.getState().startScreen;
    if (ss === "last") {
      const lt = lastExitTab();
      if (lt && lt !== "library") usePlayer.getState().setTab(lt);
    } else if (ss && ss !== "library") {
      usePlayer.getState().setTab(ss);
    }
    // Linux desktop: the webview audio path is effectively unusable — webkit2gtk silences Web Audio AND
    // the system often lacks mp3/aac GStreamer codecs (so most tracks won't decode → "clicking play does
    // nothing"). The native Rust engine (Symphonia decode → cpal) is the only path that plays the full
    // format range there, so force it on. (No-op on Android/macOS/Windows, where the webview plays fine.)
    if (hasTauri && !isAndroid && typeof navigator !== "undefined" && /linux/i.test(navigator.userAgent)
        && !useSettings.getState().nativeAudio) {
      useSettings.getState().setNativeAudio(true);
    }
    useTheme.getState().apply();   // data-theme + accent ramp + AMOLED (before dynamic color may override)
    import("@/store/settings").then((m) => m.useSettings.getState().applyUi()); // visual prefs (font/density/bg) → first paint
    // keep "system" theme mode tracking the OS live
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onScheme = () => { if (useTheme.getState().mode === "system") useTheme.getState().apply(); };
    mq.addEventListener?.("change", onScheme);
    const unbind = bindEngine();
    // OS media-session controls (lock screen / notification / hardware keys). Set up IMMEDIATELY (not
    // deferred) so notification buttons respond with zero delay right after launch. Cheap — just handlers.
    setupMediaSession({
      play: () => engine.play(), pause: () => engine.pause(),
      next: () => usePlayer.getState().next(), prev: () => usePlayer.getState().prev(),
      seekTo: (sec) => usePlayer.getState().seek(sec < 0 ? engine.currentTime + 10 : sec),
      rewind: () => usePlayer.getState().seek(Math.max(0, engine.currentTime - 10)),
      forward: () => usePlayer.getState().seek(engine.currentTime + 10),
      like: () => { const t = usePlayer.getState().current(); if (t) import("@/store/ratings").then((m) => { const r = m.useRatings.getState(); r.setRating(t.id, (r.stats[t.id]?.rating ?? 0) >= 4 ? 0 : 5); }); },
      playMediaId: (id) => import("@/lib/autoBrowse").then((m) => m.handleAutoPlay(id)),
    });
    import("@/lib/nativeMedia").then((m) => { const st = useSettings.getState(); m.nativeSetActions(st.notifButtons); m.nativeSetNotifText(st.notifText); m.nativeSetNotifIcon(st.notifIcon); m.nativeSetNotifStyle(st.notifStyle); });
    // browser preview → load demo track list; native → restore the cached library WITHOUT
    // re-walking the whole tree (auto). Explicit Rescan in Settings refreshes new files.
    rescan(true);
    // remember the current track + position when the app is backgrounded / closed, so "Resume on
    // startup" survives an OS kill (pause/track-change already save, this covers a hard exit).
    const onHide = () => usePlayer.getState().flushResume();
    window.addEventListener("pagehide", onHide);
    window.addEventListener("beforeunload", onHide);

    // ── everything else: defer past first paint so launch isn't blocked by media-session / car /
    // bluetooth / analysis init. None of these affect the first render or the library appearing, and
    // applyAudio is re-applied on every playTrack anyway, so deferring it is safe. [perf]
    const hasRIC = typeof window.requestIdleCallback === "function"; // missing on older WebKit → setTimeout
    const idleId = hasRIC
      ? window.requestIdleCallback(deferredInit, { timeout: 1500 })
      : window.setTimeout(deferredInit, 250);
    function deferredInit() {
      if (useTheme.getState().useSystem) void useTheme.getState().fetchSystem(); // Material You from wallpaper
      import("@/store/dsp").then((m) => m.useDsp.getState().apply());            // push tone/fx to the engine
      import("@/store/settings").then((m) => { m.useSettings.getState().applyAudio(); m.useSettings.getState().applyPerf(); });
      import("@/lib/autoBrowse").then((m) => m.initAutoBrowse());                 // Android Auto catalog (no-op off Android)
      import("@/lib/bluetoothEq").then((m) => m.initBluetoothEq());               // BT → EQ auto-swap + connect/disconnect resume/pause (no-op off Android)
      // Audio-focus interruptions (calls / other media apps / nav prompts) → duck / pause / resume.
      Promise.all([import("@/lib/nativeMedia"), import("@/store/player")])
        .then(([nm, pl]) => nm.bindAudioFocus((e) => pl.onAudioFocus(e.state)));
      import("@/store/analysisPause").then((m) => m.startAnalysisGovernor()); // pause heavy analysis if it causes UI jank
      startIdleAnalysis(); // gentle background fingerprinting (paused-only) → better For-You over time
      if (useSettings.getState().mixDetect) import("@/store/mixId").then((m) => m.startMixFingerprinting()); // mix track-ID coverage
      // Warm the heaviest on-demand screen chunks NOW (idle), so the FIRST open is instant instead of a
      // cold lazy-import + eval mid-tap. NowPlaying is the big one — "open player on play" means the next
      // track tap mounts it; without this warm-up that chunk fetch IS the lag opening the player. [perf]
      void import("@/components/NowPlaying");
      void import("@/components/Equalizer");
      void import("@/components/Settings");
      // Also warm the remaining on-demand screens so EVERY first tab-open is instant, not a cold
      // lazy-import + parse mid-tap. Home's chunk is heavy; Visualizer/DAW were paying it on first open.
      void import("@/components/Home");
      void import("@/components/DawLink");
      if (SHOW_VISUALIZER) void import("@/components/VizStudio");
      // Safety: the app-icon set was trimmed to 5. If an old install still has a removed variant saved,
      // re-point it to the default so a valid launcher alias is always enabled (else the app could fall
      // off the launcher). setAppIcon persists + re-enables the right Android alias.
      import("@/lib/appIcons").then(({ isAppIcon }) => {
        if (!isAppIcon(useSettings.getState().appIcon)) useSettings.getState().setAppIcon("default");
      });
    }

    return () => {
      unbind();
      mq.removeEventListener?.("change", onScheme);
      window.removeEventListener("pagehide", onHide);
      window.removeEventListener("beforeunload", onHide);
      if (hasRIC) window.cancelIdleCallback(idleId);
      else clearTimeout(idleId);
    };
  }, [rescan]);

  // Resume on startup: once the library has loaded, restore the last track (paused, at its position).
  useEffect(() => { if (hydrated) void usePlayer.getState().resumeLast(); }, [hydrated]);

  // Keep screen on while playing (Poweramp-style) — best-effort via the Screen Wake Lock API.
  useEffect(() => {
    if (!keepScreenOn || !playing) return;
    const nav = navigator as Navigator & { wakeLock?: { request: (t: string) => Promise<{ release: () => Promise<void> }> } };
    if (!nav.wakeLock?.request) return;
    let lock: { release: () => Promise<void> } | null = null;
    let released = false;
    const acquire = () => nav.wakeLock!.request("screen").then((l) => { if (released) void l.release(); else lock = l; }).catch(() => {});
    void acquire();
    // the OS drops the lock when the tab/app is hidden — re-acquire when it returns to the foreground
    const onVis = () => { if (document.visibilityState === "visible" && !lock) void acquire(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { released = true; document.removeEventListener("visibilitychange", onVis); void lock?.release().catch(() => {}); };
  }, [keepScreenOn, playing]);

  // Sleep timer: pause playback when the timer elapses. Only tick while a timer is actually armed —
  // an always-on 1s interval wakes the CPU every second in the background for nothing.
  const sleepEndsAt = useSleep((s) => s.endsAt);
  useEffect(() => {
    if (!sleepEndsAt) return;
    const iv = setInterval(() => {
      const e = useSleep.getState().endsAt;
      if (e && Math.floor(Date.now() / 1000) >= e) { engine.pause(); useSleep.getState().cancel(); }
    }, 1000);
    return () => clearInterval(iv);
  }, [sleepEndsAt]);

  // Material-You dynamic color + OS media-session metadata from the current track's album art.
  useEffect(() => {
    const track = usePlayer.getState().current();
    if (!currentPath || !track) { clearDynamicColor(); clearBgLuminance(); return; }
    usePlayer.getState().resolveSongEq(track); // per-song pinned EQ / AutoEq → base EQ
    // Push title/artist/duration to the OS notification IMMEDIATELY so the notification updates with zero
    // delay — DON'T wait for the cover to decode (slow on SD). The artwork fills in when it resolves.
    updateMediaMetadata(track, null);
    let alive = true;
    coverArt(currentPath).then((url) => {
      if (!alive) return;
      if (dynamicColorEnabled()) applyDynamicColor(url, track.id); else clearDynamicColor();
      applyBgLuminance(url, track.id); // tag root light/dark so list text stays readable over the blurred art
      if (url) updateMediaMetadata(track, url); // now add the artwork
    });
    return () => { alive = false; };
  }, [currentPath]);

  // keep the OS play/pause indicator in sync
  useEffect(() => { setPlaybackState(playing); }, [playing]);

  // keep the notification's heart button in sync with the current track's loved state
  const curId = usePlayer((s) => s.current()?.id);
  const ratingStats = useRatings((s) => s.stats);
  useEffect(() => { if (curId) nativeSetLiked((ratingStats[curId]?.rating ?? 0) >= 4); }, [curId, ratingStats]);

  // Feed position to the OS session so the lock-screen scrubber tracks playback (extrapolated
  // between pushes). Ticks while playing; one final push on pause/seek freezes it accurately.
  useEffect(() => {
    setPositionState(engine.duration, engine.currentTime);
    if (!playing) return;
    // While the app is hidden (backgrounded), the OS media session extrapolates position from the
    // playback state, so we can stop the 1s JS push and re-arm it when the app returns to the front —
    // no per-second wakeups in the background.
    let iv = 0;
    const startTick = () => { if (!iv) iv = window.setInterval(() => setPositionState(engine.duration, engine.currentTime), 1000); };
    const stopTick = () => { if (iv) { clearInterval(iv); iv = 0; } };
    const onVis = () => { if (document.visibilityState === "visible") { setPositionState(engine.duration, engine.currentTime); startTick(); } else stopTick(); };
    if (document.visibilityState === "visible") startTick();
    document.addEventListener("visibilitychange", onVis);
    return () => { stopTick(); document.removeEventListener("visibilitychange", onVis); };
  }, [playing, currentPath]);

  return (
    <div className="wp-app">
      {/* Frameless desktop window (decorations off → no wasted title row). A thin top strip stays grabbable
          so it can still be dragged on floating WMs; tiling WMs (Hyprland) manage it anyway. */}
      {hasTauri && !isAndroid && <div className="wp-drag-strip" data-tauri-drag-region />}
      <AppBackground />
      <EdgeBack />
      <main className="wp-content">
        {/* Home + Library are the heavy list screens — keep them MOUNTED (just hidden) so
            switching back is INSTANT: no re-grouping 43k tracks, scroll position preserved.
            display:none→block restarts the .wp-screen-anim fade, so the switch still animates.
            Loop/GPU screens (player, visualizer…) mount on demand so their render loops stop
            when you leave them. One uniform animation for every switch, however you navigated. */}
        {homeSeen.current && <div className="wp-screen-anim" hidden={tab !== "home"}><Suspense fallback={null}><Home /></Suspense></div>}
        <div className="wp-screen-anim" hidden={tab !== "library"}><Library /></div>
        {tab === "search" && <div className="wp-screen-anim"><Library searchMode /></div>}
        <Suspense fallback={null}>
          {tab === "playing" && <div className="wp-screen-anim"><NowPlaying /></div>}
          {tab === "eq" && <div className="wp-screen-anim"><Equalizer /></div>}
          {SHOW_VISUALIZER && tab === "visualizer" && <div className="wp-screen-anim"><VizStudio /></div>}
          {tab === "daw" && <div className="wp-screen-anim"><DawLink /></div>}
          {tab === "settings" && <div className="wp-screen-anim"><Settings /></div>}
        </Suspense>
      </main>

      {tab !== "playing" && tab !== "settings" && <MiniPlayer />}
      <NavBar />
      {SHOW_VISUALIZER && vizFull && <Suspense fallback={null}><VizFullscreen /></Suspense>}
      <Toaster />
      {lagMonitor && <LagHud />}
      {introOpen
        ? <Intro onDone={() => { useUi.getState().closeIntro(); if (!introSeen) useSettings.getState().setIntroSeen(true); }} />
        : !onboarded && <Onboarding />}
      {/* "What's new" on update + "Update available" download prompt (first-launch onboarding takes priority). */}
      {!introOpen && onboarded && <WhatsNew />}
    </div>
  );
}
