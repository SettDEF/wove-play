import { useRef } from "react";
import { useViz, BLEND_MODES, type Layer, type LayerType } from "@/store/viz";
import { Toggle, ColorField, Segmented, Section, BindableSlider } from "./controls";
import { Icon } from "../Icons";

type Spec =
  | { key: string; label: string; kind: "slider"; min: number; max: number; step: number; fmt?: (v: number) => string }
  | { key: string; label: string; kind: "toggle" }
  | { key: string; label: string; kind: "color" }
  | { key: string; label: string; kind: "seg"; options: { id: string; label: string }[] };

const f2 = (v: number) => v.toFixed(2);

const SCHEMA: Record<LayerType, Spec[]> = {
  group: [],
  background: [
    { key: "useGradient", label: "Gradient", kind: "toggle" },
    { key: "color1", label: "Color", kind: "color" },
    { key: "color2", label: "Color 2", kind: "color" },
  ],
  spectrum: [
    { key: "style", label: "Style", kind: "seg", options: [{ id: "bars", label: "Bars" }, { id: "mirror", label: "Mirror" }, { id: "line", label: "Line" }, { id: "area", label: "Area" }] },
    { key: "anchor", label: "Anchor", kind: "seg", options: [{ id: "bottom", label: "Bottom" }, { id: "center", label: "Center" }, { id: "top", label: "Top" }] },
    { key: "count", label: "Bars", kind: "slider", min: 12, max: 160, step: 1 },
    { key: "gap", label: "Gap", kind: "slider", min: 0, max: 8, step: 1 },
    { key: "thickness", label: "Line width", kind: "slider", min: 1, max: 8, step: 1 },
    { key: "rounded", label: "Rounded", kind: "toggle" },
    { key: "logFreq", label: "Log frequency", kind: "toggle" },
    { key: "peakHold", label: "Peak caps", kind: "toggle" },
    { key: "glow", label: "Glow", kind: "slider", min: 0, max: 40, step: 1 },
    { key: "sensitivity", label: "Sensitivity", kind: "slider", min: 0.4, max: 3, step: 0.05, fmt: f2 },
    { key: "smoothing", label: "Smoothing", kind: "slider", min: 0, max: 0.95, step: 0.01, fmt: f2 },
    { key: "useGradient", label: "Gradient", kind: "toggle" },
    { key: "color1", label: "Color", kind: "color" },
    { key: "color2", label: "Color 2", kind: "color" },
  ],
  wave: [
    { key: "lineWidth", label: "Line width", kind: "slider", min: 1, max: 10, step: 1 },
    { key: "glow", label: "Glow", kind: "slider", min: 0, max: 40, step: 1 },
    { key: "sensitivity", label: "Sensitivity", kind: "slider", min: 0.4, max: 3, step: 0.05, fmt: f2 },
    { key: "smoothing", label: "Smoothing", kind: "slider", min: 0, max: 0.95, step: 0.01, fmt: f2 },
    { key: "useGradient", label: "Gradient", kind: "toggle" },
    { key: "color1", label: "Color", kind: "color" },
    { key: "color2", label: "Color 2", kind: "color" },
  ],
  radial: [
    { key: "count", label: "Rays", kind: "slider", min: 12, max: 200, step: 1 },
    { key: "radius", label: "Radius", kind: "slider", min: 0.05, max: 0.45, step: 0.01, fmt: f2 },
    { key: "lineWidth", label: "Line width", kind: "slider", min: 1, max: 12, step: 1 },
    { key: "logFreq", label: "Log frequency", kind: "toggle" },
    { key: "glow", label: "Glow", kind: "slider", min: 0, max: 40, step: 1 },
    { key: "sensitivity", label: "Sensitivity", kind: "slider", min: 0.4, max: 3, step: 0.05, fmt: f2 },
    { key: "smoothing", label: "Smoothing", kind: "slider", min: 0, max: 0.95, step: 0.01, fmt: f2 },
    { key: "useGradient", label: "Gradient", kind: "toggle" },
    { key: "color1", label: "Color", kind: "color" },
    { key: "color2", label: "Color 2", kind: "color" },
  ],
  particles: [
    { key: "origin", label: "Origin", kind: "seg", options: [{ id: "bottom", label: "Bottom" }, { id: "center", label: "Center" }] },
    { key: "count", label: "Max count", kind: "slider", min: 20, max: 500, step: 10 },
    { key: "size", label: "Size", kind: "slider", min: 1, max: 12, step: 0.5, fmt: f2 },
    { key: "gravity", label: "Gravity", kind: "slider", min: 0, max: 4, step: 0.1, fmt: f2 },
    { key: "spread", label: "Spread", kind: "slider", min: 0, max: 4, step: 0.1, fmt: f2 },
    { key: "glow", label: "Glow", kind: "slider", min: 0, max: 40, step: 1 },
    { key: "sensitivity", label: "Sensitivity", kind: "slider", min: 0.4, max: 3, step: 0.05, fmt: f2 },
    { key: "useGradient", label: "Gradient", kind: "toggle" },
    { key: "color1", label: "Color", kind: "color" },
    { key: "color2", label: "Color 2", kind: "color" },
  ],
  image: [
    { key: "fit", label: "Fit", kind: "seg", options: [{ id: "cover", label: "Cover" }, { id: "contain", label: "Contain" }, { id: "fill", label: "Fill" }] },
    { key: "circle", label: "Circle crop", kind: "toggle" },
    { key: "glow", label: "Glow", kind: "slider", min: 0, max: 40, step: 1 },
  ],
  text: [
    { key: "token", label: "Content", kind: "seg", options: [{ id: "title", label: "Title" }, { id: "artist", label: "Artist" }, { id: "lyric", label: "Lyric" }, { id: "custom", label: "Custom" }] },
    { key: "size", label: "Size", kind: "slider", min: 0.02, max: 0.25, step: 0.005, fmt: f2 },
    { key: "align", label: "Align", kind: "seg", options: [{ id: "left", label: "Left" }, { id: "center", label: "Center" }, { id: "right", label: "Right" }] },
    { key: "glow", label: "Glow", kind: "slider", min: 0, max: 40, step: 1 },
    { key: "color1", label: "Color", kind: "color" },
  ],
  shape: [
    { key: "shape", label: "Shape", kind: "seg", options: [{ id: "rect", label: "Rect" }, { id: "circle", label: "Circle" }] },
    { key: "fill", label: "Filled", kind: "toggle" },
    { key: "w", label: "Width", kind: "slider", min: 0.05, max: 1, step: 0.01, fmt: f2 },
    { key: "h", label: "Height", kind: "slider", min: 0.05, max: 1, step: 0.01, fmt: f2 },
    { key: "stroke", label: "Stroke", kind: "slider", min: 1, max: 30, step: 1 },
    { key: "radius", label: "Corner", kind: "slider", min: 0, max: 0.5, step: 0.01, fmt: f2 },
    { key: "glow", label: "Glow", kind: "slider", min: 0, max: 40, step: 1 },
    { key: "useGradient", label: "Gradient", kind: "toggle" },
    { key: "color1", label: "Color", kind: "color" },
    { key: "color2", label: "Color 2", kind: "color" },
  ],
};

const TYPE_ICON: Record<LayerType, string> = { group: "library", background: "folder", spectrum: "eq", wave: "graphicEq", radial: "hub", particles: "music", image: "image", text: "text", shape: "shape" };
const num = (l: Layer, k: string, d = 0) => (typeof l.props[k] === "number" ? (l.props[k] as number) : d);

export function LayerProps() {
  const layer = useViz((s) => s.selected());
  const groupCount = useViz((s) => s.scene.layers.filter((l) => l.type === "group").length);
  const { updateLayer, setProp, setParent } = useViz.getState();
  const fileRef = useRef<HTMLInputElement>(null);

  if (!layer) return <div className="wp-noprops md-body-m wp-muted">Select a layer to edit it.</div>;
  const groups = useViz.getState().scene.layers.filter((l) => l.type === "group" && l.id !== layer.id);
  void groupCount;
  const gradient = layer.props.useGradient === true;
  const specs = SCHEMA[layer.type];
  const styleSpecs = specs.filter((s) => s.kind !== "color" && s.key !== "useGradient");
  const colorSpecs = specs.filter((s) => s.kind === "color" || s.key === "useGradient");
  const id = layer.id;

  const renderSpec = (sp: Spec) => {
    if (sp.kind === "slider") return <BindableSlider key={sp.key} layerId={id} prop={sp.key} label={sp.label} value={num(layer, sp.key)} min={sp.min} max={sp.max} step={sp.step} fmt={sp.fmt} onChange={(v) => setProp(id, sp.key, v)} />;
    if (sp.kind === "toggle") return <Toggle key={sp.key} label={sp.label} on={layer.props[sp.key] === true} onClick={() => setProp(id, sp.key, !(layer.props[sp.key] === true))} />;
    if (sp.kind === "color") return (sp.key === "color2" && !gradient) ? null : <ColorField key={sp.key} label={sp.label} value={typeof layer.props[sp.key] === "string" ? (layer.props[sp.key] as string) : "#ffffff"} onChange={(v) => setProp(id, sp.key, v)} />;
    return <div key={sp.key} className="wp-blend"><span className="md-body-s wp-muted">{sp.label}</span><Segmented options={sp.options} value={String(layer.props[sp.key] ?? sp.options[0].id)} onChange={(v) => setProp(id, sp.key, v)} /></div>;
  };

  return (
    <div className="wp-props">
      {groups.length > 0 && (
        <div className="wp-blend">
          <span className="md-body-s wp-muted">Parent group</span>
          <Segmented options={[{ id: "", label: "None" }, ...groups.map((g) => ({ id: g.id, label: g.name }))]}
            value={layer.parent ?? ""} onChange={(v) => setParent(id, v || null)} />
        </div>
      )}
      <Section title="Transform" icon="tune">
        <div className="wp-ctl-group">
          <BindableSlider layerId={id} prop="x" label="X" value={layer.x} min={-0.5} max={0.5} step={0.01} fmt={f2} onChange={(v) => updateLayer(id, { x: v })} />
          <BindableSlider layerId={id} prop="y" label="Y" value={layer.y} min={-0.5} max={0.5} step={0.01} fmt={f2} onChange={(v) => updateLayer(id, { y: v })} />
          <BindableSlider layerId={id} prop="scale" label="Scale" value={layer.scale} min={0.1} max={3} step={0.05} fmt={f2} onChange={(v) => updateLayer(id, { scale: v })} />
          <BindableSlider layerId={id} prop="rotation" label="Rotation" value={layer.rotation} min={-180} max={180} step={1} onChange={(v) => updateLayer(id, { rotation: v })} />
          <BindableSlider layerId={id} prop="opacity" label="Opacity" value={layer.opacity} min={0} max={1} step={0.02} fmt={f2} onChange={(v) => updateLayer(id, { opacity: v })} />
        </div>
        <div className="wp-blend">
          <span className="md-body-s wp-muted">Blend</span>
          <Segmented options={BLEND_MODES.map((b) => ({ id: b, label: b === "source-over" ? "Normal" : b }))} value={layer.blend} onChange={(v) => updateLayer(id, { blend: v })} />
        </div>
      </Section>

      {(layer.type === "image" || layer.type === "text") && (
        <Section title="Source" icon={TYPE_ICON[layer.type]}>
          <div className="wp-ctl-group">
            {layer.type === "image" && (
              <>
                <input ref={fileRef} type="file" accept="image/*,.svg,image/svg+xml" style={{ display: "none" }}
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) { const rd = new FileReader(); rd.onload = () => setProp(id, "src", String(rd.result)); rd.readAsDataURL(f); } e.target.value = ""; }} />
                <button className="wp-filled-btn" onClick={() => fileRef.current?.click()}><Icon name="image" size={18} /> Choose image…</button>
                <label className="wp-ctl"><span className="wp-ctl-label md-body-m">URL</span>
                  <input className="wp-text-input" placeholder="https://…" value={typeof layer.props.src === "string" ? (layer.props.src as string) : ""} onChange={(e) => setProp(id, "src", e.target.value)} /></label>
              </>
            )}
            {layer.type === "text" && layer.props.token === "custom" && (
              <label className="wp-ctl"><span className="wp-ctl-label md-body-m">Text</span>
                <input className="wp-text-input" value={typeof layer.props.custom === "string" ? (layer.props.custom as string) : ""} onChange={(e) => setProp(id, "custom", e.target.value)} /></label>
            )}
          </div>
        </Section>
      )}

      {styleSpecs.length > 0 && (
        <Section title={layer.name} icon={TYPE_ICON[layer.type]}>
          <div className="wp-ctl-group">{styleSpecs.map(renderSpec)}</div>
        </Section>
      )}

      {colorSpecs.length > 0 && (
        <Section title="Color" icon="palette">
          <div className="wp-ctl-group">
            <div className="wp-color-row">{colorSpecs.filter((s) => s.kind === "color").map(renderSpec)}</div>
            {colorSpecs.filter((s) => s.kind === "toggle").map(renderSpec)}
            {/* P3: hue shift — bind the ⚡ to bass/level for "color pumps with the music" */}
            <BindableSlider layerId={id} prop="hue" label="Hue shift" value={num(layer, "hue")} min={-180} max={180} step={1} onChange={(v) => setProp(id, "hue", v)} />
          </div>
        </Section>
      )}
    </div>
  );
}
