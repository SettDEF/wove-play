import { useRef } from "react";
import { useViz } from "@/store/viz";
import { exportPreset, parsePreset } from "@/lib/vizPreset";
import { saveTextFile } from "@/lib/backend";
import { toast } from "@/store/toasts";
import { Icon } from "../Icons";

/** Export / import the current scene as a shareable `.wavrviz` preset (works on desktop save-dialog,
 *  browser download, and the Android WebView). */
export function PresetBar() {
  const fileRef = useRef<HTMLInputElement>(null);

  const doExport = () => {
    const scene = useViz.getState().scene;
    const name = (scene.name || "scene").replace(/[^\w.-]+/g, "-").toLowerCase();
    saveTextFile(`${name}.wavrviz`, exportPreset(scene), "application/json");
    toast.success("Exported preset.");
  };

  const doImport = async (file: File | undefined) => {
    if (!file) return;
    try {
      const scene = parsePreset(await file.text());
      useViz.getState().loadSceneObj(scene);
      toast.success(`Loaded "${scene.name}".`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't read that preset.");
    }
  };

  return (
    <div className="wp-preset-bar">
      <input ref={fileRef} type="file" accept=".wavrviz,application/json,.json" style={{ display: "none" }}
        onChange={(e) => { doImport(e.target.files?.[0]); e.target.value = ""; }} />
      <button className="wp-chip" onClick={() => fileRef.current?.click()}><Icon name="add" size={14} /> Import .wavrviz</button>
      <button className="wp-chip" onClick={doExport}><Icon name="copy" size={14} /> Export</button>
    </div>
  );
}
