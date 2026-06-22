import { createPortal } from "react-dom";
import { Icon } from "./Icons";
import { useBackGuard } from "@/lib/backStack";

/** A rounded-rectangle confirmation popup ("are you sure?"). */
export function ConfirmDialog({ title, message, confirmLabel = "Delete", danger = true, onConfirm, onCancel }: {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useBackGuard(true, onCancel); // Android back / Esc cancels the dialog
  return createPortal(
    <div className="wp-dialog-backdrop" onClick={onCancel}>
      <div className="wp-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="wp-dialog-icon"><Icon name={danger ? "trash" : "graphicEq"} size={24} color={danger ? "var(--md-error)" : "var(--md-primary)"} /></div>
        <div className="md-title-m">{title}</div>
        <div className="md-body-m wp-muted">{message}</div>
        <div className="wp-dialog-actions">
          <button className="wp-text-btn md-label-l" onClick={onCancel}>Cancel</button>
          <button className={`wp-filled-btn wp-btn-sm ${danger ? "wp-btn-danger" : ""}`} onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
