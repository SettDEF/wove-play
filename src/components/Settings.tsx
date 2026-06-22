import { useEffect, useRef, useState } from "react";
import { usePlayer } from "@/store/player";
import { WhatsNew } from "./WhatsNew";
import { usePlaylists } from "@/store/playlists";
import * as taste from "@/lib/taste";
import { libraryTokens, analyzeLibrary, selectForAnalysis, tasteOpts } from "@/lib/tasteIngest";
import { useRatings } from "@/store/ratings";
import { tasteAnalyzePaths } from "@/lib/backend";
import { toast } from "@/store/toasts";
import { useSettings, type ExportRes, type ExportFps, type NotifButton, type PerfMode, NOTIF_BUTTONS, NOTIF_BUTTONS_MAX, NP_FOOTER_MODES } from "@/store/settings";
import { PERF_MODES, CUSTOM_CARD } from "@/lib/perfModes";
import { APP_ICONS } from "@/lib/appIcons";
import { useTheme, ACCENTS } from "@/store/theme";
import { useSleep, sleepRemaining } from "@/store/sleep";
import { hasTauri, isAndroid, saveTextFile, cacheClear, clearIndex, coverCacheClear, openUrl, libClear } from "@/lib/backend";
import { LYRICS_PROVIDERS } from "@/lib/lyricsProviders";
import { Slider } from "./Slider";
import { buildBackup, restoreBackup, resetData } from "@/lib/backup";
import { Icon } from "./Icons";
import { clearCoverCache } from "./Cover";
import { Stats } from "./Stats";
import { TransitionStudio } from "./TransitionStudio";
import { OutputSettings } from "./OutputSettings";
import { BtDevicesEditor } from "./BtDevicesEditor";
import { Sheet } from "./Sheet";
import { SWIPE_ACTIONS, def as swipeDef } from "@/lib/swipeActions";
import { InfoTip } from "./InfoTip";
import { MaterialShape } from "./MaterialShape";
import type { MaterialShapeName } from "./materialShapes";
import { useT, useI18n, LANGUAGES } from "@/lib/i18n";
import { useBackGuard } from "@/lib/backStack";
import { SHOW_VISUALIZER } from "@/lib/features";
import { APP_VERSION, CHANGELOG } from "@/lib/changelog";
import { checkForUpdate, UPDATE_MANIFEST_URL } from "@/lib/updates";
import { useUi } from "@/store/ui";

function Switch({ on, onToggle, title }: { on: boolean; onToggle: () => void; title?: string }) {
  return (
    <button className={`wp-switch ${on ? "wp-switch-on" : ""}`} onClick={onToggle} title={title} aria-pressed={on}>
      <span className="wp-switch-knob" />
    </button>
  );
}

function Seg<T extends string | number>({ value, options, onChange }: { value: T; options: { id: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="wp-seg wp-seg-sm">
      {options.map((o) => <button key={String(o.id)} className={`wp-seg-item ${value === o.id ? "wp-seg-on" : ""}`} onClick={() => onChange(o.id)}>{o.label}</button>)}
    </div>
  );
}

/** Paste any direct audio stream / .m3u / .pls URL → play it (internet radio etc.). */
function StreamOpener() {
  const [url, setUrl] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const go = async () => {
    if (!url.trim() || busy) return;
    setBusy(true); setMsg("Opening…");
    try {
      const { openStream } = await import("@/lib/streams");
      const n = await openStream(url.trim());
      setMsg(n ? `Playing ${n} stream${n > 1 ? "s" : ""}.` : "Couldn't open that URL.");
      if (n) setUrl("");
    } finally { setBusy(false); }
  };
  return (
    <div className="wp-stream-open">
      <input className="wp-search-input md-body-l" placeholder="https://…  ·  stream, .m3u or .pls" value={url}
        onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") go(); }} />
      <button className="wp-filled-btn" onClick={go} disabled={busy}><Icon name="play" size={18} /> Play</button>
      {msg && <div className="md-body-s wp-muted" style={{ padding: "2px" }}>{msg}</div>}
    </div>
  );
}

/** Launches the internet-radio browser overlay. */
function RadioLauncher() {
  const [open, setOpen] = useState(false);
  const [Comp, setComp] = useState<null | typeof import("./RadioBrowser").RadioBrowser>(null);
  const launch = async () => { if (!Comp) { const m = await import("./RadioBrowser"); setComp(() => m.RadioBrowser); } setOpen(true); };
  return (<>
    <button className="wp-tonal-btn" onClick={launch} style={{ margin: "2px 2px 0" }}><Icon name="cast" size={18} /> Browse internet radio</button>
    {open && Comp && <Comp onClose={() => setOpen(false)} />}
  </>);
}

/** Jamendo (free/CC music): key input + browser launcher. */
function JamendoLauncher() {
  const jamendoKey = useSettings((st) => st.jamendoKey);
  const setJamendoKey = useSettings((st) => st.setJamendoKey);
  const [open, setOpen] = useState(false);
  const [Comp, setComp] = useState<null | typeof import("./JamendoBrowser").JamendoBrowser>(null);
  const launch = async () => { if (!Comp) { const m = await import("./JamendoBrowser"); setComp(() => m.JamendoBrowser); } setOpen(true); };
  return (<>
    <input className="wp-search-input md-body-l" placeholder="Jamendo client ID (developer.jamendo.com)" value={jamendoKey}
      onChange={(e) => setJamendoKey(e.target.value)} style={{ width: "100%", margin: "4px 0 2px" }} />
    <button className="wp-tonal-btn" onClick={launch} style={{ margin: "2px 2px 0" }}><Icon name="allInclusive" size={18} /> Browse free music (Jamendo)</button>
    {open && Comp && <Comp onClose={() => setOpen(false)} onNeedKey={() => setOpen(false)} />}
  </>);
}

/** Subsonic/Navidrome (self-hosted): server fields + browser launcher. */
function SubsonicLauncher() {
  const { subsonicUrl, subsonicUser, subsonicPass, setSubsonicUrl, setSubsonicUser, setSubsonicPass } = useSettings();
  const [open, setOpen] = useState(false);
  const [Comp, setComp] = useState<null | typeof import("./SubsonicBrowser").SubsonicBrowser>(null);
  const launch = async () => { if (!Comp) { const m = await import("./SubsonicBrowser"); setComp(() => m.SubsonicBrowser); } setOpen(true); };
  return (<>
    <input className="wp-search-input md-body-l" placeholder="Server URL (https://music.example.com)" value={subsonicUrl}
      onChange={(e) => setSubsonicUrl(e.target.value)} style={{ width: "100%", margin: "4px 0 2px" }} />
    <div style={{ display: "flex", gap: 6 }}>
      <input className="wp-search-input md-body-l" placeholder="Username" value={subsonicUser} onChange={(e) => setSubsonicUser(e.target.value)} style={{ flex: 1 }} />
      <input className="wp-search-input md-body-l" type="password" placeholder="Password" value={subsonicPass} onChange={(e) => setSubsonicPass(e.target.value)} style={{ flex: 1 }} />
    </div>
    <button className="wp-tonal-btn" onClick={launch} style={{ margin: "2px 2px 0" }}><Icon name="cast" size={18} /> Browse my server (Subsonic)</button>
    {open && Comp && <Comp onClose={() => setOpen(false)} onNeedKey={() => setOpen(false)} />}
  </>);
}

const LIB_TAB_CATALOG: Record<string, string> = {
  browse: "Browse", explore: "Explore", songs: "Songs", loved: "Loved", albums: "Albums",
  artists: "Artists", folders: "Folders", playlists: "Playlists", genres: "Genres", years: "Years",
};
/** Reorder / show / hide the Library sub-tabs. */
function LibTabsEditor() {
  const libTabs = useSettings((s) => s.libTabs);
  const setLibTabs = useSettings((s) => s.setLibTabs);
  const off = Object.keys(LIB_TAB_CATALOG).filter((id) => !libTabs.includes(id));
  const move = (i: number, d: number) => { const a = [...libTabs]; const j = i + d; if (j < 0 || j >= a.length) return; [a[i], a[j]] = [a[j], a[i]]; setLibTabs(a); };
  return (
    <div className="wp-libtabs-edit">
      {libTabs.map((id, i) => (
        <div key={id} className="wp-libtab-row">
          <span className="md-body-m" style={{ flex: 1 }}>{LIB_TAB_CATALOG[id] ?? id}</span>
          <button className="md-icon-btn" disabled={i === 0} onClick={() => move(i, -1)} title="Move up"><span style={{ display: "inline-flex", transform: "rotate(90deg)" }}><Icon name="prev" size={18} /></span></button>
          <button className="md-icon-btn" disabled={i === libTabs.length - 1} onClick={() => move(i, 1)} title="Move down"><span style={{ display: "inline-flex", transform: "rotate(-90deg)" }}><Icon name="prev" size={18} /></span></button>
          <button className="md-icon-btn" disabled={libTabs.length <= 1} onClick={() => setLibTabs(libTabs.filter((x) => x !== id))} title="Hide"><Icon name="close" size={18} /></button>
        </div>
      ))}
      {off.length > 0 && (<>
        <div className="md-body-s wp-muted" style={{ padding: "6px 2px 2px" }}>Hidden — tap to add:</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, padding: "0 2px" }}>
          {off.map((id) => <button key={id} className="wp-tonal-btn" onClick={() => setLibTabs([...libTabs, id])}><Icon name="add" size={16} /> {LIB_TAB_CATALOG[id] ?? id}</button>)}
        </div>
      </>)}
    </div>
  );
}

/** Extensions (community sources) launcher. */
function ExtensionLauncher() {
  const [open, setOpen] = useState(false);
  const [Comp, setComp] = useState<null | typeof import("./ExtensionsManager").ExtensionsManager>(null);
  const launch = async () => { if (!Comp) { const m = await import("./ExtensionsManager"); setComp(() => m.ExtensionsManager); } setOpen(true); };
  return (<>
    <button className="wp-tonal-btn" onClick={launch} style={{ margin: "2px 2px 0" }}><Icon name="allInclusive" size={18} /> Extensions (community sources)</button>
    {open && Comp && <Comp onClose={() => setOpen(false)} />}
  </>);
}

/** Podcasts (RSS) browser launcher. */
function PodcastLauncher() {
  const [open, setOpen] = useState(false);
  const [Comp, setComp] = useState<null | typeof import("./PodcastBrowser").PodcastBrowser>(null);
  const launch = async () => { if (!Comp) { const m = await import("./PodcastBrowser"); setComp(() => m.PodcastBrowser); } setOpen(true); };
  return (<>
    <button className="wp-tonal-btn" onClick={launch} style={{ margin: "2px 2px 0" }}><Icon name="music" size={18} /> Podcasts</button>
    {open && Comp && <Comp onClose={() => setOpen(false)} />}
  </>);
}

function Row({ icon, title, sub, info, children }: { icon?: string; title: string; sub?: string; info?: { title: string; body: string }; children?: React.ReactNode }) {
  return (
    <div className="wp-set-row">
      {icon && <span className="wp-set-icon"><Icon name={icon} size={20} /></span>}
      <div className="wp-row-text">
        <div className="wp-set-title-line">
          <span className="md-body-l">{title}</span>
          {info && <InfoTip title={info.title} body={info.body} />}
        </div>
        {sub && <div className="md-body-s wp-muted wp-set-sub">{sub}</div>}
      </div>
      <div className="wp-set-control">{children}</div>
    </div>
  );
}

/** A labelled card container that boxes a related cluster of rows — keeps long settings pages organized. */
function Group({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <div className="wp-set-group">
      {title && <h3 className="md-title-s wp-set-head">{title}</h3>}
      <div className="wp-set-sec wp-set-card">{children}</div>
    </div>
  );
}

type SubTab = "appearance" | "library" | "stats" | "taste" | "playback" | "audio" | "visualizer" | "performance" | "connect" | "backup" | "about";

/** Game-style performance presets shown as a card grid (incl. hybrids + auto). */
// Mode cards derive from the single source of truth (lib/perfModes), with "custom" appended.
const PERF_CARDS: { id: PerfMode; label: string; icon: string; sub: string }[] =
  [...PERF_MODES.map(({ id, label, icon, sub }) => ({ id, label, icon, sub })), CUSTOM_CARD];

/** Settings root menu — a simple list of buttons that drill into each sub-page. */
import type { TKey } from "@/lib/i18n";
const SETTINGS_MENU: { id: SubTab; labelKey: TKey; icon: string; descKey: TKey; tauriOnly?: boolean }[] = [
  { id: "appearance", labelKey: "settings.look", icon: "palette", descKey: "settings.look.desc" },
  { id: "library", labelKey: "settings.library", icon: "folder", descKey: "settings.library.desc" },
  { id: "stats", labelKey: "settings.stats", icon: "graphicEq", descKey: "settings.stats.desc" },
  { id: "taste", labelKey: "settings.foryou", icon: "favorite", descKey: "settings.foryou.desc", tauriOnly: true },
  { id: "playback", labelKey: "settings.playback", icon: "tune", descKey: "settings.playback.desc" },
  { id: "audio", labelKey: "settings.audio", icon: "graphicEq", descKey: "settings.audio.desc" },
  { id: "visualizer", labelKey: "settings.visualizer", icon: "graphicEq", descKey: "settings.visualizer.desc" },
  { id: "performance", labelKey: "settings.performance", icon: "bolt", descKey: "settings.performance.desc" },
  { id: "connect", labelKey: "settings.connect", icon: "cast", descKey: "settings.connect.desc", tauriOnly: true },
  { id: "backup", labelKey: "settings.backup", icon: "copy", descKey: "settings.backup.desc" },
  { id: "about", labelKey: "settings.about", icon: "hub", descKey: "settings.about.desc" },
];

/** Release history — shown at the bottom of the Settings menu so the screen never feels empty. */

// Curated Material shapes offered for the active nav-tab indicator (full set lives in materialShapes).
const NAV_SHAPES: MaterialShapeName[] = [
  "circle", "pill", "cookie4Sided", "cookie6Sided", "clover4Leaf", "flower",
  "sunny", "gem", "heart", "burst", "puffy", "arch",
];

export function Settings() {
  const folders = usePlayer((s) => s.folders);
  const setTab = usePlayer((s) => s.setTab);
  const scanning = usePlayer((s) => s.scanning);
  const stopAfterCurrent = usePlayer((s) => s.stopAfterCurrent);
  const libCount = usePlayer((s) => s.library.length);
  const { loadFolder, removeFolder, rescan, cancelIndexing, loadMediaStore } = usePlayer.getState();
  const plCount = usePlaylists((s) => s.lists.length);
  const s = useSettings();
  const t = useT();
  const lang = useI18n((st) => st.lang);
  const theme = useTheme();
  const sleep = useSleep();
  const importRef = useRef<HTMLInputElement>(null);
  const [backupMsg, setBackupMsg] = useState("");
  const [transOpen, setTransOpen] = useState(false);
  const [swipePick, setSwipePick] = useState<"left" | "right" | null>(null);
  const [langPick, setLangPick] = useState(false);
  // Look is a drill-in list of category rows (not a tab strip): "" = the menu, else a category page.
  type LookCat = "" | "theme" | "background" | "layout" | "player";
  const [lookTab, setLookTab] = useState<LookCat>("");
  const LOOK_CATS: { id: LookCat; label: string; icon: string; sub: string }[] = [
    { id: "theme", label: t("settings.look.theme"), icon: "palette", sub: t("settings.look.themeSub") },
    { id: "background", label: t("settings.look.bg"), icon: "image", sub: t("settings.look.bgSub") },
    { id: "layout", label: t("settings.look.layout"), icon: "tune", sub: t("settings.look.layoutSub") },
    { id: "player", label: t("settings.look.player"), icon: "play", sub: t("settings.look.playerSub") },
  ];
  const [outOpen, setOutOpen] = useState(false);
  const screenRef = useRef<HTMLDivElement>(null);
  // Per-section "Restore defaults" → reset just that section's keys.
  const restore = (keys: string[], label: string) => { s.reset(keys as Parameters<typeof s.reset>[0]); toast.success(`${label} reset to defaults`); };
  const RestoreRow = ({ keys, label }: { keys: string[]; label: string }) => (
    <button className="wp-text-btn md-label-l wp-set-restore" onClick={() => restore(keys, label)}><Icon name="refresh" size={16} /> {t("settings.appearance.restoreDefaults")}</button>
  );
  // Any manual change to a perf knob means the mix no longer matches a named preset → mark it "Custom".
  const perfTweak = (fn: () => void) => { fn(); s.setPerfMode("custom"); };
  const [notifOpen, setNotifOpen] = useState(false); // rendered as a <Sheet>, which self-guards the back button
  const [sub, setSub] = useState<SubTab | null>(null);
  const [previewWhatsNew, setPreviewWhatsNew] = useState(false);
  useBackGuard(sub !== null, () => setSub(null));
  useBackGuard(sub === "appearance" && lookTab !== "", () => setLookTab("")); // back from a Look category → the Look menu
  // A nav-bloom (hold the Settings tab) can request a specific sub-page → open it.
  const wantSub = useUi((u) => u.settingsSub);
  useEffect(() => {
    if (wantSub) {
      setSub(wantSub as SubTab);
      const look = useUi.getState().settingsLook;
      if (look) setLookTab(look as LookCat);
      useUi.getState().clearSettingsSub();
    }
  }, [wantSub]);
  // Switching a sub-page (or a Look subtab) jumps the scroll back to the top — otherwise the new
  // page opens mid-scroll, which feels broken.
  useEffect(() => { screenRef.current?.scrollTo({ top: 0 }); }, [lookTab, sub]);
  // Drill-in/out slide direction: going deeper (menu → section → Look category) slides the new page in
  // from the RIGHT; going back slides it from the LEFT — so it reads like the next window, not a blank
  // swap. Computed from the navigation "depth" with refs so the new pane mounts with the right direction.
  const setDepth = sub === null ? 0 : (sub === "appearance" && lookTab !== "" ? 2 : 1);
  const lastDepthRef = useRef(setDepth);
  const setDirRef = useRef<"l" | "r">("r");
  if (setDepth !== lastDepthRef.current) { setDirRef.current = setDepth > lastDepthRef.current ? "r" : "l"; lastDepthRef.current = setDepth; }
  const setDir = setDirRef.current;

  // ── notification buttons editor (Android) ──────────────────────────────────
  const nbMove = (i: number, d: number) => { const a = [...s.notifButtons]; const j = i + d; if (j < 0 || j >= a.length) return; [a[i], a[j]] = [a[j], a[i]]; s.setNotifButtons(a); };
  const nbRemove = (i: number) => { if (s.notifButtons.length <= 1) return; s.setNotifButtons(s.notifButtons.filter((_, k) => k !== i)); };
  const nbAdd = (id: NotifButton) => { if (s.notifButtons.length >= NOTIF_BUTTONS_MAX || s.notifButtons.includes(id)) return; s.setNotifButtons([...s.notifButtons, id]); };
  const nbDef = (id: NotifButton) => NOTIF_BUTTONS.find((b) => b.id === id)!;

  // ── taste profile (Phase 6) ───────────────────────────────────────────────
  const [taste_, setTasteStats] = useState<taste.TasteStats>({ tracks: 0, events: 0 });
  const [analyzing, setAnalyzing] = useState(false);
  const stopRef = useRef(false);
  const busyRef = useRef(false); // guards delete/rebuild against double-taps + overlap
  useEffect(() => { if (hasTauri) void taste.stats().then(setTasteStats); }, []);

  const analyzeLib = async () => {
    if (analyzing) return;
    setAnalyzing(true); stopRef.current = false;
    const full = usePlayer.getState().library;
    // Don't grind the WHOLE library (a 65k-song phone never finishes + the IPC melts). Analyze the
    // tracks you actually engage with first (liked > played > recent), capped by the perf mode.
    const opts = tasteOpts(s.tastePerf);
    const ratingStats = useRatings.getState().stats;
    const lib = selectForAnalysis(full, (id) => ratingStats[id] ?? { rating: 0, plays: 0, lastPlayed: 0 }, opts.cap);
    const t = toast.progress(`Analyzing ${lib.length} songs…`, "taste");
    try {
      let added = 0;
      if (isAndroid) {
        // Android tracks are content:// URIs (not file paths), so the native symphonia analyzer can't
        // open them. Decode in the WebView (Web Audio) and feed the engine the samples instead.
        added = await analyzeLibrary(lib, opts, (p) => t.update(`Analyzing… ${p.done}/${p.total} · ${p.added} new`, p.done / Math.max(1, p.total)), () => stopRef.current);
      } else {
        // Desktop: fast native parallel decode in Rust, chunked so Stop works + each chunk persists.
        const paths = lib.map((x) => x.id);
        const CHUNK = 400; let base = 0;
        for (let i = 0; i < paths.length && !stopRef.current; i += CHUNK) {
          const slice = paths.slice(i, i + CHUNK);
          const n = await tasteAnalyzePaths(slice, (e) => {
            if (e.kind === "progress") t.update(`Analyzing… ${base + e.done}/${paths.length}`, (base + e.done) / Math.max(1, paths.length));
          });
          added += n; base += slice.length;
        }
      }
      t.update("Grouping genres…");
      await taste.recluster(libraryTokens(lib));
      setTasteStats(await taste.stats());
      t.done(stopRef.current ? `Stopped · analyzed ${added} new` : `Taste ready · analyzed ${added} new song${added === 1 ? "" : "s"}`);
    } catch { t.fail("Couldn't analyze the library."); }
    finally { setAnalyzing(false); }
  };
  const recluster = async () => { await taste.recluster(libraryTokens(usePlayer.getState().library), true); toast.success("Regrouped your genres."); };
  const resetTaste = async () => { await taste.reset(); setTasteStats(await taste.stats()); toast.info("Taste profile reset — fingerprints kept."); };
  // Full rebuild: wipe the cached library + cover cache, then re-read every file from scratch.
  const rebuildLib = async () => {
    if (scanning || busyRef.current) return;
    busyRef.current = true;
    try {
      cancelIndexing();          // stop any running scan + background tag sweep first
      usePlayer.setState({ library: [] });
      clearCoverCache();
      await coverCacheClear();   // also wipe the on-disk thumbnail cache
      await cacheClear();
      await usePlayer.getState().rescan(false);
    } catch (e) { toast.error("Rebuild failed: " + (e instanceof Error ? e.message : String(e))); }
    finally { busyRef.current = false; }
  };
  // Real delete: stop any scan, delete the on-disk index + caches, and leave the library EMPTY
  // (no auto re-read). The next Reindex starts truly from zero. Every step is guarded so a single
  // failing native call can't bubble as an unhandled rejection (which blanks the WebView).
  const deleteIndex = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      cancelIndexing();                 // stops the poll loop + aborts the enrich sweep
      usePlayer.setState({ library: [] }); // wipe the UI first so nothing references stale tracks
      clearCoverCache();
      await coverCacheClear();
      await clearIndex();
      await cacheClear();
      await libClear(); // empty the SQLite index too (no re-read follows a Delete)
      toast.success("Index deleted — Reindex to rebuild from scratch.");
    } catch (e) { toast.error("Delete failed: " + (e instanceof Error ? e.message : String(e))); }
    finally { busyRef.current = false; }
  };

  const exportAll = () => { saveTextFile("wavr-play-backup.json", buildBackup(Date.now()), "application/json"); setBackupMsg("Exported your data."); };
  const onImport = async (file: File | undefined) => {
    if (!file) return;
    try { const n = restoreBackup(await file.text()); setBackupMsg(`Imported ${n} items — reloading…`); setTimeout(() => location.reload(), 600); }
    catch (e) { setBackupMsg(String(e instanceof Error ? e.message : e)); }
  };
  const reset = () => { resetData(); setBackupMsg("Reset — reloading…"); setTimeout(() => location.reload(), 500); };

  const RES: { id: ExportRes; label: string }[] = [{ id: "720p", label: "720p" }, { id: "1080p", label: "1080p" }];
  const FPS: { id: ExportFps; label: string }[] = [{ id: 24, label: "24" }, { id: 30, label: "30" }, { id: 60, label: "60" }];
  const CAP: { id: number; label: string }[] = [{ id: 30, label: "30" }, { id: 60, label: "60" }, { id: 0, label: "Max" }];

  if (outOpen) return <OutputSettings onClose={() => setOutOpen(false)} />;

  return (
    <div className="wp-screen wp-settings" ref={screenRef}>
      <div className={`wp-set-pane wp-tab-pane-${setDir}`} key={`${sub ?? "menu"}:${lookTab}`}>
      {sub === null ? (
        <div className="wp-set-menu">
          {SETTINGS_MENU.filter((m) => (!m.tauriOnly || hasTauri) && (m.id !== "visualizer" || SHOW_VISUALIZER)).map((m) => (
            <button key={m.id} className="wp-set-menu-row" onClick={() => setSub(m.id)}>
              <span className="wp-set-icon"><Icon name={m.icon} size={20} /></span>
              <div className="wp-row-text"><div className="md-body-l">{t(m.labelKey)}</div><div className="md-body-s wp-muted ellipsis">{t(m.descKey)}</div></div>
            </button>
          ))}
          <div className="wp-changelog">
            <div className="wp-changelog-head md-label-m wp-muted">{t("settings.whatsNew")}</div>
            {CHANGELOG.map((c) => (
              <div key={c.v} className="wp-cl-entry">
                <div className="wp-cl-ver"><span className="md-label-l">{c.v}</span><span className="md-body-s wp-muted">{c.date}</span></div>
                <ul className="wp-cl-notes">
                  {c.notes.map((n, i) => <li key={i} className="md-body-s">{n}</li>)}
                </ul>
              </div>
            ))}
            <div className="wp-cl-foot md-body-s wp-muted">{t("settings.tagline")}</div>
          </div>
        </div>
      ) : (
        <div className="wp-set-back">
          <button className="md-icon-btn" onClick={() => (sub === "appearance" && lookTab !== "") ? setLookTab("") : setSub(null)} title={t("settings.back")}><Icon name="prev" size={22} /></button>
          <span className="md-title-m">{
            sub === "appearance" && lookTab !== "" ? (LOOK_CATS.find((c) => c.id === lookTab)?.label ?? t("settings.look.fallback"))
              : (() => { const m = SETTINGS_MENU.find((x) => x.id === sub); return m ? t(m.labelKey) : ""; })()
          }</span>
        </div>
      )}

      {sub === "appearance" && (
      <section className="wp-set-sec">
        {lookTab === "" && (
          <div className="wp-set-menu">
            {LOOK_CATS.map((c) => (
              <button key={c.id} className="wp-set-menu-row" onClick={() => setLookTab(c.id)}>
                <span className="wp-set-icon"><Icon name={c.icon} size={20} /></span>
                <div className="wp-row-text"><div className="md-body-l">{c.label}</div><div className="md-body-s wp-muted ellipsis">{c.sub}</div></div>
                <Icon name="next" size={18} color="var(--md-on-surface-variant)" />
              </button>
            ))}
          </div>
        )}

        {lookTab === "theme" && (<>
          <Row icon="hub" title={t("settings.language")} sub={LANGUAGES.find((l) => l.id === lang)?.native}
            info={{ title: t("settings.language"), body: t("settings.language.info") }}>
            <button className="wp-swipe-pick" onClick={() => setLangPick(true)}>{LANGUAGES.find((l) => l.id === lang)?.native} <Icon name="next" size={16} /></button>
          </Row>
          <Row icon="palette" title={t("settings.theme")}>
            <Seg value={theme.mode} options={[{ id: "system", label: t("settings.theme.auto") }, { id: "light", label: t("settings.theme.light") }, { id: "dark", label: t("settings.theme.dark") }, { id: "amoled", label: t("settings.theme.amoled") }]} onChange={theme.setMode} />
          </Row>
          <Row icon="palette" title={t("settings.materialYou")} sub={t("settings.materialYou.sub")}>
            <Switch on={theme.useSystem} onToggle={() => theme.setUseSystem(!theme.useSystem)} />
          </Row>
          <Row icon="palette" title={t("settings.accent")} sub={theme.useSystem ? t("settings.appearance.accentSubOff") : t("settings.appearance.accentSubOn")}>
            <div className={`wp-swatches ${theme.useSystem ? "wp-disabled" : ""}`}>
              {ACCENTS.map((a) => <button key={a.hex} className={`wp-swatch ${theme.accent === a.hex ? "wp-swatch-on" : ""}`} style={{ background: a.hex }} title={a.name} onClick={() => theme.setAccent(a.hex)} />)}
              <input type="color" className="wp-swatch wp-swatch-custom" value={theme.accent} onChange={(e) => theme.setAccent(e.target.value)} title={t("settings.customColor")} />
            </div>
          </Row>
          <Row icon="visibility" title={t("settings.appearance.dynamicColor")} sub={t("settings.appearance.dynamicColorSub")}>
            <Switch on={s.dynamicColor} onToggle={() => s.setDynamicColor(!s.dynamicColor)} />
          </Row>
          <div className="wp-iconpick-block">
            <div className="wp-row-text">
              <span className="md-body-l">{t("settings.appearance.appIcon")}</span>
              <span className="md-body-s wp-muted">{t("settings.appearance.appIconSub")}</span>
            </div>
            <div className="wp-iconpick">
              {APP_ICONS.map((v) => (
                <button key={v.id} className={`wp-icontile ${s.appIcon === v.id ? "wp-icontile-on" : ""}`} title={v.label} onClick={() => s.setAppIcon(v.id)}>
                  <span className="wp-icontile-art" style={{ background: v.bg, color: v.fg }}>
                    {v.glyph ? <Icon name={v.glyph} size={26} /> : "W"}
                  </span>
                  <span className="wp-icontile-label">{v.label}</span>
                </button>
              ))}
            </div>
          </div>
        </>)}

        {lookTab === "background" && (<>
          <Row icon="image" title={t("settings.background")} sub={t("settings.appearance.bgSub")}>
            <Seg value={s.appBg} options={[{ id: "off", label: t("settings.appearance.bgOff") }, { id: "blur", label: t("settings.appearance.bgBlurArt") }]} onChange={s.setAppBg} />
          </Row>
          {s.appBg === "blur" && (<>
            <Row icon="visibility" title={t("settings.appearance.blurStrength")} sub={`${Math.round(s.bgBlur)}px`}>
              <div className="wp-set-slider"><Slider value={s.bgBlur} min={0} max={120} step={2} onChange={s.setBgBlur} /></div>
            </Row>
            <Row icon="palette" title={t("settings.appearance.bgSaturation")} sub={`${s.bgSaturation.toFixed(2)}×`}>
              <div className="wp-set-slider"><Slider value={s.bgSaturation} min={1} max={2.5} step={0.05} onChange={s.setBgSaturation} /></div>
            </Row>
          </>)}
          <Row icon="favorite" title={t("settings.appearance.exploreBlur")} sub={s.exploreBlur === 0 ? "Off — fastest" : `${s.exploreBlur}px · blurred album-art cards`}
            info={{ title: t("settings.appearance.exploreBlur"), body: t("settings.appearance.exploreBlur.body") }}>
            <div className="wp-set-slider"><Slider value={s.exploreBlur} min={0} max={40} step={2} onChange={s.setExploreBlur} /></div>
          </Row>
          <RestoreRow keys={["appBg", "bgBlur", "bgSaturation", "exploreBlur"]} label={t("settings.background")} />
        </>)}

        {lookTab === "layout" && (<>
          <Row icon="text" title={t("settings.textSize")} sub={`${Math.round(s.fontScale * 100)}%`}>
            <div className="wp-set-slider"><Slider value={s.fontScale} min={0.9} max={1.2} step={0.05} onChange={s.setFontScale} /></div>
          </Row>
          <Row icon="tune" title="UI zoom" sub={`${Math.round(s.uiZoom * 100)}%  ·  Ctrl +/−/0  ·  display ${(typeof window !== "undefined" ? window.devicePixelRatio : 1).toFixed(2)}×`}>
            <div className="wp-set-slider"><Slider value={s.uiZoom} min={0.5} max={1.5} step={0.05} onChange={s.setUiZoom} /></div>
          </Row>
          <Row icon="tune" title={t("settings.density")}>
            <Seg value={s.density} options={[{ id: "cozy", label: t("settings.density.cozy") }, { id: "compact", label: t("settings.density.compact") }]} onChange={s.setDensity} />
          </Row>
          <Row icon="library" title={t("settings.launchScreen")} sub={t("settings.launchScreen.sub")}>
            <Seg value={s.startScreen} options={[{ id: "last", label: t("settings.appearance.launchLast") }, { id: "library", label: t("settings.appearance.launchMusic") }, { id: "home", label: t("settings.appearance.launchForYou") }, { id: "playing", label: t("settings.appearance.launchPlayer") }, { id: "search", label: t("settings.appearance.launchSearch") }]} onChange={s.setStartScreen} />
          </Row>
          <Row icon="tune" title={t("settings.appearance.lockPortrait")} sub={t("settings.appearance.lockPortraitSub")}>
            <Switch on={s.lockPortrait} onToggle={() => s.setLockPortrait(!s.lockPortrait)} />
          </Row>
          <Row icon="tune" title={t("settings.appearance.scrollbar")} sub={t("settings.appearance.scrollbarSub")}>
            <Seg value={s.scrollbar} options={[{ id: "thin", label: t("settings.appearance.scrollbarThin") }, { id: "normal", label: t("settings.appearance.scrollbarNormal") }, { id: "overlay", label: t("settings.appearance.scrollbarOverlay") }, { id: "hidden", label: t("settings.appearance.scrollbarHidden") }]} onChange={s.setScrollbar} />
          </Row>
          <Row icon="next" title={t("settings.appearance.scrollIndicator")} sub={t("settings.appearance.scrollIndicatorSub")}>
            <Seg value={s.scrollIndicator} options={[{ id: "auto", label: t("settings.appearance.scrollAuto") }, { id: "az", label: t("settings.appearance.scrollAz") }, { id: "bubble", label: t("settings.appearance.scrollBubble") }, { id: "off", label: t("settings.appearance.scrollIndicatorOff") }]} onChange={s.setScrollIndicator} />
          </Row>
          <Row icon="image" title={t("settings.appearance.lazyCovers")} sub={s.lazyCovers ? t("settings.appearance.lazyCoversOn") : t("settings.appearance.lazyCoversOff")}
            info={{ title: t("settings.appearance.lazyCovers"), body: t("settings.appearance.lazyCovers.body") }}>
            <Switch on={s.lazyCovers} onToggle={() => s.setLazyCovers(!s.lazyCovers)} />
          </Row>
          {isAndroid && (
            <Row icon="bolt" title={t("settings.appearance.lockscreen")} sub={t("settings.appearance.lockscreenSub")}
              info={{ title: t("settings.appearance.lockscreen.infoTitle"), body: t("settings.appearance.lockscreen.body") }}>
              <Switch on={s.lockscreen} onToggle={() => s.setLockscreen(!s.lockscreen)} />
            </Row>
          )}
          <h3 className="md-title-s wp-set-head" style={{ marginTop: 6 }}>{t("settings.nav.head")}</h3>
          <Row icon="play" title={t("settings.nav.vinyl")} sub={t("settings.nav.vinylSub")}>
            <Seg value={s.navVinyl} options={[{ id: "off", label: t("settings.nav.off") }, { id: "playing", label: t("settings.nav.playing") }, { id: "always", label: t("settings.nav.always") }]} onChange={s.setNavVinyl} />
          </Row>
          <Row icon="tune" title={t("settings.nav.indicator")} sub={t("settings.nav.indicatorSub")}>
            <Seg value={s.navIndicator} options={[{ id: "pill", label: t("settings.nav.pill") }, { id: "plain", label: t("settings.nav.plain") }, { id: "shape", label: t("settings.nav.shape") }]} onChange={s.setNavIndicator} />
          </Row>
          {s.navIndicator === "shape" && (
            <>
              <div className="md-body-s wp-muted" style={{ padding: "2px 6px" }}>{t("settings.nav.shapePick")}</div>
              <div className="wp-shape-pick">
                {NAV_SHAPES.map((sh) => (
                  <button key={sh} className={`wp-shape-chip ${s.navShape === sh ? "wp-shape-chip-on" : ""}`} onClick={() => s.setNavShape(sh)} title={sh} aria-label={sh}>
                    <MaterialShape shape={sh} size={26} />
                  </button>
                ))}
              </div>
            </>
          )}
          <RestoreRow keys={["fontScale", "density", "startScreen", "lockPortrait", "scrollbar", "scrollIndicator", "lazyCovers", "lockscreen", "navVinyl", "navIndicator", "navShape"]} label={t("settings.look.layout")} />
        </>)}

        {lookTab === "player" && (<>
          <Row icon="shape" title={t("settings.appearance.audioSections")} sub={t("settings.appearance.audioSectionsSub")}>
            <Switch on={s.audioSections} onToggle={() => s.setAudioSections(!s.audioSections)} />
          </Row>
          <div className={s.audioSections ? "" : "wp-disabled"}>
            <Row icon="graphicEq" title={t("settings.appearance.seekStyle")} sub={t("settings.appearance.seekStyleSub")}>
              <Seg value={s.seekStyle} options={[{ id: "sections", label: t("settings.appearance.seekSections") }, { id: "waveform", label: t("settings.appearance.seekWave") }, { id: "wavy", label: "Wavy" }, { id: "slider", label: t("settings.appearance.seekBar") }]} onChange={s.setSeekStyle} />
            </Row>
            {s.seekStyle === "wavy" && (<>
              <Row icon="graphicEq" title="Wave height" sub={`${s.waveAmp}px`}>
                <div className="wp-set-slider"><Slider value={s.waveAmp} min={1} max={8} step={1} onChange={s.setWaveAmp} /></div>
              </Row>
              <Row icon="tune" title="Wave speed" sub={s.waveSpeed === 0 ? "Still" : `${s.waveSpeed.toFixed(1)}×`}>
                <div className="wp-set-slider"><Slider value={s.waveSpeed} min={0} max={3} step={0.5} onChange={s.setWaveSpeed} /></div>
              </Row>
            </>)}
            <Row icon="graphicEq" title={t("settings.appearance.sectionAnim")} sub={t("settings.appearance.sectionAnimSub")}>
              <Switch on={s.sectionAnim} onToggle={() => s.setSectionAnim(!s.sectionAnim)} />
            </Row>
            <Row icon="tune" title={t("settings.appearance.sectionFocus")} sub={t("settings.appearance.sectionFocusSub")}>
              <Seg value={s.sectionFocus} options={[
                { id: "auto", label: t("settings.appearance.sectionFocus.auto") },
                { id: "hold", label: t("settings.appearance.sectionFocus.hold") },
                { id: "off", label: t("settings.appearance.sectionFocus.off") },
              ]} onChange={s.setSectionFocus} />
            </Row>
          </div>
          <Row icon="allInclusive" title={t("settings.appearance.mixDetect")} sub={t("settings.appearance.mixDetectSub")}>
            <Switch on={s.mixDetect} onToggle={() => s.setMixDetect(!s.mixDetect)} />
          </Row>
          <Row icon="shape" title={t("settings.appearance.soundDna")} sub={t("settings.appearance.soundDnaSub")}>
            <Switch on={s.soundDna} onToggle={() => s.setSoundDna(!s.soundDna)} />
          </Row>
          <Group title="Tagging">
            <Row icon="edit" title="Auto-tag while playing" sub="Enrich the playing track's tags in the background (genre from on-device analysis + optional online lookup)">
              <Switch on={s.autoTag} onToggle={() => s.setAutoTag(!s.autoTag)} />
            </Row>
            <Row icon="search" title="Online tag lookup" sub="Allow MusicBrainz lookups for album / year / canonical title — sends an artist+title query online">
              <Switch on={s.tagOnline} onToggle={() => s.setTagOnline(!s.tagOnline)} />
            </Row>
            <Row icon="edit" title="Write tags into files" sub="Also save enriched tags into the audio file (off = Helios library only, never touches your files)">
              <Switch on={s.tagWriteFile} onToggle={() => s.setTagWriteFile(!s.tagWriteFile)} />
            </Row>
          </Group>
          <Row icon="eq" title={t("settings.appearance.eqValues")} sub={t("settings.appearance.eqValuesSub")}>
            <Seg value={s.eqValues} options={[
              { id: "hidden", label: t("settings.appearance.valHidden") }, { id: "db", label: "dB" }, { id: "pct", label: "%" },
            ]} onChange={s.setEqValues} />
          </Row>
          <Row icon="tune" title={t("settings.appearance.toneValues")} sub={t("settings.appearance.toneValuesSub")}>
            <Seg value={s.toneValues} options={[
              { id: "hidden", label: t("settings.appearance.valHidden") }, { id: "db", label: "dB" }, { id: "pct", label: "%" },
            ]} onChange={s.setToneValues} />
          </Row>
          <Row icon="bolt" title={t("settings.appearance.showBpm")} sub={t("settings.appearance.showBpmSub")}>
            <Switch on={s.showBpm} onToggle={() => s.setShowBpm(!s.showBpm)} />
          </Row>
          <div className={s.audioSections ? "" : "wp-disabled"}>
            <Row icon="next" title={t("settings.appearance.skipIntros")} sub={t("settings.appearance.skipIntrosSub")}>
              <Switch on={s.skipIntros} onToggle={() => s.setSkipIntros(!s.skipIntros)} />
            </Row>
          </div>
          <h3 className="md-title-s wp-set-head" style={{ marginTop: 6 }}>{t("settings.appearance.footerHead")}</h3>
          <div className="md-body-s wp-muted" style={{ padding: "0 6px 6px" }}>{t("settings.appearance.footerHint")}</div>
          {NP_FOOTER_MODES.map((m) => {
            const on = s.npFooter.includes(m.id);
            return (
              <Row key={m.id} icon="next" title={m.label}>
                <Switch on={on} onToggle={() => s.setNpFooter(on ? s.npFooter.filter((x) => x !== m.id) : [...s.npFooter, m.id])} />
              </Row>
            );
          })}
          <RestoreRow keys={["seekStyle", "sectionAnim", "sectionFocus", "mixDetect", "soundDna", "eqValues", "toneValues", "showBpm", "skipIntros", "npFooter"]} label={t("settings.look.player")} />
        </>)}
      </section>
      )}

      {sub === "library" && (
      <section className="wp-set-sec">
        {isAndroid && (
          <>
            <h3 className="md-title-s wp-set-head">{t("settings.library.quickScanHead")}</h3>
            <Row icon="bolt" title={t("settings.library.quickScan")} sub={t("settings.library.quickScanSub")}>
              <button className="wp-filled-btn wp-btn-sm" onClick={() => loadMediaStore()} disabled={scanning}>{scanning ? t("settings.library.scanning") : t("settings.library.quickScanBtn")}</button>
            </Row>
          </>
        )}
        <h3 className="md-title-s wp-set-head">{t("settings.library.foldersHead")}</h3>
        {folders.length === 0 && <div className="md-body-s wp-muted" style={{ padding: "2px 6px" }}>{hasTauri ? t("settings.library.noFoldersNative") : t("settings.library.noFoldersBrowser")}</div>}
        {folders.map((f) => (
          <div key={f} className="wp-set-row">
            <span className="wp-set-icon"><Icon name="folder" size={20} /></span>
            <div className="wp-row-text"><div className="md-body-l ellipsis">{f.split(/[\\/]/).pop() || f}</div><div className="md-body-s wp-muted ellipsis">{f}</div></div>
            <button className="md-icon-btn wp-set-control" title={t("settings.library.removeFolder")} onClick={() => removeFolder(f)}><Icon name="close" size={18} /></button>
          </div>
        ))}
        {hasTauri && (
          <Row icon="add" title={t("settings.library.addFolder")} sub={t("settings.library.addFolderSub")}>
            <button className="wp-filled-btn wp-btn-sm" onClick={() => loadFolder()}>{t("settings.library.add")}</button>
          </Row>
        )}
        <h3 className="md-title-s wp-set-head" style={{ marginTop: 6 }}>Library tabs</h3>
        <div className="md-body-s wp-muted" style={{ padding: "0 2px 4px" }}>Reorder or hide the tabs along the top of your Library.</div>
        <LibTabsEditor />
        <h3 className="md-title-s wp-set-head" style={{ marginTop: 6 }}>{t("settings.library.recentHead")}</h3>
        <Row icon="timer" title={t("settings.library.keep")} sub={t("settings.library.keepSub")}>
          <Seg value={s.recentLimit} options={[{ id: 25, label: "25" }, { id: 50, label: "50" }, { id: 100, label: "100" }, { id: 0, label: t("settings.library.recentAll") }]} onChange={s.setRecentLimit} />
        </Row>
        <Row icon="tune" title={t("settings.library.order")} sub={t("settings.library.orderSub")}>
          <Seg value={s.recentOrder} options={[{ id: "recent", label: t("settings.library.orderRecent") }, { id: "plays", label: t("settings.library.orderPlays") }, { id: "title", label: t("settings.library.orderTitle") }, { id: "artist", label: t("settings.library.orderArtist") }]} onChange={s.setRecentOrder} />
        </Row>

        <h3 className="md-title-s wp-set-head" style={{ marginTop: 6 }}>{t("settings.library.head")}</h3>
        <Row icon="library" title={t("settings.library.tracksIndexed")} sub={`${libCount} song${libCount === 1 ? "" : "s"} · ${plCount} playlist${plCount === 1 ? "" : "s"}`}>
          {hasTauri && (scanning
            ? <button className="wp-filled-btn wp-btn-sm wp-btn-danger" onClick={() => cancelIndexing()}>{t("settings.library.stop")}</button>
            : <button className="wp-filled-btn wp-btn-sm" onClick={() => rescan()}>{t("settings.library.reindexAll")}</button>)}
        </Row>
        {hasTauri && (
          <Row icon="refresh" title={t("settings.library.reindex")} sub={t("settings.library.reindexSub")}>
            <button className="wp-filled-btn wp-btn-sm" onClick={() => rescan()} disabled={scanning}>{scanning ? t("settings.library.indexing") : t("settings.library.reindexBtn")}</button>
          </Row>
        )}
        {hasTauri && (
          <Row icon="refresh" title={t("settings.library.rebuild")} sub={t("settings.library.rebuildSub")}>
            <button className="wp-filled-btn wp-btn-sm wp-btn-danger" onClick={rebuildLib} disabled={scanning}>{t("settings.library.rebuildBtn")}</button>
          </Row>
        )}
        {hasTauri && (
          <Row icon="trash" title={t("settings.library.deleteIndex")} sub={t("settings.library.deleteIndexSub")}>
            <button className="wp-filled-btn wp-btn-sm wp-btn-danger" onClick={deleteIndex}>{t("settings.library.deleteBtn")}</button>
          </Row>
        )}
      </section>
      )}

      {sub === "stats" && <Stats />}

      {sub === "taste" && hasTauri && (
        <section className="wp-set-sec">
          <h3 className="md-title-s wp-set-head">{t("settings.taste.head")}</h3>
          <Row icon="favorite" title={t("settings.taste.profile")} sub={`${taste_.tracks} song${taste_.tracks === 1 ? "" : "s"} analyzed · ${taste_.events} signals learned`}>
            <button className="wp-filled-btn wp-btn-sm" onClick={analyzeLib} disabled={analyzing}>{analyzing ? t("settings.taste.analyzing") : taste_.tracks ? t("settings.taste.reanalyze") : t("settings.taste.analyze")}</button>
          </Row>
          <Row icon="shuffle" title={t("settings.taste.discovery")} sub={s.discovery === "familiar" ? "Familiar — closer to what you already love" : s.discovery === "discover" ? "Discover — surface fresh, unheard music" : "Balanced — a mix of both"}
            info={{ title: t("settings.taste.discovery.infoTitle"), body: t("settings.taste.discovery.body") }}>
            <Seg value={s.discovery} options={[{ id: "familiar", label: t("settings.taste.familiar") }, { id: "balanced", label: t("settings.taste.balanced") }, { id: "discover", label: t("settings.taste.discover") }]} onChange={s.setDiscovery} />
          </Row>
          <Row icon="favorite" title={t("settings.taste.learn")} sub={t("settings.taste.learnSub")}
            info={{ title: t("settings.taste.learn"), body: t("settings.taste.learn.body") }}>
            <Switch on={s.tasteAutoAnalyze} onToggle={() => s.setTasteAutoAnalyze(!s.tasteAutoAnalyze)} />
          </Row>
          <Row icon="tune" title={t("settings.taste.quality")} sub={s.tastePerf === "low" ? "Low — faster, lighter, caps to ~400 songs" : "High — full accuracy, up to ~2000 songs"}
            info={{ title: t("settings.taste.quality.infoTitle"), body: t("settings.taste.quality.body") }}>
            <Seg value={s.tastePerf} options={[{ id: "low", label: t("settings.taste.low") }, { id: "high", label: t("settings.taste.high") }]} onChange={s.setTastePerf} />
          </Row>
          {analyzing && (
            <Row icon="close" title={t("settings.taste.stopAnalyzing")} sub={t("settings.taste.stopAnalyzingSub")}>
              <button className="wp-filled-btn wp-btn-sm wp-btn-danger" onClick={() => { stopRef.current = true; }}>{t("settings.taste.stop")}</button>
            </Row>
          )}
          <Row icon="shape" title={t("settings.taste.regroup")} sub={t("settings.taste.regroupSub")}>
            <button className="wp-filled-btn wp-btn-sm" onClick={recluster} disabled={!taste_.tracks || analyzing}>{t("settings.taste.regroupBtn")}</button>
          </Row>
          <Row icon="search" title={t("settings.taste.lastfm")} sub={s.lastfmKey ? t("settings.taste.lastfmConnected") : t("settings.taste.lastfmOff")}
            info={{ title: t("settings.taste.lastfm.infoTitle"), body: t("settings.taste.lastfm.body") }}>
            <button className="wp-text-btn wp-btn-sm" onClick={() => openUrl("https://www.last.fm/api/account/create")}>{t("settings.taste.getKey")}</button>
          </Row>
          <input className="wp-text-input" type="text" value={s.lastfmKey} placeholder={t("settings.taste.lastfmPlaceholder")} onChange={(e) => s.setLastfmKey(e.target.value.trim())} spellCheck={false} autoComplete="off" />
          <Row icon="favorite" title={t("settings.taste.openForYou")} sub={t("settings.taste.openForYouSub")}>
            <button className="wp-filled-btn wp-btn-sm" onClick={() => setTab("home")}>{t("settings.taste.open")}</button>
          </Row>
          <Row icon="trash" title={t("settings.taste.reset")} sub={t("settings.taste.resetSub")}>
            <button className="wp-filled-btn wp-btn-sm wp-btn-danger" onClick={resetTaste} disabled={!taste_.events}>{t("settings.taste.resetBtn")}</button>
          </Row>
        </section>
      )}

      {sub === "playback" && (
      <section className="wp-set-sec">
        <h3 className="md-title-s wp-set-head">{t("settings.playback.head")}</h3>
        <Row icon="volume" title={t("settings.playback.normalize")} sub={t("settings.playback.normalizeSub")}>
          <Switch on={s.normalize} onToggle={() => s.setNormalize(!s.normalize)} />
        </Row>
        <Row icon="bolt" title={t("settings.playback.autoEq")} sub={t("settings.playback.autoEqSub")}
          info={{ title: t("settings.playback.autoEq.infoTitle"), body: t("settings.playback.autoEq.body") }}>
          <Switch on={s.autoEqPerSong} onToggle={() => s.setAutoEqPerSong(!s.autoEqPerSong)} />
        </Row>
        <Row icon="timer" title={t("settings.playback.sleepTimer")} sub={sleep.endsAt ? `Pausing in ${Math.ceil(sleepRemaining(sleep.endsAt) / 60)} min` : t("settings.playback.sleepTimerSub")}>
          <div className="wp-seg wp-seg-sm">
            {[0, 15, 30, 45, 60].map((m) => (
              <button key={m} className={`wp-seg-item ${sleep.minutes === m ? "wp-seg-on" : ""}`}
                onClick={() => (m === 0 ? sleep.cancel() : sleep.start(m))}>{m === 0 ? t("settings.playback.sleepOff") : m}</button>
            ))}
          </div>
        </Row>
        <Row icon="tune" title={t("settings.playback.speed")} sub={`${s.speed.toFixed(2)}×`}>
          <div className="wp-set-slider"><Slider value={s.speed} min={0.5} max={2} step={0.05} onChange={s.setSpeed} /></div>
        </Row>
        <Row icon="bolt" title={t("settings.playback.pitchLock")} sub={t("settings.playback.pitchLockSub")}>
          <Switch on={s.pitchLock} onToggle={() => s.setPitchLock(!s.pitchLock)} />
        </Row>
        <Row icon="play" title={t("settings.playback.openPlayer")} sub={t("settings.playback.openPlayerSub")}>
          <Switch on={s.openPlayerOnPlay} onToggle={() => s.setOpenPlayerOnPlay(!s.openPlayerOnPlay)} />
        </Row>
        <Row icon="refresh" title={t("settings.playback.resume")} sub={t("settings.playback.resumeSub")}>
          <Switch on={s.resumeOnStart} onToggle={() => s.setResumeOnStart(!s.resumeOnStart)} />
        </Row>
        {s.resumeOnStart && (
          <Row icon="queue" title={t("settings.playback.restore")} sub={s.resumeScope === "session" ? t("settings.playback.restoreQueue") : t("settings.playback.restoreTrack")}>
            <Seg value={s.resumeScope} options={[{ id: "track", label: t("settings.playback.restoreTrackOpt") }, { id: "session", label: t("settings.playback.restoreQueueOpt") }]} onChange={s.setResumeScope} />
          </Row>
        )}
        <Row icon="prev" title={t("settings.playback.rewind")} sub={t("settings.playback.rewindSub")}>
          <Seg value={s.rewindOnResume} options={[{ id: 0, label: t("settings.playback.rewindOff") }, { id: 5, label: "5s" }, { id: 10, label: "10s" }, { id: 15, label: "15s" }]} onChange={s.setRewindOnResume} />
        </Row>
        <Row icon="bolt" title={t("settings.playback.fadeOnPause")} sub={t("settings.playback.fadeOnPauseSub")}>
          <Switch on={s.fadeOnPause} onToggle={() => s.setFadeOnPause(!s.fadeOnPause)} />
        </Row>
        <Row icon="graphicEq" title={t("settings.playback.fadeOnSeek")} sub={t("settings.playback.fadeOnSeekSub")}>
          <Switch on={s.fadeOnSeek} onToggle={() => s.setFadeOnSeek(!s.fadeOnSeek)} />
        </Row>
        <Row icon="timer" title={t("settings.playback.trackGap")} sub={t("settings.playback.trackGapSub")}>
          <Seg value={s.trackGap} options={[
            { id: 0, label: t("settings.playback.rewindOff") }, { id: 500, label: "0.5s" }, { id: 1000, label: "1s" }, { id: 2000, label: "2s" }, { id: 4500, label: "4.5s" },
          ]} onChange={s.setTrackGap} />
        </Row>
        <Row icon="visibility" title={t("settings.playback.keepScreenOn")} sub={t("settings.playback.keepScreenOnSub")}>
          <Switch on={s.keepScreenOn} onToggle={() => s.setKeepScreenOn(!s.keepScreenOn)} />
        </Row>
        {isAndroid && (
          <Row icon="queue" title={t("settings.playback.notifButtons")}
            sub={s.notifButtons.map((b) => nbDef(b).label).join(" · ")}
            info={{ title: t("settings.playback.notifButtons.infoTitle"), body: t("settings.playback.notifButtons.body") }}>
            <button className="wp-swipe-pick" onClick={() => setNotifOpen(true)}>{s.notifButtons.length} <Icon name="next" size={16} /></button>
          </Row>
        )}
        {isAndroid && (
          <Row icon="visibility" title={t("settings.playback.notifText")} sub={t("settings.playback.notifTextSub")}>
            <Seg value={s.notifText} options={[
              { id: "artist-album", label: t("settings.playback.notifText.artistAlbum") },
              { id: "artist", label: t("settings.playback.notifText.artist") },
              { id: "album", label: t("settings.playback.notifText.album") },
              { id: "none", label: t("settings.playback.notifText.none") },
            ]} onChange={s.setNotifText} />
          </Row>
        )}
        {isAndroid && (
          <Row icon="image" title={t("settings.playback.notifIcon")} sub={t("settings.playback.notifIconSub")}>
            <div className="wp-notificon-pick">
              {([["note","music"],["play","play"],["wave","graphicEq"],["eq","eq"],["bolt","bolt"],["pulse","volume"]] as const).map(([id, glyph]) => (
                <button key={id} className={`wp-notificon ${s.notifIcon === id ? "wp-notificon-on" : ""}`} title={id} onClick={() => s.setNotifIcon(id)}>
                  <Icon name={glyph} size={20} />
                </button>
              ))}
            </div>
          </Row>
        )}
        {isAndroid && (
          <Row icon="queue" title={t("settings.playback.notifStyle")} sub={t("settings.playback.notifStyleSub")}>
            <Seg value={s.notifStyle} options={[
              { id: "media", label: t("settings.playback.notifStyle.media") },
              { id: "plain", label: t("settings.playback.notifStyle.plain") },
            ]} onChange={s.setNotifStyle} />
          </Row>
        )}
        {hasTauri && typeof navigator !== "undefined" && !/Android/i.test(navigator.userAgent) && (
          <Row icon="graphicEq" title={t("settings.playback.nativeEngine")} sub={t("settings.playback.nativeEngineSub")}>
            <Switch on={s.nativeAudio} onToggle={() => s.setNativeAudio(!s.nativeAudio)} />
          </Row>
        )}
        <div className="wp-set-card">
          <button className="wp-set-open" onClick={() => setTransOpen(true)}>
            <span className="wp-set-open-ico"><Icon name="graphicEq" size={22} color="var(--md-primary)" /></span>
            <span className="wp-row-text">
              <span className="md-body-l">{t("settings.playback.transitions")}</span>
              <span className="md-body-s wp-muted">
                {s.crossfade > 0
                  ? `Crossfade ${s.crossfade % 1 === 0 ? s.crossfade : s.crossfade.toFixed(1)}s · ${s.crossfadeCurve === "equal" ? "equal power" : s.crossfadeCurve}`
                  : s.gapless ? "Gapless · no fade" : "Hard cut"}
              </span>
            </span>
            <span className="wp-set-open-go"><Icon name="next" size={18} /></span>
          </button>
        </div>
        {s.crossfade > 0 && (
          <Row icon="shuffle" title={t("settings.playback.crossfadeManual")} sub={s.crossfadeManual ? t("settings.playback.crossfadeManualOn") : t("settings.playback.crossfadeManualOff")}>
            <Switch on={s.crossfadeManual} onToggle={() => s.setCrossfadeManual(!s.crossfadeManual)} />
          </Row>
        )}
        {s.crossfade > 0 && (
          <Row icon="library" title={t("settings.playback.crossfadeAlbum")} sub={s.crossfadeSameAlbum ? t("settings.playback.crossfadeAlbumOn") : t("settings.playback.crossfadeAlbumOff")}>
            <Switch on={s.crossfadeSameAlbum} onToggle={() => s.setCrossfadeSameAlbum(!s.crossfadeSameAlbum)} />
          </Row>
        )}
        <Row icon="next" title={t("settings.playback.queueEnd")} sub={s.queueEndAction === "endless" ? t("settings.playback.queueEndEndless") : t("settings.playback.queueEndStop")}>
          <Seg value={s.queueEndAction} options={[{ id: "stop", label: t("settings.playback.queueEndStopOpt") }, { id: "endless", label: t("settings.playback.queueEndEndlessOpt") }]} onChange={s.setQueueEndAction} />
        </Row>
        <Row icon="close" title={t("settings.playback.stopAfter")} sub={t("settings.playback.stopAfterSub")}>
          <Switch on={stopAfterCurrent} onToggle={() => usePlayer.getState().setStopAfterCurrent(!stopAfterCurrent)} />
        </Row>
        <Row icon="graphicEq" title={t("settings.playback.scrubScratch")} sub={t("settings.playback.scrubScratchSub")}>
          <Switch on={s.scrubScratch} onToggle={() => s.setScrubScratch(!s.scrubScratch)} />
        </Row>

        <h3 className="md-title-s wp-set-head" style={{ marginTop: 6 }}>{t("settings.interruptions.head")}</h3>
        <Row icon="volume" title={t("settings.interruptions.focus")} sub={s.audioFocus === "duck" ? t("settings.interruptions.focusDuck") : s.audioFocus === "pause" ? t("settings.interruptions.focusPause") : t("settings.interruptions.focusIgnore")}
          info={{ title: t("settings.interruptions.focus.infoTitle"), body: t("settings.interruptions.focus.body") }}>
          <Seg value={s.audioFocus} options={[{ id: "duck", label: t("settings.interruptions.duck") }, { id: "pause", label: t("settings.interruptions.pause") }, { id: "ignore", label: t("settings.interruptions.ignore") }]} onChange={s.setAudioFocus} />
        </Row>
        {s.audioFocus !== "ignore" && (
          <Row icon="refresh" title={t("settings.interruptions.autoResume")} sub={t("settings.interruptions.autoResumeSub")}>
            <Switch on={s.audioFocusResume} onToggle={() => s.setAudioFocusResume(!s.audioFocusResume)} />
          </Row>
        )}
        <Row icon="bolt" title={t("settings.interruptions.pauseDisconnect")} sub={t("settings.interruptions.pauseDisconnectSub")}>
          <Switch on={s.btPauseOnDisconnect} onToggle={() => s.setBtPauseOnDisconnect(!s.btPauseOnDisconnect)} />
        </Row>
        <Row icon="bolt" title={t("settings.interruptions.resumeConnect")} sub={t("settings.interruptions.resumeConnectSub")}>
          <Switch on={s.btResumeOnConnect} onToggle={() => s.setBtResumeOnConnect(!s.btResumeOnConnect)} />
        </Row>

        <Row icon="lyrics" title={t("settings.playback.lyrics")} sub={t("settings.playback.lyricsSub")}>
          <Seg value={s.lyricsProvider} options={LYRICS_PROVIDERS} onChange={s.setLyricsProvider} />
        </Row>

        <h3 className="md-title-s wp-set-head" style={{ marginTop: 6 }}>{t("settings.swipe.head")}</h3>
        <Row icon="next" title={t("settings.swipe.right")} sub={t("settings.swipe.rightSub")}>
          <button className="wp-swipe-pick" onClick={() => setSwipePick("right")}>
            <Icon name={swipeDef(s.swipeRight).icon} size={18} /> {swipeDef(s.swipeRight).label}
          </button>
        </Row>
        <Row icon="prev" title={t("settings.swipe.left")} sub={t("settings.swipe.leftSub")}>
          <button className="wp-swipe-pick" onClick={() => setSwipePick("left")}>
            <Icon name={swipeDef(s.swipeLeft).icon} size={18} /> {swipeDef(s.swipeLeft).label}
          </button>
        </Row>
        <div className="md-body-s wp-muted" style={{ padding: "0 6px" }}>{t("settings.swipe.note")}</div>
        <RestoreRow keys={["normalize", "speed", "pitchLock", "crossfade", "crossfadeCurve", "crossfadeManual", "crossfadeSameAlbum", "queueEndAction", "audioFocus", "audioFocusResume", "btResumeOnConnect", "btPauseOnDisconnect", "scrubScratch", "gapless", "lyricsProvider", "resumeOnStart", "resumeScope", "openPlayerOnPlay", "fadeOnPause", "fadeOnSeek", "trackGap", "rewindOnResume", "keepScreenOn", "swipeRight", "swipeLeft", "notifButtons", "notifText", "notifIcon", "notifStyle"]} label={t("settings.playback")} />
      </section>
      )}

      {sub === "audio" && (
      <section className="wp-set-sec">
        <h3 className="md-title-s wp-set-head">{t("settings.audio.outputHead")}</h3>
        <Row icon="graphicEq" title={t("settings.audio.outputDevices")} sub={t("settings.audio.outputDevicesSub")}
          info={{ title: t("settings.audio.output.infoTitle"), body: t("settings.audio.output.body") }}>
          <button className="wp-swipe-pick" onClick={() => setOutOpen(true)}>{t("settings.audio.configure")} <Icon name="next" size={16} /></button>
        </Row>

        <h3 className="md-title-s wp-set-head" style={{ marginTop: 6 }}>{t("settings.audio.analysisHead")}</h3>
        <Row icon="bolt" title={t("settings.audio.bpm")} sub={s.bpmAlgo === "native" ? t("settings.audio.bpmNative") : t("settings.audio.bpmFast")}
          info={{ title: t("settings.audio.bpm.infoTitle"), body: t("settings.audio.bpm.body") }}>
          <Seg value={s.bpmAlgo} options={[{ id: "native", label: t("settings.audio.bpmNativeOpt") }, { id: "fast", label: t("settings.audio.bpmFastOpt") }]} onChange={s.setBpmAlgo} />
        </Row>
        <div className={s.audioSections ? "" : "wp-disabled"}>
          <Row icon="shape" title={t("settings.audio.sections")} sub={s.sectionAlgo === "structural" ? t("settings.audio.sectionsStructural") : t("settings.audio.sectionsEnergy")}
            info={{ title: t("settings.audio.sections.infoTitle"), body: t("settings.audio.sections.body") }}>
            <Seg value={s.sectionAlgo} options={[{ id: "structural", label: t("settings.audio.sectionsStructuralOpt") }, { id: "energy", label: t("settings.audio.sectionsEnergyOpt") }]} onChange={s.setSectionAlgo} />
          </Row>
        </div>
        <div className="md-body-s wp-muted" style={{ padding: "0 6px" }}>{t("settings.audio.analysisNote")}</div>

        {hasTauri && typeof navigator !== "undefined" && !/Android/i.test(navigator.userAgent) && (
          <>
            <h3 className="md-title-s wp-set-head" style={{ marginTop: 8 }}>{t("settings.audio.engineHead")}</h3>
            <Row icon="graphicEq" title={t("settings.audio.nativeEngine")} sub={t("settings.audio.nativeEngineSub")}>
              <Switch on={s.nativeAudio} onToggle={() => s.setNativeAudio(!s.nativeAudio)} />
            </Row>
            {s.nativeAudio && (
              <>
                <Row icon="bolt" title={t("settings.audio.clipPrevent")} sub={t("settings.audio.clipPreventSub")}
                  info={{ title: t("settings.audio.clipPrevent.infoTitle"), body: t("settings.audio.clipPrevent.body") }}>
                  <Switch on={s.clipPrevent} onToggle={() => s.setClipPrevent(!s.clipPrevent)} />
                </Row>
                <Row icon="graphicEq" title={t("settings.audio.dither")} sub={s.ditherBits === 0 ? t("settings.audio.ditherOff") : `${s.ditherBits}-bit TPDF`}
                  info={{ title: t("settings.audio.dither.infoTitle"), body: t("settings.audio.dither.body") }}>
                  <Seg value={s.ditherBits} options={[{ id: 0, label: t("settings.audio.ditherOff") }, { id: 16, label: "16" }, { id: 24, label: "24" }]} onChange={s.setDitherBits} />
                </Row>
              </>
            )}
          </>
        )}
        <Row icon="volume" title={t("settings.audio.normalize")} sub={t("settings.audio.normalizeSub")}>
          <Switch on={s.normalize} onToggle={() => s.setNormalize(!s.normalize)} />
        </Row>

        <h3 className="md-title-s wp-set-head" style={{ marginTop: 8 }}>{t("settings.audio.outputHead2")}</h3>
        <Row icon="volume" title={t("settings.audio.mono")} sub={t("settings.audio.monoSub")}>
          <Switch on={s.monoOutput} onToggle={() => s.setMonoOutput(!s.monoOutput)} />
        </Row>
        <Row icon="tune" title={t("settings.audio.balance")}
          sub={s.balance === 0 ? "Centered" : s.balance < 0 ? `${Math.round(-s.balance * 100)}% left` : `${Math.round(s.balance * 100)}% right`}>
          <div className="wp-set-slider"><Slider value={s.balance} min={-1} max={1} step={0.05} onChange={s.setBalance} /></div>
        </Row>
        <div className="md-body-s wp-muted" style={{ padding: "0 6px" }}>{t("settings.audio.balanceNote")}</div>
        <RestoreRow keys={["bpmAlgo", "sectionAlgo", "nativeAudio", "balance", "monoOutput", "clipPrevent", "ditherBits", "normalize", "output"]} label={t("settings.audio")} />
      </section>
      )}

      {SHOW_VISUALIZER && sub === "visualizer" && (
      <section className="wp-set-sec">
        <h3 className="md-title-s wp-set-head">{t("settings.visualizer.head")}</h3>
        <Row icon="image" title={t("settings.visualizer.exportRes")}><Seg value={s.exportRes} options={RES} onChange={s.setExportRes} /></Row>
        <Row icon="graphicEq" title={t("settings.visualizer.exportFps")}><Seg value={s.exportFps} options={FPS} onChange={s.setExportFps} /></Row>
        <Row icon="bolt" title={t("settings.visualizer.fpsCap")} sub={t("settings.visualizer.fpsCapSub")}><Seg value={s.fpsCap} options={CAP} onChange={s.setFpsCap} /></Row>
        <Row icon="battery" title={t("settings.visualizer.lowPower")} sub={t("settings.visualizer.lowPowerSub")}>
          <Switch on={s.lowPower} onToggle={() => s.setLowPower(!s.lowPower)} />
        </Row>
        <RestoreRow keys={["exportRes", "exportFps", "fpsCap", "lowPower"]} label={t("settings.visualizer")} />
      </section>
      )}

      {sub === "performance" && (
      <section className="wp-set-sec">
        <h3 className="md-title-s wp-set-head">{t("settings.performance.presetHead")}</h3>
        <div className="md-body-s wp-muted" style={{ padding: "0 6px 8px" }}>
          {t("settings.performance.presetIntro")}
        </div>
        <div className="wp-perf-grid">
          {PERF_CARDS.map((c) => (
            <button key={c.id} className={`wp-perf-card ${s.perfMode === c.id ? "on" : ""}`} onClick={() => s.setPerfMode(c.id)}>
              <span className="wp-perf-card-ico"><Icon name={c.icon} size={22} /></span>
              <span className="md-title-s">{c.label}</span>
              <span className="md-body-s wp-muted">{c.sub}</span>
            </button>
          ))}
        </div>

        <h3 className="md-title-s wp-set-head" style={{ marginTop: 8 }}>{t("settings.performance.visualsHead")}</h3>
        <Row icon="bolt" title={t("settings.performance.fpsCap")} sub={t("settings.performance.fpsCapSub")}>
          <Seg value={s.fpsCap} options={CAP} onChange={(v) => perfTweak(() => s.setFpsCap(v))} />
        </Row>
        <Row icon="battery" title={t("settings.performance.lowPower")} sub={t("settings.performance.lowPowerSub")}>
          <Switch on={s.lowPower} onToggle={() => perfTweak(() => s.setLowPower(!s.lowPower))} />
        </Row>
        <Row icon="image" title={t("settings.performance.motion")} sub={s.uiAnimations === "off" ? t("settings.performance.motionOff") : s.uiAnimations === "reduced" ? t("settings.performance.motionReduced") : t("settings.performance.motionFull")}
          info={{ title: t("settings.performance.motion.infoTitle"), body: t("settings.performance.motion.body") }}>
          <Seg value={s.uiAnimations} options={[{ id: "full", label: t("settings.performance.motionFullOpt") }, { id: "reduced", label: t("settings.performance.motionReducedOpt") }, { id: "off", label: t("settings.performance.motionOffOpt") }]} onChange={s.setUiAnimations} />
        </Row>

        <h3 className="md-title-s wp-set-head" style={{ marginTop: 8 }}>{t("settings.performance.libraryHead")}</h3>
        <Row icon="image" title={t("settings.performance.coverCache")} sub={`${s.coverCacheSize} covers kept in memory`}
          info={{ title: t("settings.performance.coverCache.infoTitle"), body: t("settings.performance.coverCache.body") }}>
          <div className="wp-set-slider"><Slider value={s.coverCacheSize} min={200} max={3000} step={100} onChange={s.setCoverCacheSize} /></div>
        </Row>
        <Row icon="image" title={t("settings.performance.lazyCovers")} sub={s.lazyCovers ? t("settings.performance.lazyCoversOn") : t("settings.performance.lazyCoversOff")}>
          <Switch on={s.lazyCovers} onToggle={() => perfTweak(() => s.setLazyCovers(!s.lazyCovers))} />
        </Row>
        <Row icon="search" title={t("settings.performance.liveSearch")} sub={s.liveSearch ? t("settings.performance.liveSearchOn") : t("settings.performance.liveSearchOff")}
          info={{ title: t("settings.performance.liveSearch.infoTitle"), body: t("settings.performance.liveSearch.body") }}>
          <Switch on={s.liveSearch} onToggle={() => s.setLiveSearch(!s.liveSearch)} />
        </Row>
        {s.liveSearch && (
          <Row icon="timer" title={t("settings.performance.searchDelay")} sub={`${s.searchDebounce} ms after a keystroke`}>
            <div className="wp-set-slider"><Slider value={s.searchDebounce} min={0} max={600} step={20} onChange={s.setSearchDebounce} /></div>
          </Row>
        )}
        {hasTauri && (
          <Row icon="library" title={t("settings.performance.dbBrowse")} sub={s.dbBrowse ? t("settings.performance.dbBrowseOn") : t("settings.performance.dbBrowseOff")}
            info={{ title: t("settings.performance.dbBrowse.infoTitle"), body: t("settings.performance.dbBrowse.body") }}>
            <Switch on={s.dbBrowse} onToggle={() => s.setDbBrowse(!s.dbBrowse)} />
          </Row>
        )}

        <h3 className="md-title-s wp-set-head" style={{ marginTop: 8 }}>{t("settings.performance.analysisHead")}</h3>
        <Row icon="bolt" title={t("settings.performance.whenAnalyze")} sub={s.analysisMode === "onplay" ? t("settings.performance.whenAnalyzeOnplay") : s.analysisMode === "idle" ? t("settings.performance.whenAnalyzeIdle") : t("settings.performance.whenAnalyzeOff")}
          info={{ title: t("settings.performance.whenAnalyze.infoTitle"), body: t("settings.performance.whenAnalyze.body") }}>
          <Seg value={s.analysisMode} options={[{ id: "onplay", label: t("settings.performance.onplay") }, { id: "idle", label: t("settings.performance.idle") }, { id: "off", label: t("settings.performance.analysisOff") }]} onChange={s.setAnalysisMode} />
        </Row>
        <Row icon="tune" title={t("settings.performance.quality")} sub={s.tastePerf === "low" ? t("settings.performance.qualityLow") : t("settings.performance.qualityHigh")}>
          <Seg value={s.tastePerf} options={[{ id: "low", label: t("settings.performance.low") }, { id: "high", label: t("settings.performance.high") }]} onChange={(v) => perfTweak(() => s.setTastePerf(v))} />
        </Row>

        <h3 className="md-title-s wp-set-head" style={{ marginTop: 8 }}>{t("settings.performance.batteryHead")}</h3>
        <Row icon="battery" title={t("settings.performance.batterySaver")} sub={t("settings.performance.batterySaverSub")}
          info={{ title: t("settings.performance.batterySaver.infoTitle"), body: t("settings.performance.batterySaver.body") }}>
          <Switch on={s.batterySaver} onToggle={() => s.setBatterySaver(!s.batterySaver)} />
        </Row>
        <Row icon="bolt" title="Lag monitor" sub="Live frame-time + main-thread-stall HUD — catches the big lags (note the ms + what you did)">
          <Switch on={s.lagMonitor} onToggle={() => s.setLagMonitor(!s.lagMonitor)} />
        </Row>
        <div className="md-body-s wp-muted" style={{ padding: "2px 6px" }}>
          {t("settings.performance.dynamicNote")}
        </div>
        <RestoreRow keys={["perfMode", "fpsCap", "lowPower", "uiAnimations", "coverCacheSize", "lazyCovers", "liveSearch", "searchDebounce", "analysisMode", "tastePerf", "batterySaver", "dbBrowse"]} label={t("settings.performance")} />
      </section>
      )}

      {sub === "connect" && (
      <section className="wp-set-sec">
        <h3 className="md-title-s wp-set-head">{t("settings.connect.lanHead")}</h3>
        <Row icon="cast" title={t("settings.connect.shareLan")} sub={t("settings.connect.shareLanSub")}
          info={{ title: t("settings.connect.shareLan.infoTitle"), body: t("settings.connect.shareLan.body") }}>
          <Switch on={s.streamLan} onToggle={() => s.setStreamLan(!s.streamLan)} />
        </Row>
        {s.streamLan && (
          <div className="md-body-s wp-muted" style={{ padding: "2px 8px 4px" }}>
            {t("settings.connect.lanNote")}
          </div>
        )}

        <h3 className="md-title-s wp-set-head" style={{ marginTop: 8 }}>{t("settings.connect.btHead")}</h3>
        <Row icon="cast" title={t("settings.connect.btEq")} sub={t("settings.connect.btEqSub")}
          info={{ title: t("settings.connect.btEq.infoTitle"), body: t("settings.connect.btEq.body") }}>
          <Switch on={s.btAutoEq} onToggle={() => s.setBtAutoEq(!s.btAutoEq)} />
        </Row>
        {s.btAutoEq && <BtDevicesEditor />}

        <h3 className="md-title-s wp-set-head" style={{ marginTop: 8 }}>Online streams</h3>
        <div className="md-body-s wp-muted" style={{ padding: "0 2px 6px" }}>Play any direct audio stream, .m3u or .pls — internet radio, shoutcast, etc.</div>
        <StreamOpener />
        <RadioLauncher />
        <JamendoLauncher />
        <SubsonicLauncher />
        <PodcastLauncher />
        <ExtensionLauncher />
        <RestoreRow keys={["streamLan", "btAutoEq", "btEqMap"]} label={t("settings.connect")} />
      </section>
      )}

      {sub === "backup" && (
      <section className="wp-set-sec">
        <h3 className="md-title-s wp-set-head">{t("settings.backup.head")}</h3>
        <input ref={importRef} type="file" accept=".json,application/json" style={{ display: "none" }}
          onChange={(e) => { onImport(e.target.files?.[0]); e.target.value = ""; }} />
        <Row icon="copy" title={t("settings.backup.export")} sub={t("settings.backup.exportSub")}>
          <button className="wp-filled-btn wp-btn-sm" onClick={exportAll}>{t("settings.backup.exportBtn")}</button>
        </Row>
        <Row icon="add" title={t("settings.backup.import")} sub={t("settings.backup.importSub")}>
          <button className="wp-filled-btn wp-btn-sm" onClick={() => importRef.current?.click()}>{t("settings.backup.importBtn")}</button>
        </Row>
        <Row icon="trash" title={t("settings.backup.reset")} sub={t("settings.backup.resetSub")}>
          <button className="wp-filled-btn wp-btn-sm wp-btn-danger" onClick={reset}>{t("settings.backup.resetBtn")}</button>
        </Row>
        {backupMsg && <div className="md-body-s wp-muted" style={{ padding: "2px 6px" }}>{backupMsg}</div>}
      </section>
      )}

      {sub === "about" && (
      <section className="wp-set-sec">
        <h3 className="md-title-s wp-set-head">{t("settings.about.head")}</h3>
        <Row icon="hub" title={t("settings.about.intro")} sub={t("settings.about.introSub")}>
          <button className="wp-filled-btn wp-btn-sm" onClick={() => import("@/store/ui").then((m) => m.useUi.getState().openIntro())}>{t("settings.about.view")}</button>
        </Row>
        <Row icon="graphicEq" title={t("settings.about.app")} />
        <Row icon="hub" title={t("settings.about.version")} sub={`${APP_VERSION} · ${hasTauri ? "native" : "browser preview"}`} />
        <Row icon="bolt" title="What's new" sub={`Release notes for v${APP_VERSION}`}>
          <button className="wp-filled-btn wp-btn-sm" onClick={() => setPreviewWhatsNew(true)}>View</button>
        </Row>
        {previewWhatsNew && <WhatsNew force onClose={() => setPreviewWhatsNew(false)} />}
        {UPDATE_MANIFEST_URL && (
          <Row icon="refresh" title="Check for updates" sub="Download the latest version">
            <button className="wp-filled-btn wp-btn-sm" onClick={async () => {
              const u = await checkForUpdate();
              if (!u) { toast.success(`You're up to date · v${APP_VERSION}`); return; }
              const tt = toast.info(`Update available · v${u.version}`);
              void tt; void import("@/lib/backend").then((m) => m.openUrl(u.url));
            }}>Check</button>
          </Row>
        )}
      </section>
      )}
      </div>{/* /wp-set-pane */}

      {notifOpen && (
        <Sheet onClose={() => setNotifOpen(false)} tall={false}>
          <header className="wp-sheet-head">
            <Icon name="queue" size={22} color="var(--md-primary)" />
            <div className="wp-row-text"><div className="md-title-s">{t("settings.notif.head")}</div>
              <div className="md-body-s wp-muted">Drag order with the arrows · first 3 show collapsed · max {NOTIF_BUTTONS_MAX}</div></div>
          </header>
          <div className="wp-sheet-actions">
            {s.notifButtons.map((id, i) => (
              <div key={id} className={`wp-sheet-item ${i < 3 ? "wp-sheet-hero" : ""}`}>
                <Icon name={nbDef(id).icon} size={20} color={i < 3 ? "var(--md-primary)" : undefined} />
                <span className="md-body-l" style={{ flex: 1 }}>{nbDef(id).label}{i < 3 && <span className="md-body-s wp-muted">{t("settings.notif.collapsed")}</span>}</span>
                <button className="md-icon-btn wp-icon-sm" title={t("settings.notif.moveUp")} disabled={i === 0} onClick={() => nbMove(i, -1)}><Icon name="up" size={18} /></button>
                <button className="md-icon-btn wp-icon-sm" title={t("settings.notif.moveDown")} disabled={i === s.notifButtons.length - 1} onClick={() => nbMove(i, 1)}><Icon name="down" size={18} /></button>
                <button className="md-icon-btn wp-icon-sm" title={t("settings.notif.remove")} disabled={s.notifButtons.length <= 1} onClick={() => nbRemove(i)}><Icon name="close" size={18} /></button>
              </div>
            ))}
          </div>
          {s.notifButtons.length < NOTIF_BUTTONS_MAX && NOTIF_BUTTONS.some((b) => !s.notifButtons.includes(b.id)) && (
            <>
              <div className="md-label-m wp-muted" style={{ padding: "8px 16px 4px" }}>{t("settings.notif.addHead")}</div>
              <div className="wp-sheet-actions">
                {NOTIF_BUTTONS.filter((b) => !s.notifButtons.includes(b.id)).map((b) => (
                  <button key={b.id} className="wp-sheet-item" onClick={() => nbAdd(b.id)}>
                    <Icon name={b.icon} size={20} />
                    <span className="md-body-l" style={{ flex: 1 }}>{b.label}</span>
                    <Icon name="add" size={18} color="var(--md-primary)" />
                  </button>
                ))}
              </div>
            </>
          )}
        </Sheet>
      )}

      {transOpen && <TransitionStudio onClose={() => setTransOpen(false)} />}

      {langPick && (
        <Sheet onClose={() => setLangPick(false)} tall={false}>
          <header className="wp-sheet-head">
            <Icon name="hub" size={22} color="var(--md-primary)" />
            <div className="wp-row-text"><div className="md-title-s">{t("settings.language")}</div>
              <div className="md-body-s wp-muted">{t("settings.language.desc")}</div></div>
          </header>
          <div className="wp-sheet-actions">
            {LANGUAGES.map((l) => (
              <button key={l.id} className={`wp-sheet-item ${l.id === lang ? "wp-sheet-hero" : ""}`}
                onClick={() => { useI18n.getState().setLang(l.id); setLangPick(false); }}>
                <span className="md-body-l">{l.native}</span>
                <span className="md-body-s wp-muted">{l.label}</span>
                {l.id === lang && <Icon name="check" size={18} color="var(--md-primary)" />}
              </button>
            ))}
          </div>
        </Sheet>
      )}

      {swipePick && (
        <Sheet onClose={() => setSwipePick(null)} tall={false}>
          <header className="wp-sheet-head">
            <div className="wp-row-text">
              <div className="md-title-s">Swipe {swipePick}</div>
              <div className="md-body-s wp-muted">Pick the action for a {swipePick} swipe on a song</div>
            </div>
          </header>
          <div className="wp-sheet-actions">
            {SWIPE_ACTIONS.filter((a) => a.assignable).map((a) => {
              const cur = (swipePick === "right" ? s.swipeRight : s.swipeLeft) === a.id;
              return (
                <button key={a.id} className={`wp-sheet-item ${cur ? "wp-sheet-hero" : ""}`}
                  onClick={() => { s.setSwipe(swipePick, a.id); setSwipePick(null); }}>
                  <Icon name={a.icon} size={22} color={cur ? "var(--md-primary)" : undefined} />
                  <span className="md-body-l">{a.label}</span>
                  {cur && <Icon name="check" size={18} color="var(--md-primary)" />}
                </button>
              );
            })}
          </div>
        </Sheet>
      )}
    </div>
  );
}
