import { useViz } from "@/store/viz";
import { glSupported } from "@/audio/sceneRenderer";
import { Slider } from "./controls";
import { Icon } from "../Icons";

/** GPU render controls (WebGL2 + bloom). GPU is the only renderer; this just tunes bloom. */
export function RendererControls() {
  const bloom = useViz((s) => s.bloom);
  const setBloom = useViz((s) => s.setBloom);
  const vignette = useViz((s) => s.vignette);
  const setVignette = useViz((s) => s.setVignette);
  const gl = glSupported();

  if (!gl) {
    return (
      <div className="wp-ctl-group wp-renderer">
        <div className="wp-gpu-warn md-body-s"><Icon name="graphicEq" size={16} /> WebGL2 isn’t available here — visuals run in a basic fallback.</div>
      </div>
    );
  }
  return (
    <div className="wp-ctl-group wp-renderer">
      <Slider label="Bloom" value={bloom} min={0} max={2.5} step={0.05} fmt={(v) => v.toFixed(2)} onChange={setBloom} />
      <Slider label="Vignette" value={vignette} min={0} max={1} step={0.05} fmt={(v) => `${Math.round(v * 100)}%`} onChange={setVignette} />
    </div>
  );
}
