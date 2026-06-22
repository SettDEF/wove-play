import type { Scene } from "@/store/viz";

/** `.wavrviz` = a shareable visualizer preset: one Scene wrapped with a kind + version so we can
 *  migrate older files forward (Avee-style preset sharing). */
const KIND = "helios-viz";
export const VIZ_PRESET_VERSION = 1;

/** Serialize the current scene to a versioned `.wavrviz` JSON string. */
export function exportPreset(scene: Scene): string {
  return JSON.stringify({ kind: KIND, version: VIZ_PRESET_VERSION, scene }, null, 2);
}

/** Parse + migrate a `.wavrviz` file → Scene. Accepts a bare Scene too (lenient). Throws if invalid. */
export function parsePreset(text: string): Scene {
  let obj: unknown;
  try { obj = JSON.parse(text); } catch { throw new Error("Not a valid .wavrviz file."); }
  const root = obj as { kind?: string; version?: number; scene?: unknown } | null;
  const raw = root && typeof root === "object" && "scene" in root ? root.scene : obj; // wrapped or bare
  const scene = raw as Partial<Scene> | null;
  if (!scene || !Array.isArray(scene.layers) || typeof scene.name !== "string") {
    throw new Error("Not a Wove visualizer preset.");
  }
  return migrate(scene as Scene, root?.version ?? 0);
}

/** Forward-compat migration hook — fill anything a newer renderer expects. Scene shape is currently
 *  stable, so this just guarantees every layer has the required base fields (older/foreign files). */
function migrate(scene: Scene, _version: number): Scene {
  for (const l of scene.layers) {
    l.visible ??= true;
    l.opacity ??= 1;
    l.blend ??= "source-over";
    l.parent ??= null;
    l.x ??= 0; l.y ??= 0; l.scale ??= 1; l.rotation ??= 0;
    l.props ??= {};
    l.bind ??= {};
  }
  return scene;
}
