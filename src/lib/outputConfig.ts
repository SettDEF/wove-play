// Output configuration model (Poweramp-style "Output" settings). This is the CONFIG surface: the
// per-device output-plugin assignment + hi-res/DVC/buffer options. The Android native output plugins
// (OpenSL ES / AudioTrack / AAudio / Hi-Res) that actually honor these don't exist yet — until the
// native engine ships them, this stores your preferences and drives what we CAN do today (output
// device pick, dither/clip via the desktop engine, visualization delay). Kept as one object so it's
// a single settings field, not 40 flat ones.

export type OutputPlugin = "opensl" | "audiotrack" | "hires" | "aaudio" | "chromecast";
export type OutputDeviceId = "wired" | "speaker" | "bluetooth" | "usb" | "other";
export type BufferPreset = "short" | "normal" | "large" | "huge";

export const PLUGINS: { id: OutputPlugin; name: string; desc: string }[] = [
  { id: "opensl", name: "OpenSL ES Output", desc: "Native optimized output" },
  { id: "audiotrack", name: "AudioTrack Output", desc: "Java-based output" },
  { id: "hires", name: "Hi-Res Output", desc: "Experimental direct hardware 24+ bit 96/192+ kHz" },
  { id: "aaudio", name: "AAudio Output", desc: "Hi-Res (Android 14+) native output" },
  { id: "chromecast", name: "Chromecast Output", desc: "Chromecast" },
];

export const DEVICES: { id: OutputDeviceId; name: string }[] = [
  { id: "wired", name: "Wired Headset/AUX" },
  { id: "speaker", name: "Speaker" },
  { id: "bluetooth", name: "Bluetooth" },
  { id: "usb", name: "USB DAC" },
  { id: "other", name: "Other Output Devices" },
];

export const BUFFERS: { id: BufferPreset; label: string; detail: string }[] = [
  { id: "short", label: "Short", detail: "20ms × 2" },
  { id: "normal", label: "Normal", detail: "60ms × 2" },
  { id: "large", label: "Large", detail: "120ms × 2" },
  { id: "huge", label: "Huge", detail: "240ms × 2" },
];

/** Per-device output config (mirrors Poweramp's per-output screen). */
export interface DeviceCfg {
  plugin: OutputPlugin; // which output plugin handles this device
  enabled: boolean;     // route this device through its plugin
  sampleRate: number;   // 0 = defined by the device
  float32: boolean;     // hi-res float sample format (disables dither)
  noDvc: boolean;       // disable Direct Volume Control for this device
  noHeadroom: boolean;  // don't reduce gain when DVC is off (may clip)
  buffer: BufferPreset;
  vizDelayMs: number;   // extra visualization/lyrics delay for sync
  noEqTone: boolean;    // bypass EQ/tone DSP for this device
  noDuck: boolean;      // don't duck on notifications (pause instead)
}

export interface OutputCfg {
  defaultPlugin: OutputPlugin; // plugin for unassigned devices
  devices: Record<OutputDeviceId, DeviceCfg>;
}

const dev = (over: Partial<DeviceCfg> = {}): DeviceCfg => ({
  plugin: "opensl", enabled: true, sampleRate: 0, float32: false, noDvc: false,
  noHeadroom: false, buffer: "normal", vizDelayMs: 0, noEqTone: false, noDuck: false, ...over,
});

export const DEFAULT_OUTPUT: OutputCfg = {
  defaultPlugin: "opensl",
  devices: {
    wired: dev(),
    speaker: dev(),
    bluetooth: dev({ enabled: false }),
    usb: dev({ plugin: "audiotrack", enabled: false }),
    other: dev(),
  },
};

export const pluginName = (id: OutputPlugin) => PLUGINS.find((p) => p.id === id)?.name ?? id;
