// Per-output-device EQ/DSP profiles (Poweramp-style "settings per output"). A snapshot of the EQ +
// tone is saved keyed by output device id; selecting that output re-applies it. Web Audio can't do
// bit-perfect/hi-res per device, but per-device *EQ profiles* are fully achievable.

import { usePlayer } from "@/store/player";
import { useDsp } from "@/store/dsp";

export interface EqSnapshot { bands: number[]; freqs: number[]; qs: number[]; preamp: number; bass: number; treble: number }

const LS = "wavrplay-output-eq"; // { [deviceId]: EqSnapshot }
type ProfileMap = Record<string, EqSnapshot>;
function loadAll(): ProfileMap { try { return JSON.parse(localStorage.getItem(LS) || "{}"); } catch { return {}; } }
function saveAll(m: ProfileMap) { try { localStorage.setItem(LS, JSON.stringify(m)); } catch { /* ignore */ } }

export function snapshotEq(): EqSnapshot {
  const p = usePlayer.getState(); const d = useDsp.getState();
  return { bands: [...p.bands], freqs: [...p.bandFreqs], qs: [...p.bandQs], preamp: p.preamp, bass: d.bass, treble: d.treble };
}

export function applyEq(s: EqSnapshot) {
  const p = usePlayer.getState(); const d = useDsp.getState();
  s.bands.forEach((g, i) => p.setBand(i, g));
  s.freqs.forEach((f, i) => p.setEqFreq(i, f));
  s.qs.forEach((q, i) => p.setEqQ(i, q));
  p.setPreamp(s.preamp);
  d.set("bass", s.bass);
  d.set("treble", s.treble);
}

export function saveOutputProfile(deviceId: string) { const m = loadAll(); m[deviceId] = snapshotEq(); saveAll(m); }
export function loadOutputProfile(deviceId: string): boolean { const s = loadAll()[deviceId]; if (s) { applyEq(s); return true; } return false; }
export function hasOutputProfile(deviceId: string): boolean { return !!loadAll()[deviceId]; }
export function listOutputProfiles(): { id: string; snap: EqSnapshot }[] {
  return Object.entries(loadAll()).map(([id, snap]) => ({ id, snap }));
}
