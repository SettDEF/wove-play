import { useRef, type ReactNode } from "react";
import { Icon } from "../Icons";

/** A draggable, collapsible Material-3 floating card. Drag by the header; position is reported
 *  via onMove (clamped to the viewport). pos.x < 0 → use the default top-right placement. */
export function FloatingPanel({ title, pos, onMove, collapsed, onCollapse, onClose, children }: {
  title: string;
  pos: { x: number; y: number };
  onMove: (x: number, y: number) => void;
  collapsed: boolean;
  onCollapse: (c: boolean) => void;
  onClose?: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);

  const placed = pos.x >= 0;
  const style: React.CSSProperties = placed
    ? { left: pos.x, top: pos.y }
    : { right: 12, top: 64 };

  const onDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest("button")) return; // don't drag from the buttons
    e.preventDefault();
    const el = ref.current; if (!el) return;
    const r = el.getBoundingClientRect();
    drag.current = { sx: e.clientX, sy: e.clientY, ox: r.left, oy: r.top };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const d = drag.current; if (!d) return;
      const w = el.offsetWidth;
      const x = Math.max(4, Math.min(window.innerWidth - w - 4, d.ox + (ev.clientX - d.sx)));
      const y = Math.max(4, Math.min(window.innerHeight - 40, d.oy + (ev.clientY - d.sy)));
      onMove(x, y);
    };
    const up = () => { drag.current = null; window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  };

  return (
    <div ref={ref} className={`wp-float ${collapsed ? "wp-float-collapsed" : ""}`} style={style}>
      <div className="wp-float-head" onPointerDown={onDown}>
        <Icon name="settings" size={16} color="var(--md-on-surface-variant)" />
        <span className="md-title-s wp-float-title">{title}</span>
        <button className="md-icon-btn wp-mini-btn" title={collapsed ? "Expand" : "Collapse"} onClick={() => onCollapse(!collapsed)}>
          <Icon name={collapsed ? "up" : "down"} size={18} />
        </button>
        {onClose && (
          <button className="md-icon-btn wp-mini-btn" title="Close" onClick={onClose}><Icon name="close" size={18} /></button>
        )}
      </div>
      {!collapsed && <div className="wp-float-body">{children}</div>}
    </div>
  );
}
