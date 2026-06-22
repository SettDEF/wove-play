import { APP_VERSION, cmpVersion } from "./changelog";

/**
 * Self-update check. Point this at a PUBLIC `latest.json` you host for free (e.g. a GitHub *releases*
 * repo, GitHub Pages, Cloudflare R2…). No server/runtime needed — it's a static file. Leave it empty to
 * disable update checks entirely (the "Update available" button just never shows).
 *
 * Expected JSON shape:
 *   { "version": "0.2.0", "notes": "Faster scrolling, fixes", "url": "https://…/Wove-0.2.0.apk" }
 */
export const UPDATE_MANIFEST_URL = "https://raw.githubusercontent.com/SettDEF/Wove-releases/master/latest.json";

export interface UpdateInfo { version: string; notes?: string; url: string }

/** Returns the newer release if one is available, else null (up-to-date, no URL configured, or offline). */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  if (!UPDATE_MANIFEST_URL) return null;
  try {
    const r = await fetch(UPDATE_MANIFEST_URL, { cache: "no-store" });
    if (!r.ok) return null;
    const j = (await r.json()) as { version?: string; notes?: string; url?: string; apk?: string };
    const url = j.url || j.apk;
    if (j.version && url && cmpVersion(j.version, APP_VERSION) > 0) return { version: j.version, notes: j.notes, url };
    return null;
  } catch { return null; }
}
