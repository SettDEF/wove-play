import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useViz, TEMPLATES, type Aspect } from "@/store/viz";
import { usePlayer } from "@/store/player";
import { Visualizer } from "./Visualizer";
import { FloatingPanel } from "./viz/FloatingPanel";
import { ContextMenu, type MenuItem } from "./viz/ContextMenu";
import { LayerList, addLayerItems } from "./viz/LayerList";
import { LayerProps } from "./viz/LayerProps";
import { ExportPanel } from "./viz/ExportPanel";
import { RendererControls } from "./viz/RendererControls";
import { PresetBar } from "./viz/PresetBar";
import { useBackGuard } from "@/lib/backStack";
import { Icon } from "./Icons";

const ASPECTS: Aspect[] = ["16:9", "9:16", "1:1", "fit"];
const TABS = [{ id: "layers", label: "Layers" }, { id: "scenes", label: "Scenes" }, { id: "props", label: "Properties" }, { id: "export", label: "Export" }] as const;

function aspectBox(aspect: Aspect, vw: number, vh: number) {
  if (aspect === "fit") return { w: vw, h: vh };
  const [aw, ah] = aspect === "16:9" ? [16, 9] : aspect === "9:16" ? [9, 16] : [1, 1];
  const r = aw / ah;
  let w = vw, h = vw / r;
  if (h > vh) { h = vh; w = vh * r; }
  return { w: Math.round(w), h: Math.round(h) };
}

/** Immersive fullscreen visualizer + floating editor popup. Mounted at app root; renders only
 *  when `useViz.fullscreen` is on. */
export function VizFullscreen() {
  const fullscreen = useViz((s) => s.fullscreen);
  useBackGuard(fullscreen, () => useViz.getState().setFullscreen(false));
  const aspect = useViz((s) => s.scene.aspect);
  const setFullscreen = useViz((s) => s.setFullscreen);
  const setAspect = useViz((s) => s.setAspect);
  const applyTemplate = useViz((s) => s.applyTemplate);
  const panelPos = useViz((s) => s.panelPos);
  const setPanelPos = useViz((s) => s.setPanelPos);
  const panelCollapsed = useViz((s) => s.panelCollapsed);
  const setPanelCollapsed = useViz((s) => s.setPanelCollapsed);
  const playing = usePlayer((s) => s.playing);
  const toggle = usePlayer((s) => s.toggle);

  const addLayer = useViz((s) => s.addLayer);
  const [tab, setTab] = useState<(typeof TABS)[number]["id"]>("layers");
  const [vp, setVp] = useState({ w: 1280, h: 720 });
  const [controls, setControls] = useState(true);
  const [trueFs, setTrueFs] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const hideTimer = useRef<number>(0);

  useEffect(() => {
    if (!fullscreen) return;
    const onR = () => setVp({ w: window.innerWidth, h: window.innerHeight });
    onR(); window.addEventListener("resize", onR);
    return () => window.removeEventListener("resize", onR);
  }, [fullscreen]);

  useEffect(() => {
    if (!fullscreen) return;
    const ping = () => {
      setControls(true);
      window.clearTimeout(hideTimer.current);
      hideTimer.current = window.setTimeout(() => setControls(false), 3200);
    };
    ping();
    window.addEventListener("pointermove", ping);
    window.addEventListener("pointerdown", ping);
    return () => {
      window.removeEventListener("pointermove", ping);
      window.removeEventListener("pointerdown", ping);
      window.clearTimeout(hideTimer.current);
    };
  }, [fullscreen]);

  if (!fullscreen) return null;
  const box = aspectBox(aspect, vp.w, vp.h);

  const exit = () => { setFullscreen(false); if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); };
  const toggleTrueFs = async () => {
    try {
      if (!document.fullscreenElement) { await document.documentElement.requestFullscreen(); setTrueFs(true); }
      else { await document.exitFullscreen(); setTrueFs(false); }
    } catch { /* not supported */ }
  };

  return createPortal(
    <div className="wp-fs">
      <div className="wp-fs-stage" onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, items: addLayerItems(addLayer) }); }}>
        <div className="wp-fs-box" style={{ width: box.w, height: box.h }}><Visualizer /></div>
      </div>

      <div className={`wp-fs-top ${controls ? "" : "wp-hidden"}`}>
        <button className="md-icon-btn" onClick={exit} title="Exit fullscreen"><Icon name="close" /></button>
        <div className="wp-seg wp-seg-sm wp-fs-aspect">
          {ASPECTS.map((a) => <button key={a} className={`wp-seg-item ${aspect === a ? "wp-seg-on" : ""}`} onClick={() => setAspect(a)}>{a}</button>)}
        </div>
        <div className="wp-fs-spacer" />
        <button className="md-icon-btn" onClick={() => toggle()} title={playing ? "Pause" : "Play"}><Icon name={playing ? "pause" : "play"} /></button>
        <button className="md-icon-btn" onClick={toggleTrueFs} title="True fullscreen"><Icon name={trueFs ? "fullscreenExit" : "fullscreen"} /></button>
      </div>

      <FloatingPanel title="Visualizer" pos={panelPos} onMove={setPanelPos} collapsed={panelCollapsed} onCollapse={setPanelCollapsed}>
        <div className="wp-float-tabs">
          {TABS.map((t) => <button key={t.id} className={`wp-ftab ${tab === t.id ? "wp-ftab-on" : ""}`} onClick={() => setTab(t.id)}>{t.label}</button>)}
        </div>
        <div className="wp-float-scroll">
          {tab === "layers" && (
            <>
              <RendererControls />
              <LayerList />
            </>
          )}
          {tab === "scenes" && (
            <>
              <div className="wp-tpl-head md-label-m wp-muted">Templates</div>
              <div className="wp-scene-grid">
                {TEMPLATES.map((t) => (
                  <button key={t.name} className="wp-scene-card" onClick={() => applyTemplate(t.name)}>
                    <span className="wp-scene-thumb"><Icon name="graphicEq" size={22} color="var(--md-primary)" /></span>
                    <span className="md-body-m">{t.name}</span>
                  </button>
                ))}
              </div>
              <div className="wp-tpl-head md-label-m wp-muted">Presets</div>
              <PresetBar />
            </>
          )}
          {tab === "props" && <LayerProps />}
          {tab === "export" && <ExportPanel />}
        </div>
      </FloatingPanel>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>,
    document.body,
  );
}
