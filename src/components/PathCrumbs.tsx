import { useMemo } from "react";

/** Render a file path as a breadcrumb: each FOLDER segment is a clickable sub-path (→ open that folder),
 *  the filename is plain. No-op-ish for opaque URIs (content://, http) — those show as a single label. */
export function PathCrumbs({ path, onPick, className }: {
  path: string;
  onPick: (folder: string) => void;
  className?: string;
}) {
  const { crumbs, file, opaque } = useMemo(() => {
    if (!path || /^[a-z]+:\/\//i.test(path)) return { crumbs: [], file: path, opaque: true }; // content:// etc.
    const abs = path.startsWith("/");
    const segs = path.split(/[\\/]/).filter(Boolean);
    const file = segs.pop() ?? "";
    const crumbs = segs.map((name, i) => ({ name, full: (abs ? "/" : "") + segs.slice(0, i + 1).join("/") }));
    return { crumbs, file, opaque: false };
  }, [path]);

  if (opaque) return <span className={className}>{file}</span>;
  return (
    <span className={className}>
      {crumbs.map((c) => (
        <span key={c.full}>
          <button type="button" className="wp-pathcrumb" title={`Open ${c.name}`}
            onClick={(e) => { e.stopPropagation(); onPick(c.full); }}>{c.name}</button>
          <span className="wp-pathsep"> › </span>
        </span>
      ))}
      <span className="wp-pathfile">{file}</span>
    </span>
  );
}
