import { httpGetBytes } from "./backend";
import { usePlayer } from "@/store/player";
import { useSettings } from "@/store/settings";
import { streamTrack } from "./streams";
import type { Track } from "./types";

export interface ExtensionDef { id: string; name: string; code: string; enabled: boolean }
interface RawResult { title: string; artist?: string; album?: string; url: string; art?: string; duration?: number }

/** Sandbox harness prepended to every extension. Runs in a Web Worker → NO DOM, NO Tauri, NO filesystem.
 *  The only capability we add is `woveFetch(url)` → text, proxied through the app (so it isn't CORS-bound).
 *  An extension must define `self.search = async (query) => [{ title, artist, url, art, duration }]`. */
const HARNESS = `
const _p = {}; let _seq = 0;
self.woveFetch = (url) => new Promise((res, rej) => { const id = ++_seq; _p[id] = { res, rej }; self.postMessage({ __wove: "fetch", id, url }); });
self.addEventListener("message", async (e) => {
  const m = e.data || {};
  if (m.__wove === "fetchResult") { const p = _p[m.id]; if (p) { delete _p[m.id]; m.error ? p.rej(new Error(m.error)) : p.res(m.text); } return; }
  if (m.__wove === "search") {
    try {
      if (typeof self.search !== "function") throw new Error("extension defines no search(query)");
      const r = await self.search(m.query);
      self.postMessage({ __wove: "searchResult", id: m.id, results: Array.isArray(r) ? r : [] });
    } catch (err) { self.postMessage({ __wove: "searchResult", id: m.id, error: String(err && err.message || err) }); }
  }
});
`;

const toTrack = (r: RawResult, source: string): Track => ({
  ...streamTrack(r.url, r.title, source),
  artist: r.artist || source, album: r.album || source, duration: r.duration || 0, artUrl: r.art,
});

/** Run ONE extension's search in a throwaway Worker (terminated after, with a timeout). */
export async function runExtensionSearch(ext: ExtensionDef, query: string, timeoutMs = 12000): Promise<Track[]> {
  const blob = new Blob([HARNESS + "\n;\n" + ext.code], { type: "text/javascript" });
  const url = URL.createObjectURL(blob);
  const w = new Worker(url);
  try {
    return await new Promise<Track[]>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out")), timeoutMs);
      w.onmessage = async (e: MessageEvent) => {
        const m = e.data || {};
        if (m.__wove === "fetch") {
          const got = await httpGetBytes(m.url); // proxied, no-CORS — extension's only outbound capability
          const text = got ? new TextDecoder().decode(got.data) : "";
          w.postMessage({ __wove: "fetchResult", id: m.id, text, error: got ? undefined : "fetch failed" });
        } else if (m.__wove === "searchResult") {
          clearTimeout(timer);
          if (m.error) reject(new Error(m.error));
          else resolve((m.results as RawResult[]).filter((r) => r && r.url).map((r) => toTrack(r, ext.name)));
        }
      };
      w.onerror = (e) => { clearTimeout(timer); reject(new Error(e.message || "worker error")); };
      w.postMessage({ __wove: "search", id: 1, query });
    });
  } finally {
    w.terminate();
    URL.revokeObjectURL(url);
  }
}

/** Search every ENABLED extension in parallel; returns each extension's results grouped. */
export async function searchExtensions(query: string): Promise<{ ext: ExtensionDef; tracks: Track[]; error?: string }[]> {
  const exts = useSettings.getState().extensions.filter((e) => e.enabled);
  return Promise.all(exts.map(async (ext) => {
    try { return { ext, tracks: await runExtensionSearch(ext, query) }; }
    catch (err) { return { ext, tracks: [], error: String(err instanceof Error ? err.message : err) }; }
  }));
}

export function playExtensionResults(tracks: Track[], index: number, source = "Extension") {
  usePlayer.getState().playFrom(tracks, index, source);
}
