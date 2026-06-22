import { usePlayer, EQ_PRESETS } from "@/store/player";
import { useSettings } from "@/store/settings";
import { bindBluetooth, nativeBtHasPermission, nativeBtRequestPermission, type BtEvent } from "./nativeMedia";
import { toast } from "@/store/toasts";

/** Bluetooth → EQ auto-swap. When a device connects we remember it (so it's mappable in Settings)
 *  and, if the user mapped it to an EQ preset and auto-swap is on, apply that preset. Identifying is
 *  by MAC address. Inert off Android. */

let btPausedAuto = false; // we paused because a BT/headset device disconnected → eligible to auto-resume on reconnect

/** Apply a named EQ preset (built-in). Returns true if a matching preset was found + applied. */
function applyPresetByName(name: string): boolean {
  const preset = EQ_PRESETS.find((p) => p.name === name);
  if (!preset) return false;
  usePlayer.getState().applyPreset(preset);
  return true;
}

function onBluetooth(e: BtEvent): void {
  const st = useSettings.getState();
  const p = usePlayer.getState();
  if (e.connected) {
    st.rememberBtDevice(e.address, e.name);
    // Auto-resume when a device reconnects, but only if WE auto-paused it on the previous disconnect.
    if (st.btResumeOnConnect && btPausedAuto && !p.playing) { btPausedAuto = false; p.toggle(); }
  } else if (st.btPauseOnDisconnect && p.playing) {
    // Classic "unplug headphones → pause" so music never suddenly blasts from the speaker.
    btPausedAuto = true; p.toggle();
  }
  if (!e.connected || !st.btAutoEq) return;
  const presetName = st.btEqMap[e.address];
  if (presetName && applyPresetByName(presetName)) {
    toast.info(`${e.name || "Bluetooth"} · EQ → ${presetName}`);
  }
}

/** Ask for the Bluetooth permission (so names/MACs are readable); called when auto-EQ is enabled. */
export async function ensureBtPermission(): Promise<void> {
  if (!(await nativeBtHasPermission())) await nativeBtRequestPermission();
}

let bound = false;
/** Start listening for Bluetooth connect/disconnect (idempotent). No-op off Android. */
export function initBluetoothEq(): void {
  if (bound) return;
  bound = true;
  void bindBluetooth(onBluetooth);
}
