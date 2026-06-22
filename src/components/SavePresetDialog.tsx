import { useState } from "react";
import { createPortal } from "react-dom";
import { useBackGuard } from "@/lib/backStack";
import { Icon } from "./Icons";

/** Name-and-save dialog for an EQ preset (Poweramp "Save Preset"): a name field plus an option to pin
 *  the curve to the current song so it auto-applies whenever that track plays. */
export function SavePresetDialog({ defaultName, songTitle, onSave, onClose }: {
  defaultName: string;
  songTitle?: string;
  onSave: (name: string, pinSong: boolean) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(defaultName);
  const [pin, setPin] = useState(false);
  useBackGuard(true, onClose);
  const submit = () => { const n = name.trim(); if (n) onSave(n, pin); };
  return createPortal(
    <div className="wp-dialog-backdrop" onClick={onClose}>
      <div className="wp-dialog wp-saveeq" onClick={(e) => e.stopPropagation()}>
        <div className="md-title-m">Save preset</div>
        <input className="wp-text-input" value={name} placeholder="Preset name" autoFocus spellCheck={false}
          onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") submit(); }} />
        {songTitle && (
          <button className="wp-saveeq-pin" onClick={() => setPin((p) => !p)}>
            <span className={`wp-saveeq-box ${pin ? "wp-saveeq-box-on" : ""}`}>{pin && <Icon name="check" size={13} color="#fff" />}</span>
            <span className="wp-row-text">
              <span className="md-body-m">Apply to this song</span>
              <span className="md-body-s wp-muted ellipsis">{songTitle}</span>
            </span>
          </button>
        )}
        <div className="wp-dialog-actions">
          <button className="wp-text-btn md-label-l" onClick={onClose}>Cancel</button>
          <button className="wp-filled-btn wp-btn-sm" onClick={submit} disabled={!name.trim()}>Save</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
