/** Rotary knob with a glowing coloured progress arc (Poweramp-style). Drag vertically to change;
 *  double-tap to reset. Pure presentational — value/min/max in absolute units. */
export function Knob({ value, min, max, label, sub, color = "var(--md-primary)", size = 62, onChange, onReset }: {
  value: number; min: number; max: number; label?: string; sub?: string; color?: string; size?: number;
  onChange: (v: number) => void; onReset?: () => void;
}) {
  const span = max - min || 1;
  const pct = Math.max(0, Math.min(1, (value - min) / span));
  const ang = -135 + pct * 270; // pointer angle over a 270° sweep
  const r = size / 2 - 4;
  const C = 2 * Math.PI * r;
  const arc = (270 / 360) * C; // visible arc length

  const onDown = (e: React.PointerEvent) => {
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    const startY = e.clientY, start = value;
    const move = (ev: PointerEvent) => onChange(Math.max(min, Math.min(max, start + ((startY - ev.clientY) / 140) * span)));
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div className="wp-knob">
      <div className="wp-knob-dial" style={{ width: size, height: size }} onPointerDown={onDown} onDoubleClick={onReset}>
        <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size}>
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--md-surface-container-highest)" strokeWidth="4"
            strokeDasharray={`${arc} ${C}`} strokeLinecap="round" transform={`rotate(135 ${size / 2} ${size / 2})`} />
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth="4"
            strokeDasharray={`${pct * arc} ${C}`} strokeLinecap="round" transform={`rotate(135 ${size / 2} ${size / 2})`}
            style={{ filter: `drop-shadow(0 0 4px ${color})` }} />
        </svg>
        <span className="wp-knob-ind" style={{ transform: `rotate(${ang}deg)` }} />
      </div>
      {label && <div className="wp-knob-label md-label-m">{label}</div>}
      {sub !== undefined && <div className="wp-knob-sub md-body-s wp-muted">{sub}</div>}
    </div>
  );
}
