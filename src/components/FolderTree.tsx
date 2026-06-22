import { useMemo, useState, Fragment } from "react";
import { Icon } from "./Icons";
import { Sheet } from "./Sheet";
import type { MusicFolder } from "@/lib/backend";

/** A node in the folder hierarchy built from MediaStore RELATIVE_PATHs, per storage volume. */
interface Node {
  id: string;         // `${volume}::${path}` — unique across volumes
  name: string;
  path: string;       // relative path within its volume ("" = the storage root)
  volume: string;     // MediaStore VOLUME_NAME this subtree lives on
  count: number;      // songs directly in THIS folder
  total: number;      // songs in this folder + all descendants
  children: Node[];
}

const nid = (volume: string, path: string) => `${volume}::${path}`;

/** Build one tree per storage volume from the flat `{path, volume, storage}` folder list. */
function buildForest(folders: MusicFolder[]): { roots: Node[]; index: Map<string, Node> } {
  const index = new Map<string, Node>();
  const labels = new Map<string, string>(); // volume → friendly storage label
  const ensure = (volume: string, path: string): Node => {
    const id = nid(volume, path);
    const existing = index.get(id);
    if (existing) return existing;
    const slash = path.lastIndexOf("/");
    const parentPath = slash >= 0 ? path.slice(0, slash) : "";
    const node: Node = { id, name: slash >= 0 ? path.slice(slash + 1) : path, path, volume, count: 0, total: 0, children: [] };
    index.set(id, node);
    if (path !== "") ensure(volume, parentPath).children.push(node); // root ("") has no parent
    return node;
  };
  for (const f of folders) {
    const volume = f.volume || "external_primary";
    if (f.storage) labels.set(volume, f.storage);
    ensure(volume, "").name = labels.get(volume) || (volume === "external_primary" ? "Internal storage" : "SD card");
    ensure(volume, f.path.replace(/\/+$/, "")).count += f.count;
  }
  const fill = (n: Node): number => {
    n.children.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    n.total = n.count + n.children.reduce((s, c) => s + fill(c), 0);
    return n.total;
  };
  // roots = the "" node of each volume; internal first, then by label
  const roots = [...index.values()].filter((n) => n.path === "");
  roots.forEach(fill);
  roots.sort((a, b) =>
    (a.volume === "external_primary" ? 0 : 1) - (b.volume === "external_primary" ? 0 : 1) ||
    a.name.localeCompare(b.name));
  return { roots, index };
}

export interface FolderSelection { path: string; volume: string }

interface Props {
  folders: MusicFolder[];
  /** Commit: the minimal set of selected folders ("" path = the whole volume). */
  onSaveScan: (selection: FolderSelection[]) => void;
  /** Open the OS folder picker (e.g. for storage MediaStore doesn't enumerate). */
  onPickSystem: () => void;
  onClose: () => void;
}

/** Poweramp-style hierarchical folder picker: each storage volume (Internal / SD card) is its own
 *  root; expand to folders, multi-select with inherited checks, then Save and Scan. */
export function FolderTree({ folders, onSaveScan, onPickSystem, onClose }: Props) {
  const { roots, index } = useMemo(() => buildForest(folders), [folders]);
  // expand every storage root by default
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(roots.map((r) => r.id)));
  const [checked, setChecked] = useState<Set<string>>(new Set());

  // A node is implicitly selected when any ancestor (within the same volume) is checked.
  const ancestorChecked = (node: Node): boolean => {
    let p = node.path;
    while (p !== "") {
      const slash = p.lastIndexOf("/");
      p = slash >= 0 ? p.slice(0, slash) : "";
      if (checked.has(nid(node.volume, p))) return true;
    }
    return false;
  };
  const toggleCheck = (id: string) =>
    setChecked((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const toggleExpand = (id: string) =>
    setExpanded((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  // Minimal selection = checked nodes with no checked ancestor (subtrees cover the rest).
  const selection: FolderSelection[] = [...checked]
    .map((id) => index.get(id))
    .filter((n): n is Node => !!n && !ancestorChecked(n))
    .map((n) => ({ path: n.path, volume: n.volume }));
  const selectedSongs = [...checked]
    .map((id) => index.get(id))
    .filter((n): n is Node => !!n && !ancestorChecked(n))
    .reduce((s, n) => s + n.total, 0);

  const renderRow = (node: Node, depth: number) => {
    const isRoot = node.path === "";
    const hasKids = node.children.length > 0;
    const open = expanded.has(node.id);
    const inherited = !checked.has(node.id) && ancestorChecked(node);
    const on = checked.has(node.id) || inherited;
    return (
      <Fragment key={node.id}>
        <div className="wp-ftree-row" style={{ paddingLeft: 6 + depth * 18 }}>
          <button
            className={`wp-ftree-twist ${open ? "open" : ""}`}
            style={{ visibility: hasKids ? "visible" : "hidden" }}
            onClick={() => hasKids && toggleExpand(node.id)}
            aria-label={open ? "Collapse" : "Expand"}
          >
            <Icon name="down" size={18} />
          </button>
          <button className="wp-ftree-name" onClick={() => hasKids ? toggleExpand(node.id) : toggleCheck(node.id)}>
            <Icon name="folder" size={20} color={isRoot ? "var(--md-on-surface)" : "var(--md-primary)"} />
            <span className="wp-ftree-text">
              <span className="md-body-l ellipsis">{node.name}</span>
              <span className="md-body-s wp-muted ellipsis">
                {isRoot ? "storage" : `${node.total.toLocaleString()} song${node.total === 1 ? "" : "s"}`}
              </span>
            </span>
          </button>
          <button
            className={`wp-ftree-check ${on ? "on" : ""} ${inherited ? "inherited" : ""}`}
            disabled={inherited}
            onClick={() => toggleCheck(node.id)}
            aria-label={on ? "Remove folder" : "Add folder"}
            title={inherited ? "Included by a parent folder" : on ? "Added" : "Add"}
          >
            <Icon name={on ? "check" : "add"} size={18} />
          </button>
        </div>
        {open && node.children.map((c) => renderRow(c, depth + 1))}
      </Fragment>
    );
  };

  return (
    <Sheet onClose={onClose} className="wp-ftree">
      <div className="wp-sheet-head">
        <div className="wp-row-text">
          <div className="md-title-m">Folders Selection</div>
          <div className="md-body-s wp-muted">
            {selection.length
              ? `${selectedSongs.toLocaleString()} song${selectedSongs === 1 ? "" : "s"} in ${selection.length} folder${selection.length === 1 ? "" : "s"}`
              : "Tap ＋ on a folder to add it"}
          </div>
        </div>
        <button className="md-icon-btn" onClick={onClose}><Icon name="close" size={20} /></button>
      </div>

      <div className="wp-ftree-list">{roots.map((r) => renderRow(r, 0))}</div>

      <div className="wp-ftree-actions">
        <button className="wp-ftree-btn" onClick={onPickSystem}>
          <Icon name="folder" size={18} /> Select Folder or Storage
        </button>
        <button
          className="wp-ftree-btn wp-ftree-primary"
          disabled={!selection.length}
          onClick={() => onSaveScan(selection)}
        >
          <Icon name="check" size={18} /> Save and Scan{selection.length ? ` (${selection.length})` : ""}
        </button>
      </div>
    </Sheet>
  );
}
