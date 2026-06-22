import { useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Icons";
import { useBackGuard } from "@/lib/backStack";

export interface InfoTipProps {
  /** Short heading for the popover. */
  title: string;
  /** Explanatory body text. */
  body: string;
  /** Optional extra controls / advanced options rendered under the body. */
  children?: ReactNode;
}

/**
 * A small (i) button next to a setting. Tapping focuses the setting's explanation into a floating
 * popup pinned to the BOTTOM of the screen — over the mini-player + nav bar — so the text always
 * appears in one predictable place instead of an anchored popover that can clip or land mid-screen.
 * Tap-out / Esc / Android-back closes it. Used by Settings `Row` via its `info` prop.
 */
export function InfoTip({ title, body, children }: InfoTipProps) {
  const [open, setOpen] = useState(false);
  useBackGuard(open, () => setOpen(false)); // Android back / Esc closes the popup first

  return (
    <>
      <button type="button" className="wp-info-btn" onClick={() => setOpen(true)} aria-label={title}>
        <Icon name="info" size={17} />
      </button>
      {open && createPortal(
        <div className="wp-info-scrim" onClick={() => setOpen(false)}>
          <div className="wp-info-pop" role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()}>
            <div className="wp-info-head">
              <Icon name="info" size={18} color="var(--md-primary)" />
              <div className="md-title-s wp-row-text ellipsis">{title}</div>
              <button type="button" className="wp-info-close md-icon-btn" onClick={() => setOpen(false)} aria-label="Close"><Icon name="close" size={18} /></button>
            </div>
            <div className="md-body-s wp-muted">{body}</div>
            {children && <div className="wp-info-extra">{children}</div>}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
