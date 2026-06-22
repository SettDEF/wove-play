import { useState } from "react";
import { createPortal } from "react-dom";
import { usePlayer } from "@/store/player";
import { useSettings } from "@/store/settings";
import { useUi } from "@/store/ui";
import { writeTags } from "@/lib/backend";
import { enrichPatch } from "@/lib/tagEnrich";
import type { Track } from "@/lib/types";
import { Icon } from "./Icons";
import { Sheet } from "./Sheet";
import { CoverPicker } from "./CoverPicker";

/** Edit a track's metadata and write it back to the file (desktop). */
export function TagEditor({ track, onClose }: { track: Track; onClose: () => void }) {
  const updateTrackMeta = usePlayer((s) => s.updateTrackMeta);
  const [f, setF] = useState({
    title: track.title, artist: track.artist, album: track.album,
    albumArtist: track.albumArtist ?? "", genre: track.genre ?? "",
    year: track.year ? String(track.year) : "", trackNo: track.trackNo ? String(track.trackNo) : "",
  });
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [coverOpen, setCoverOpen] = useState(false);
  const tagOnline = useSettings((s) => s.tagOnline);
  const set = (k: keyof typeof f, v: string) => setF((p) => ({ ...p, [k]: v }));

  // Pull tags from on-device analysis (genre) + optional online DB → fills the form (review, then Save).
  const autofill = async () => {
    setBusy(true); setStatus(tagOnline ? "Analyzing + looking up…" : "Analyzing…");
    try {
      const patch = await enrichPatch(track, { online: tagOnline });
      if (Object.keys(patch).length === 0) { setStatus("No new tags found."); return; }
      setF((p) => ({
        ...p,
        title: patch.title ?? p.title, artist: patch.artist ?? p.artist, album: patch.album ?? p.album,
        genre: patch.genre ?? p.genre, year: patch.year != null ? String(patch.year) : p.year,
      }));
      setStatus("Filled — review, then Save.");
    } finally { setBusy(false); }
  };

  // jump to where auto-tagging is configured (Settings → Look → Player: auto-tag / online / write-to-file)
  const goTagSettings = () => {
    useUi.getState().openSettings("appearance", "player");
    usePlayer.getState().setTab("settings");
    onClose();
  };

  const save = async () => {
    setStatus("Saving…");
    const ok = await writeTags(track.path, {
      title: f.title, artist: f.artist, album: f.album, album_artist: f.albumArtist || undefined,
      genre: f.genre || undefined, year: f.year ? parseInt(f.year) : undefined, track_no: f.trackNo ? parseInt(f.trackNo) : undefined,
    });
    if (ok) {
      updateTrackMeta(track.id, {
        title: f.title, artist: f.artist, album: f.album, albumArtist: f.albumArtist || undefined,
        genre: f.genre || undefined, year: f.year ? parseInt(f.year) : undefined, trackNo: f.trackNo ? parseInt(f.trackNo) : undefined,
      });
      onClose();
    } else { setStatus("Couldn't write tags to this file."); }
  };

  const Field = ({ label, k, span }: { label: string; k: keyof typeof f; span?: boolean }) => (
    <label className={`wp-tag-field ${span ? "wp-tag-span" : ""}`}>
      <span className="md-body-s wp-muted">{label}</span>
      <input className="wp-search-input md-body-l" value={f[k]} onChange={(e) => set(k, e.target.value)} />
    </label>
  );

  return createPortal(
    <Sheet onClose={onClose} tall={false}>
        <header className="wp-sheet-head">
          <Icon name="edit" size={20} /><div className="md-title-s">Edit tags</div>
          <div className="wp-tag-head-actions">
            <button className="wp-text-btn md-label-l" onClick={autofill} disabled={busy}
              title={`Auto-fill from analysis${tagOnline ? " + online DB" : ""}`}><Icon name="graphicEq" size={18} /> Auto-fill</button>
            <button className="wp-text-btn md-label-l" onClick={goTagSettings} title="Auto-tag settings"><Icon name="tune" size={18} /> Settings</button>
          </div>
        </header>
        <div className="wp-sheet-actions wp-tag-grid">
          <Field label="Title" k="title" span />
          <Field label="Artist" k="artist" />
          <Field label="Album artist" k="albumArtist" />
          <Field label="Album" k="album" span />
          <Field label="Genre" k="genre" />
          <Field label="Year" k="year" />
          <Field label="Track #" k="trackNo" />
        </div>
        {status && <div className="md-body-s wp-muted" style={{ padding: "4px 8px" }}>{status}</div>}
        <button className="wp-tonal-btn" onClick={() => setCoverOpen(true)} style={{ margin: "8px 6px 2px" }}>
          <Icon name="image" size={18} /> Change cover…
        </button>
        {coverOpen && <CoverPicker track={track} onClose={() => setCoverOpen(false)} onApplied={() => setStatus("Cover updated.")} />}
        <button className="wp-filled-btn" onClick={save} style={{ margin: "2px 6px 2px" }}><Icon name="edit" size={18} /> Save to file</button>
    </Sheet>,
    document.body,
  );
}
