import { renderScene, makeStateMap, type VizBuffers } from "./vizRender";
import { GLRenderer } from "./glRender";
import type { Scene } from "@/store/viz";

export interface SceneRenderer {
  isGL: boolean;
  render: (pw: number, ph: number, scene: Scene, analyser: AnalyserNode | null, buf: VizBuffers, text?: { title: string; artist: string; lyric?: string }) => void;
  setBloom?: (v: number) => void;
  dispose: () => void;
}

let _glSupported: boolean | null = null;
/** Probe WebGL2 + shader compilation once on a throwaway canvas, so we never taint the real one. */
export function glSupported(): boolean {
  if (_glSupported !== null) return _glSupported;
  try {
    const probe = document.createElement("canvas");
    probe.width = 4; probe.height = 4;
    const r = new GLRenderer(probe);
    r.dispose();
    _glSupported = true;
  } catch {
    _glSupported = false;
  }
  return _glSupported;
}

/** Build a renderer for a canvas. GL when `preferGl` and supported, else Canvas2D. The canvas's
 *  context type is fixed once chosen, so toggling GL↔2D requires a fresh canvas (remount). */
export function makeSceneRenderer(canvas: HTMLCanvasElement, preferGl: boolean): SceneRenderer {
  if (preferGl && glSupported()) {
    try {
      const gl = new GLRenderer(canvas);
      return {
        isGL: true,
        render: (pw, ph, scene, an, buf, text) => gl.render(pw, ph, scene, an, buf, text),
        setBloom: (v) => gl.setBloom(v),
        dispose: () => gl.dispose(),
      };
    } catch (e) {
      console.warn("WebGL renderer init failed, falling back to Canvas2D:", e);
      // canvas may be tainted by the failed webgl2 context → use a fresh 2D canvas in its place
    }
  }
  const ctx = canvas.getContext("2d");
  const stateMap = makeStateMap();
  const mem = new Map<string, number>();
  return {
    isGL: false,
    render: (pw, ph, scene, an, buf, text) => { if (ctx) renderScene(ctx, pw, ph, scene, an, buf, stateMap, mem, text); },
    dispose: () => {},
  };
}
