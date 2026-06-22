import { useMemo, useState, Fragment } from "react";
import { Icon } from "./Icons";
import type { Track } from "@/lib/types";

/** A node in the browsable folder hierarchy (built from the flat per-directory list). */
interface FNode {
  path: string;       // full directory path (display key)
  name: string;       // last path segment (or the merged chain, e.g. "Music/Rock")
  own: Track[];       // tracks directly in this directory
  children: FNode[];
  total: number;      // songs in this folder + every descendant
}

/** Split a directory path into segments, tolerating both `/` and `\` and a leading separator. */
const segments = (dir: string) => dir.replace(/\\/g, "/").replace(/\/+$/, "").split("/").filter(Boolean);

/** Build a folder tree from the flat `{ dir, tracks }` list and collapse single-child chains so
 *  deep absolute paths (/home/me/Music/Rock) read as one tidy row until they actually branch. */
function buildTree(folders: { dir: string; tracks: Track[] }[]): FNode[] {
  const root: FNode = { path: "", name: "", own: [], children: [], total: 0 };
  const childOf = (parent: FNode, name: string, path: string): FNode => {
    let n = parent.children.find((c) => c.name === name);
    if (!n) { n = { path, name, own: [], children: [], total: 0 }; parent.children.push(n); }
    return n;
  };
  for (const f of folders) {
    let node = root, acc = "";
    for (const seg of segments(f.dir)) { acc = acc ? `${acc}/${seg}` : seg; node = childOf(node, seg, acc); }
    node.own = f.tracks;
  }
  const finish = (n: FNode): number => {
    // collapse: a single child with no own tracks merges into its parent ("a" + "b" → "a/b")
    while (n.children.length === 1 && n.own.length === 0) {
      const c = n.children[0];
      n.name = n.name ? `${n.name}/${c.name}` : c.name;
      n.path = c.path; n.own = c.own; n.children = c.children;
    }
    n.children.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    n.total = n.own.length + n.children.reduce((s, c) => s + finish(c), 0);
    return n.total;
  };
  root.children.forEach(finish);
  root.children.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  return root.children;
}

/** Every track at or below a node (depth-first), for "play / open this folder". */
function subtree(n: FNode): Track[] {
  return [...n.own, ...n.children.flatMap(subtree)];
}

interface Props {
  folders: { dir: string; tracks: Track[] }[];
  /** Open a folder's songs (its own + all descendants). */
  onOpen: (title: string, subtitle: string, tracks: Track[]) => void;
}

/** Poweramp-style hierarchical Folders browser: expand/collapse subfolders; tap a name to open all
 *  of that folder's songs (including nested ones). */
export function FolderBrowser({ folders, onOpen }: Props) {
  const tree = useMemo(() => buildTree(folders), [folders]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (path: string) =>
    setExpanded((s) => { const n = new Set(s); n.has(path) ? n.delete(path) : n.add(path); return n; });

  const renderRow = (node: FNode, depth: number) => {
    const hasKids = node.children.length > 0;
    const open = expanded.has(node.path);
    return (
      <Fragment key={node.path}>
        <div className="wp-row wp-ftree-row" style={{ paddingLeft: 6 + depth * 16 }}>
          <button
            className={`wp-ftree-twist ${open ? "open" : ""}`}
            style={{ visibility: hasKids ? "visible" : "hidden" }}
            onClick={() => hasKids && toggle(node.path)}
            aria-label={open ? "Collapse" : "Expand"}
          >
            <Icon name="down" size={18} />
          </button>
          <button
            className="wp-ftree-name"
            onClick={() => onOpen(node.name.split("/").pop() || node.name, node.path, subtree(node))}
          >
            <Icon name="folder" size={20} color="var(--md-primary)" />
            <span className="wp-ftree-text">
              <span className="md-body-l ellipsis">{node.name}</span>
              <span className="md-body-s wp-muted ellipsis">
                {node.total.toLocaleString()} song{node.total === 1 ? "" : "s"}
                {node.children.length ? ` · ${node.children.length} folder${node.children.length === 1 ? "" : "s"}` : ""}
              </span>
            </span>
          </button>
        </div>
        {open && node.children.map((c) => renderRow(c, depth + 1))}
      </Fragment>
    );
  };

  return <div className="wp-list">{tree.map((n) => renderRow(n, 0))}</div>;
}
