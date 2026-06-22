/** Backup & restore of all Wove *user data* — everything under the `wavrplay-` localStorage
 *  namespace (settings, theme, playlists, ratings, lyrics, EQ presets, visualizer scene, DAW host…).
 *  The library index is intentionally excluded — it rebuilds from your music folder. */

const PREFIX = "wavrplay-";

function dataKeys(): string[] {
  const keys: string[] = [];
  try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith(PREFIX)) keys.push(k); } } catch { /* ignore */ }
  return keys;
}

/** Snapshot all wavrplay-* keys into a plain map. */
export function collectData(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of dataKeys()) { const v = localStorage.getItem(k); if (v != null) out[k] = v; }
  return out;
}

/** Build a versioned backup JSON. `stamp` = epoch ms (passed in so callers control time). */
export function buildBackup(stamp: number): string {
  return JSON.stringify({ app: "wavr-play", version: 1, exportedAt: stamp, data: collectData() }, null, 2);
}

/** Restore from a backup JSON string. Returns the number of keys written. Throws if not a Wove backup. */
export function restoreBackup(text: string): number {
  const obj = JSON.parse(text) as { app?: string; data?: Record<string, unknown> };
  if (!obj || obj.app !== "wavr-play" || typeof obj.data !== "object" || !obj.data) throw new Error("Not a Wove backup file.");
  let n = 0;
  for (const [k, v] of Object.entries(obj.data)) {
    if (k.startsWith(PREFIX) && typeof v === "string") { localStorage.setItem(k, v); n++; }
  }
  return n;
}

/** Clear all Wove data (factory reset). */
export function resetData(): void {
  for (const k of dataKeys()) localStorage.removeItem(k);
}
