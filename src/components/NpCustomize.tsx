import { createPortal } from "react-dom";
import { useNpLayout, type NpBg, type NpShape, type NpDim, type NpAccent, type NpControls } from "@/store/npLayout";
import { Icon } from "./Icons";
import { Sheet } from "./Sheet";
import { SHOW_VISUALIZER } from "@/lib/features";

const BG: { id: NpBg; label: string }[] = [{ id: "blur", label: "Blurred art" }, { id: "gradient", label: "Gradient" }, { id: "solid", label: "Solid" }, ...(SHOW_VISUALIZER ? [{ id: "viz" as NpBg, label: "Visualizer" }] : [])];
const SHAPE: { id: NpShape; label: string }[] = [{ id: "rounded", label: "Rounded" }, { id: "circle", label: "Circle" }, { id: "square", label: "Square" }, { id: "vinyl", label: "Vinyl" }];
const DIM: { id: NpDim; label: string }[] = [{ id: "off", label: "Light" }, { id: "soft", label: "Soft" }, { id: "strong", label: "Strong" }];
const ACCENT: { id: NpAccent; label: string }[] = [{ id: "theme", label: "Theme" }, { id: "art", label: "From art" }];
const CONTROLS: { id: NpControls; label: string }[] = [{ id: "round", label: "Round" }, { id: "pill", label: "Pill" }, { id: "minimal", label: "Minimal" }];

/** Bottom sheet to customize the Now-Playing layout (Poweramp-v5 style). */
export function NpCustomize({ onClose }: { onClose: () => void }) {
  const l = useNpLayout();
  const Group = ({ title, children }: { title: string; children: React.ReactNode }) => (
    <div className="wp-cust-group">
      <div className="md-label-m wp-muted wp-cust-grouptitle">{title}</div>
      {children}
    </div>
  );
  const Row = ({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) => (
    <div className="wp-set-row">
      <div className="wp-row-text"><div className="md-body-l">{label}</div>{hint && <div className="md-body-s wp-muted">{hint}</div>}</div>
      <div className="wp-set-control">{children}</div>
    </div>
  );
  const Seg = <T extends string>({ value, opts, on }: { value: T; opts: { id: T; label: string }[]; on: (v: T) => void }) => (
    <div className="wp-seg wp-seg-sm">{opts.map((o) => <button key={o.id} className={`wp-seg-item ${value === o.id ? "wp-seg-on" : ""}`} onClick={() => on(o.id)}>{o.label}</button>)}</div>
  );
  const Switch = ({ on, toggle }: { on: boolean; toggle: () => void }) => (
    <button className={`wp-switch ${on ? "wp-switch-on" : ""}`} onClick={toggle} aria-pressed={on}><span className="wp-switch-knob" /></button>
  );

  return createPortal(
    <Sheet onClose={onClose} tall>
      <header className="wp-sheet-head">
        <Icon name="tune" size={22} />
        <div className="wp-row-text"><div className="md-title-s">Customize player</div><div className="md-body-s wp-muted">Make the now-playing screen yours</div></div>
        <button className="wp-text-btn md-label-l wp-cust-reset" onClick={l.reset} title="Reset to defaults"><Icon name="refresh" size={16} /> Reset</button>
      </header>
      <div className="wp-sheet-actions wp-cust-body">
        <Group title="Background">
          <Row label="Style"><Seg value={l.bg} opts={BG} on={(v) => l.set("bg", v)} /></Row>
          {(l.bg === "blur" || l.bg === "viz") && (
            <Row label="Dim" hint="Darken the backdrop for readability"><Seg value={l.bgDim} opts={DIM} on={(v) => l.set("bgDim", v)} /></Row>
          )}
          <Row label="Accent colour" hint="Tints the play button & glow"><Seg value={l.accent} opts={ACCENT} on={(v) => l.set("accent", v)} /></Row>
        </Group>

        <Group title="Artwork">
          <Row label="Shape" hint={l.shape === "vinyl" ? "Spin it — drag to scratch (with sound)" : undefined}><Seg value={l.shape} opts={SHAPE} on={(v) => l.set("shape", v)} /></Row>
          <Row label="Large artwork"><Switch on={l.bigArt} toggle={() => l.set("bigArt", !l.bigArt)} /></Row>
          <Row label="Spin like vinyl" hint="Rotates while playing"><Switch on={l.spinArt} toggle={() => l.set("spinArt", !l.spinArt)} /></Row>
          <Row label="Ambient glow"><Switch on={l.glow} toggle={() => l.set("glow", !l.glow)} /></Row>
          {SHOW_VISUALIZER && <Row label="Visualizer toggle" hint="Tap the art to switch to the visualizer"><Switch on={l.showViz} toggle={() => l.set("showViz", !l.showViz)} /></Row>}
        </Group>

        <Group title="Controls & layout">
          <Row label="Button style"><Seg value={l.controls} opts={CONTROLS} on={(v) => l.set("controls", v)} /></Row>
          <Row label="Star rating" hint="Show the 5-star row under the title"><Switch on={l.showStars} toggle={() => l.set("showStars", !l.showStars)} /></Row>
          <Row label="Compact spacing" hint="Tighter layout for small screens"><Switch on={l.compact} toggle={() => l.set("compact", !l.compact)} /></Row>
        </Group>
      </div>
    </Sheet>,
    document.body,
  );
}
