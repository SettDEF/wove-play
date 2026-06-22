import { useState } from "react";
import { useSettings } from "@/store/settings";
import { EQ_PRESETS } from "@/store/player";
import { Icon } from "./Icons";
import { Sheet } from "./Sheet";
import { useBackGuard } from "@/lib/backStack";

/** Per-device Bluetooth → EQ mapping. Lists devices we've seen (via the native connect listener) and
 *  lets each one be mapped to an EQ preset; a tap opens a preset picker sheet. The auto-swap toggle +
 *  permission live in the parent (Connect) section. */
export function BtDevicesEditor() {
  const devices = useSettings((s) => s.btDevices);
  const map = useSettings((s) => s.btEqMap);
  const setBtEq = useSettings((s) => s.setBtEq);
  const [pick, setPick] = useState<string | null>(null); // address being edited
  useBackGuard(pick != null, () => setPick(null));

  if (!devices.length) {
    return (
      <div className="md-body-s wp-muted" style={{ padding: "2px 8px 6px" }}>
        No Bluetooth devices seen yet. Connect a car or headset while Wove is open, then it'll
        appear here to map to an EQ preset.
      </div>
    );
  }

  const label = (addr: string) => map[addr] || "No change";

  return (
    <>
      {devices.map((d) => (
        <button key={d.address} className="wp-set-row wp-bt-row" onClick={() => setPick(d.address)}>
          <span className="wp-set-icon"><Icon name="cast" size={20} /></span>
          <div className="wp-row-text">
            <div className="md-body-l ellipsis">{d.name || d.address}</div>
            <div className="md-body-s wp-muted ellipsis">{d.address}</div>
          </div>
          <div className="wp-set-control md-body-m">{label(d.address)} <Icon name="down" size={16} /></div>
        </button>
      ))}

      {pick && (
        <Sheet onClose={() => setPick(null)} className="wp-bt-pick">
          <header className="wp-sheet-head">
            <div className="md-title-m">EQ when this connects</div>
            <button className="md-icon-btn" onClick={() => setPick(null)}><Icon name="close" size={20} /></button>
          </header>
          <div className="wp-list">
            <button className="wp-row" onClick={() => { setBtEq(pick, ""); setPick(null); }}>
              <div className="wp-row-text"><div className="md-body-l">No change</div></div>
              {!map[pick] && <Icon name="check" size={18} color="var(--md-primary)" />}
            </button>
            {EQ_PRESETS.map((p) => (
              <button key={p.name} className="wp-row" onClick={() => { setBtEq(pick, p.name); setPick(null); }}>
                <div className="wp-row-text"><div className="md-body-l">{p.name}</div></div>
                {map[pick] === p.name && <Icon name="check" size={18} color="var(--md-primary)" />}
              </button>
            ))}
          </div>
        </Sheet>
      )}
    </>
  );
}
