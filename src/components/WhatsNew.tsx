import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { APP_VERSION, CHANGELOG, cmpVersion, type ChangelogEntry } from "@/lib/changelog";
import { checkForUpdate, type UpdateInfo } from "@/lib/updates";
import { openUrl } from "@/lib/backend";
import { Sheet } from "./Sheet";
import { Icon } from "./Icons";

const SEEN_KEY = "wove-seen-version";

/**
 * On launch: if the app version is NEWER than the last one this device saw, pop a "What's new" sheet with
 * the changelog for everything since — once per update. Separately, if a remote release is available
 * (lib/updates), show an "Update available" download button that opens the APK link in the browser.
 * Mount once in App; it manages its own visibility.
 */
export function WhatsNew({ force, onClose }: { force?: boolean; onClose?: () => void } = {}) {
  // `force` (from Settings → About → "What's new") previews the full changelog on demand, ignoring the
  // seen-version + without touching localStorage — handy for testing the update popup before shipping.
  const [entries, setEntries] = useState<ChangelogEntry[] | null>(force ? CHANGELOG : null); // non-null ⇒ show the changelog
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (force) return;
    let seen: string | null = null;
    try { seen = localStorage.getItem(SEEN_KEY); } catch { /* private mode */ }
    // First-ever launch (no record) → don't pop the changelog; just remember this version so the NEXT
    // update is the first one that pops.
    if (seen && cmpVersion(APP_VERSION, seen) > 0) {
      const fresh = CHANGELOG.filter((c) => cmpVersion(c.v, seen!) > 0);
      setEntries(fresh.length ? fresh : CHANGELOG.slice(0, 1));
    }
    try { localStorage.setItem(SEEN_KEY, APP_VERSION); } catch { /* */ }
    void checkForUpdate().then((u) => { if (u) setUpdate(u); });
  }, [force]);

  const open = !dismissed && (entries != null || update != null);
  if (!open) return null;

  const close = () => { setDismissed(true); onClose?.(); };
  const download = () => { if (update) { void openUrl(update.url); close(); } };

  return createPortal(
    <Sheet onClose={close} tall={entries != null}>
      <header className="wp-sheet-head">
        <span className="wp-ai-headmark"><Icon name="hub" size={18} /></span>
        <div className="wp-row-text">
          <div className="md-title-s">{entries ? `What’s new in ${APP_VERSION}` : "Update available"}</div>
          <div className="md-body-s wp-muted">{entries ? "Thanks for updating Wove" : `Version ${update?.version} is ready`}</div>
        </div>
      </header>

      <div className="wp-sheet-actions">
        {update && (
          <button className="wp-sheet-item wp-sheet-hero" onClick={download}>
            <Icon name="bolt" size={22} color="var(--md-primary)" />
            <span className="md-body-l">Download v{update.version}</span>
            <span className="md-body-s wp-muted">opens browser</span>
          </button>
        )}

        {entries && (
          <div className="wp-whatsnew">
            {entries.map((c) => (
              <div key={c.v} className="wp-cl-entry">
                <div className="wp-cl-ver"><span className="md-label-l">{c.v}</span><span className="md-body-s wp-muted">{c.date}</span></div>
                <ul className="wp-cl-notes">{c.notes.map((n, i) => <li key={i} className="md-body-s">{n}</li>)}</ul>
              </div>
            ))}
          </div>
        )}

        <button className="wp-filled-btn wp-whatsnew-ok" onClick={close}><Icon name="checkCircle" size={18} /> Got it</button>
      </div>
    </Sheet>,
    document.body,
  );
}
