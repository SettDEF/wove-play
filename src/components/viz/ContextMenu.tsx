import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../Icons";

export type MenuItem =
  | { label: string; icon?: string; onClick: () => void; danger?: boolean }
  | { label: string; icon?: string; submenu: MenuItem[] }
  | { separator: true };

/** A small portal-based right-click menu (viewport-clamped, ESC / outside-click to close, submenus). */
export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);

  return createPortal(
    <div className="wp-ctx-overlay" onPointerDown={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }}>
      <MenuPanel x={x} y={y} items={items} onClose={onClose} />
    </div>,
    document.body,
  );
}

function MenuPanel({ x, y, items, onClose, anchorRight }: { x: number; y: number; items: MenuItem[]; onClose: () => void; anchorRight?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  const [openSub, setOpenSub] = useState<number | null>(null);
  const [subPos, setSubPos] = useState({ x: 0, y: 0 });

  useLayoutEffect(() => {
    const el = ref.current; if (!el) return;
    const r = el.getBoundingClientRect();
    let nx = x, ny = y;
    if (anchorRight !== undefined && nx + r.width > window.innerWidth - 4) nx = anchorRight - r.width;
    if (nx + r.width > window.innerWidth - 4) nx = Math.max(4, window.innerWidth - r.width - 4);
    if (ny + r.height > window.innerHeight - 4) ny = Math.max(4, window.innerHeight - r.height - 4);
    setPos({ x: nx, y: ny });
  }, [x, y, anchorRight]);

  return (
    <div ref={ref} className="wp-ctx" style={{ left: pos.x, top: pos.y }} onPointerDown={(e) => e.stopPropagation()}>
      {items.map((it, i) => {
        if ("separator" in it) return <div key={i} className="wp-ctx-sep" />;
        const isSub = "submenu" in it;
        return (
          <button key={i} className={`wp-ctx-item ${"danger" in it && it.danger ? "danger" : ""}`}
            onMouseEnter={(e) => { if (isSub) { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); setSubPos({ x: r.right - 2, y: r.top - 4 }); setOpenSub(i); } else setOpenSub(null); }}
            onClick={() => { if (!isSub) { (it as { onClick: () => void }).onClick(); onClose(); } }}>
            {it.icon && <Icon name={it.icon} size={16} />}
            <span className="wp-ctx-label">{it.label}</span>
            {isSub && <Icon name="next" size={16} />}
            {isSub && openSub === i && (
              <div onPointerDown={(e) => e.stopPropagation()}>
                <MenuPanel x={subPos.x} y={subPos.y} items={(it as { submenu: MenuItem[] }).submenu} onClose={onClose} anchorRight={subPos.x} />
              </div>
            )}
          </button>
        );
      })}
    </div>
  );
}
