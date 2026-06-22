import { create } from "zustand";
import { engine } from "@/audio/engine";

/** Tone + effects on top of the 10-band EQ. bass/treble in dB; reverb/echo/vocal amount 0..1
 *  (vocal = how much centered vocals are faded out). */
interface Stored { bass: number; treble: number; reverb: number; echo: number; vocal: number; }
const DEFAULTS: Stored = { bass: 0, treble: 0, reverb: 0, echo: 0, vocal: 0 };

const LS = "wavrplay-dsp";
function load(): Stored { try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(LS) || "") }; } catch { return { ...DEFAULTS }; } }
function persist(s: Stored) { try { localStorage.setItem(LS, JSON.stringify(s)); } catch { /* ignore */ } }

interface DspState extends Stored {
  set: <K extends keyof Stored>(k: K, v: number) => void;
  apply: () => void;
}

const init = load();

export const useDsp = create<DspState>((set, get) => ({
  ...init,
  set: (k, v) => {
    set({ [k]: v } as Partial<DspState>);
    const s = get();
    if (k === "bass") engine.setBass(v);
    else if (k === "treble") engine.setTreble(v);
    else if (k === "reverb") engine.setReverb(v);
    else if (k === "echo") engine.setEcho(v);
    else if (k === "vocal") engine.setVocal(v);
    persist({ bass: s.bass, treble: s.treble, reverb: s.reverb, echo: s.echo, vocal: s.vocal });
  },
  apply: () => { const s = get(); engine.setBass(s.bass); engine.setTreble(s.treble); engine.setReverb(s.reverb); engine.setEcho(s.echo); engine.setVocal(s.vocal); },
}));
