import { useEffect } from "react";
import { useViz, TEMPLATES } from "@/store/viz";
import { useNpLayout } from "@/store/npLayout";
import { Visualizer } from "./Visualizer";
import { LayerList } from "./viz/LayerList";
import { LayerProps } from "./viz/LayerProps";
import { ExportPanel } from "./viz/ExportPanel";
import { RendererControls } from "./viz/RendererControls";
import { PresetBar } from "./viz/PresetBar";
import { Icon } from "./Icons";

/** The Visualizer tab: a preview + template chips + an inline layer editor, plus the button
 *  to enter the immersive fullscreen experience (the floating-popup editor lives there). */
export function VizStudio() {
  const setFullscreen = useViz((s) => s.setFullscreen);
  const applyTemplate = useViz((s) => s.applyTemplate);
  const fullscreen = useViz((s) => s.fullscreen);
  const npBg = useNpLayout((s) => s.bg);
  const setNpBg = useNpLayout((s) => s.set);

  // The customisation experience IS the immersive editor: opening the Visualizer tab goes
  // straight to fullscreen (the glass editor floating over the full-bleed viz). Exiting
  // (Esc / back / ×) lands here, which then acts as the re-entry launcher.
  useEffect(() => { setFullscreen(true); }, [setFullscreen]);

  return (
    <div className="wp-screen wp-studio">
      <div className="wp-studio-preview">
        <Visualizer paused={fullscreen} />
        <button className="wp-fs-open" onClick={() => setFullscreen(true)} title="Open fullscreen">
          <Icon name="fullscreen" size={18} /> Fullscreen
        </button>
      </div>

      <div className="wp-tpl-head md-label-m wp-muted">
        <span>Scenes</span>
        <button className={`wp-chip ${npBg === "viz" ? "wp-chip-on" : ""}`} onClick={() => setNpBg("bg", npBg === "viz" ? "blur" : "viz")}>
          <Icon name="image" size={14} /> {npBg === "viz" ? "Background ✓" : "Set as background"}
        </button>
      </div>
      <div className="wp-preset-row wp-tpl-row">
        {TEMPLATES.map((t) => <button key={t.name} className="wp-chip" onClick={() => applyTemplate(t.name)}>{t.name}</button>)}
      </div>
      <PresetBar />

      <RendererControls />
      <LayerList />
      <LayerProps />
      <ExportPanel />
    </div>
  );
}
