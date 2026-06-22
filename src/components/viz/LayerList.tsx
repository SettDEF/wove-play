import { useState } from "react";
import { useViz, type LayerType } from "@/store/viz";
import { Icon } from "../Icons";
import { ContextMenu, type MenuItem } from "./ContextMenu";

const TYPE_ICON: Record<LayerType, string> = {
  group: "library", background: "folder", spectrum: "eq", wave: "graphicEq", radial: "hub", particles: "music", image: "image", text: "text", shape: "shape",
};
const ADD_TYPES: { type: LayerType; label: string }[] = [
  { type: "spectrum", label: "Spectrum" },
  { type: "wave", label: "Waveform" },
  { type: "radial", label: "Radial" },
  { type: "particles", label: "Particles" },
  { type: "image", label: "Image" },
  { type: "text", label: "Text" },
  { type: "shape", label: "Shape" },
  { type: "background", label: "Background" },
  { type: "group", label: "Group" },
];

/** Submenu items to add any layer type — shared by the layer list + canvas right-click. */
export function addLayerItems(addLayer: (t: LayerType) => void): MenuItem[] {
  return ADD_TYPES.map((a) => ({ label: a.label, icon: TYPE_ICON[a.type], onClick: () => addLayer(a.type) }));
}

export function LayerList() {
  const scene = useViz((s) => s.scene);
  const selectedId = useViz((s) => s.selectedLayerId);
  const { selectLayer, addLayer, removeLayer, duplicateLayer, reorderLayer, moveLayerEdge, toggleVisible, setParent } = useViz.getState();
  const [adding, setAdding] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropId, setDropId] = useState<string | null>(null);

  const rowMenu = (l: typeof scene.layers[number]): MenuItem[] => {
    const groups = scene.layers.filter((g) => g.type === "group" && g.id !== l.id);
    const items: MenuItem[] = [
      { label: "Duplicate", icon: "copy", onClick: () => duplicateLayer(l.id) },
      { label: l.visible ? "Hide" : "Show", icon: "visibility", onClick: () => toggleVisible(l.id) },
      { separator: true },
      { label: "Move up", icon: "up", onClick: () => reorderLayer(l.id, 1) },
      { label: "Move down", icon: "down", onClick: () => reorderLayer(l.id, -1) },
      { label: "Bring to front", onClick: () => moveLayerEdge(l.id, "front") },
      { label: "Send to back", onClick: () => moveLayerEdge(l.id, "back") },
    ];
    if (groups.length) items.push({ label: "Add to group", icon: "library", submenu: groups.map((g) => ({ label: g.name, onClick: () => setParent(l.id, g.id) })) });
    if (l.parent) items.push({ label: "Remove from group", onClick: () => setParent(l.id, null) });
    items.push({ separator: true });
    items.push({ label: "Add layer", icon: "add", submenu: addLayerItems(addLayer) });
    items.push({ separator: true });
    items.push({ label: "Delete", icon: "trash", danger: true, onClick: () => removeLayer(l.id) });
    return items;
  };
  const openRowMenu = (e: React.MouseEvent, l: typeof scene.layers[number]) => { e.preventDefault(); e.stopPropagation(); selectLayer(l.id); setMenu({ x: e.clientX, y: e.clientY, items: rowMenu(l) }); };
  const openBgMenu = (e: React.MouseEvent) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, items: addLayerItems(addLayer) }); };

  // show top layer first (like a layers panel)
  const rows = [...scene.layers].reverse();

  return (
    <div className="wp-layers" onContextMenu={openBgMenu}>
      <div className="wp-layers-head">
        <span className="md-title-s">Layers</span>
        <button className="md-icon-btn" title="Add layer" onClick={() => setAdding((v) => !v)}>
          <Icon name="add" size={20} />
        </button>
      </div>

      {adding && (
        <div className="wp-add-types">
          {ADD_TYPES.map((a) => (
            <button key={a.type} className="wp-chip" onClick={() => { addLayer(a.type); setAdding(false); }}>+ {a.label}</button>
          ))}
        </div>
      )}

      <div className="wp-layer-rows">
        {rows.map((l) => {
          const top = scene.layers[scene.layers.length - 1]?.id === l.id;
          const bottom = scene.layers[0]?.id === l.id;
          // indent by hierarchy depth
          let depth = 0, p = l.parent;
          while (p) { depth++; p = scene.layers.find((x) => x.id === p)?.parent ?? null; }
          return (
            <div key={l.id} className={`wp-layer-row ${selectedId === l.id ? "wp-layer-sel" : ""} ${dropId === l.id ? "wp-layer-drop" : ""}`}
              style={{ marginLeft: depth * 14 }} draggable
              onDragStart={(e) => { setDragId(l.id); e.dataTransfer.effectAllowed = "move"; }}
              onDragEnd={() => { setDragId(null); setDropId(null); }}
              onDragOver={(e) => { if (dragId && dragId !== l.id && l.type === "group") { e.preventDefault(); setDropId(l.id); } }}
              onDragLeave={() => setDropId((d) => (d === l.id ? null : d))}
              onDrop={(e) => { e.preventDefault(); if (dragId && dragId !== l.id && l.type === "group") setParent(dragId, l.id); setDragId(null); setDropId(null); }}
              onClick={() => selectLayer(l.id)} onContextMenu={(e) => openRowMenu(e, l)}>
              <button className={`wp-ly-vis ${l.visible ? "on" : ""}`} title="Visibility"
                onClick={(e) => { e.stopPropagation(); toggleVisible(l.id); }} />
              <span className="wp-ly-icon"><Icon name={TYPE_ICON[l.type]} size={16} /></span>
              <span className="wp-ly-name md-body-m ellipsis">{l.name}</span>
              <div className="wp-ly-actions" onClick={(e) => e.stopPropagation()}>
                <button className="md-icon-btn wp-mini-btn" title="Up" disabled={top} onClick={() => reorderLayer(l.id, 1)}><Icon name="up" size={18} /></button>
                <button className="md-icon-btn wp-mini-btn" title="Down" disabled={bottom} onClick={() => reorderLayer(l.id, -1)}><Icon name="down" size={18} /></button>
                <button className="md-icon-btn wp-mini-btn" title="Duplicate" onClick={() => duplicateLayer(l.id)}><Icon name="copy" size={15} /></button>
                <button className="md-icon-btn wp-mini-btn" title="Delete" onClick={() => removeLayer(l.id)}><Icon name="trash" size={15} /></button>
              </div>
            </div>
          );
        })}
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  );
}
