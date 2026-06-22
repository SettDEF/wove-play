import { createPortal } from "react-dom";
import { useToasts, type ToastKind } from "@/store/toasts";
import { Icon } from "./Icons";

const ICON: Record<ToastKind, string> = { info: "graphicEq", success: "star", error: "close", progress: "refresh" };

/** App-wide toast/progress notifications (above the nav bar). Tap to dismiss. */
export function Toaster() {
  const toasts = useToasts((s) => s.toasts);
  const dismiss = useToasts((s) => s.dismiss);
  if (!toasts.length) return null;
  return createPortal(
    <div className="wp-toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`wp-toast wp-toast-${t.kind}`} onClick={() => dismiss(t.id)}>
          <span className={`wp-toast-icon ${t.kind === "progress" ? "wp-toast-spin" : ""}`}><Icon name={ICON[t.kind]} size={18} /></span>
          <span className="md-body-m ellipsis wp-toast-msg">{t.message}</span>
          {typeof t.progress === "number" && <span className="md-label-m wp-toast-pct">{Math.round(t.progress)}%</span>}
        </div>
      ))}
    </div>,
    document.body,
  );
}
