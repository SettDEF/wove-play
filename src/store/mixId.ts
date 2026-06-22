import { create } from "zustand";
import { fileUrl } from "@/lib/backend";
import { decodeChannels, type Section } from "@/lib/trackAnalysis";
import { toMono, fingerprint, identifyMix, FP_BANDS, type Fingerprint } from "@/lib/mixMatch";
import type { Track } from "@/lib/types";
import { usePlayer } from "./player";
import { useSettings } from "./settings";
import { analysisPaused, noteAnalysisActivity } from "./analysisPause";

/**
 * Phase 3 — identify the user's own library tracks playing inside a long mix (the "chiffre"), using the
 * on-device fingerprint + matcher in lib/mixMatch. Heavy + experimental → gated behind settings.mixDetect
 * and only ever runs for tracks > 8 min. Library fingerprints are built gradually in the background.
 */

const LS = "wavrplay-fp";
const MAX_CACHE = 600; // bounded localStorage (each fp ≈ frames×12 bytes)
const MIX_MIN_SEC = 480;

const fps = new Map<string, Fingerprint>(); // id → fingerprint (insertion-ordered = LRU)
let loaded = false;

function load() {
  if (loaded) return;
  loaded = true;
  try {
    const raw = JSON.parse(localStorage.getItem(LS) || "{}") as Record<string, string>;
    for (const [id, b64] of Object.entries(raw)) {
      const bin = atob(b64);
      const frames = new Int8Array(bin.length);
      for (let i = 0; i < bin.length; i++) frames[i] = (bin.charCodeAt(i) << 24) >> 24;
      fps.set(id, { frames, n: Math.floor(frames.length / FP_BANDS) });
    }
  } catch { /* corrupt cache → start fresh */ }
}

function persist() {
  try {
    const out: Record<string, string> = {};
    const ids = [...fps.keys()].slice(-MAX_CACHE);
    for (const id of ids) {
      const f = fps.get(id)!;
      let s = "";
      for (let i = 0; i < f.frames.length; i++) s += String.fromCharCode(f.frames[i] & 0xff);
      out[id] = btoa(s);
    }
    localStorage.setItem(LS, JSON.stringify(out));
  } catch { /* quota — ignore, cache stays in memory */ }
}

const inflight = new Map<string, Promise<Fingerprint | null>>(); // per-id dedup
let chain: Promise<unknown> = Promise.resolve();                  // global serializer — ONE decode at a time

/** Fingerprint a track (cached). Decodes are SERIALIZED + de-duped so concurrent callers (the background
 *  fingerprinter + an on-demand detect) can never stack multiple heavy decodes and swamp the phone. */
async function computeFp(track: Track): Promise<Fingerprint | null> {
  load();
  const hit = fps.get(track.id);
  if (hit) { fps.delete(track.id); fps.set(track.id, hit); return hit; } // bump LRU
  const pend = inflight.get(track.id);
  if (pend) return pend; // already being computed → share it
  const p = chain.then(async (): Promise<Fingerprint | null> => {
    const again = fps.get(track.id); // may have landed while we waited our turn in the queue
    if (again) return again;
    noteAnalysisActivity();
    const dec = await decodeChannels(await fileUrl(track.path));
    if (!dec) return null;
    noteAnalysisActivity();
    const fp = fingerprint(toMono(dec.channels, dec.sampleRate));
    fps.set(track.id, fp);
    while (fps.size > MAX_CACHE) { const k = fps.keys().next().value; if (k === undefined) break; fps.delete(k); }
    persist();
    return fp;
  }).finally(() => inflight.delete(track.id));
  inflight.set(track.id, p);
  chain = p.catch(() => {}); // keep the serializer alive even if one decode fails
  return p;
}

interface MixIdState {
  mixId: string;          // track id the current matches belong to
  sections: Section[];    // identified-track sections (labelled with titles) — [] if none / not a mix
  detecting: boolean;
}
export const useMixId = create<MixIdState>(() => ({ mixId: "", sections: [], detecting: false }));

/** Identify library tracks inside `track` if it's a long mix + the feature is on. Stores labelled
 *  sections (one per matched track) in useMixId; cheap to call on every track change. */
export async function detectMix(track: Track | null): Promise<void> {
  if (!track || !useSettings.getState().mixDetect || (track.duration || 0) < MIX_MIN_SEC) {
    if (useMixId.getState().sections.length) useMixId.setState({ mixId: "", sections: [] });
    return;
  }
  if (useMixId.getState().mixId === track.id) return; // already done for this mix
  useMixId.setState({ detecting: true });
  try {
    const mixFp = await computeFp(track);
    if (!mixFp) return;
    const lib = usePlayer.getState().library;
    const byId = new Map(lib.map((t) => [t.id, t]));
    const cands = lib
      .filter((t) => t.id !== track.id && (t.duration || 0) < (track.duration || 0) && fps.has(t.id))
      .map((t) => ({ id: t.id, fp: fps.get(t.id)! }));
    const dur = track.duration || 1;
    const sections: Section[] = identifyMix(mixFp, cands).map((m) => ({
      start: m.startSec / dur, end: m.endSec / dur, tier: 1,
      label: byId.get(m.trackId)?.title ?? "Track",
    }));
    useMixId.setState({ mixId: track.id, sections });
  } finally {
    useMixId.setState({ detecting: false });
  }
}

// ── Background fingerprinting ────────────────────────────────────────────────────────────────────
// Decoding the whole library is heavy, so build fingerprints a few at a time while idle (paused), only
// when the feature is on. Matches improve as coverage grows. Mirrors the taste idle analyzer. [bg]
let bgStarted = false;
export function startMixFingerprinting(): void {
  if (bgStarted || typeof window === "undefined") return;
  bgStarted = true;
  load();
  let idx = 0;
  const step = async () => {
    const s = useSettings.getState();
    const p = usePlayer.getState();
    if (s.mixDetect && !analysisPaused() && !p.playing && p.hydrated && p.library.length) {
      // fingerprint the shortest un-cached tracks first (most likely to appear inside a mix)
      const todo = p.library.filter((t) => !fps.has(t.id)).sort((a, b) => (a.duration || 0) - (b.duration || 0));
      const t = todo[idx % Math.max(1, todo.length)];
      if (t) { idx++; try { await computeFp(t); } catch { /* skip */ } }
    }
    const delay = useSettings.getState().mixDetect ? 4000 : 30000;
    window.setTimeout(() => { void step(); }, delay);
  };
  void step();
}
