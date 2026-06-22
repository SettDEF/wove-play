import { create } from "zustand";

export type ToastKind = "info" | "success" | "error" | "progress";
export interface Toast { id: number; kind: ToastKind; message: string; progress?: number; key?: string; }

let seq = 0;

interface ToastState {
  toasts: Toast[];
  push: (kind: ToastKind, message: string, progress?: number, key?: string) => number;
  update: (id: number, patch: Partial<Toast>) => void;
  dismiss: (id: number) => void;
}

export const useToasts = create<ToastState>((set, get) => ({
  toasts: [],
  push: (kind, message, progress, key) => {
    // A keyed toast is a singleton: reuse the existing one so repeated calls (e.g. re-entered
    // scans / hot-reloads) update ONE toast instead of stacking many in a row.
    if (key) {
      const existing = get().toasts.find((t) => t.key === key);
      if (existing) {
        set((s) => ({ toasts: s.toasts.map((t) => (t.id === existing.id ? { ...t, kind, message, progress } : t)) }));
        if (kind !== "progress") setTimeout(() => get().dismiss(existing.id), kind === "error" ? 6000 : 2800);
        return existing.id;
      }
    }
    const id = ++seq;
    set((s) => ({ toasts: [...s.toasts.slice(-4), { id, kind, message, progress, key }] }));
    if (kind !== "progress") setTimeout(() => get().dismiss(id), kind === "error" ? 6000 : 2800);
    return id;
  },
  update: (id, patch) => set((s) => ({ toasts: s.toasts.map((t) => (t.id === id ? { ...t, ...patch } : t)) })),
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

/** Convenience API: `toast.info("…")`, `toast.error(…)`, and a progress handle for long jobs. */
export const toast = {
  info: (m: string) => useToasts.getState().push("info", m),
  success: (m: string) => useToasts.getState().push("success", m),
  error: (m: string) => useToasts.getState().push("error", m),
  progress: (m: string, key?: string) => {
    const id = useToasts.getState().push("progress", m, undefined, key);
    return {
      update: (message: string, progress?: number) => useToasts.getState().update(id, { message, progress }),
      done: (message?: string) => {
        if (message) {
          useToasts.getState().update(id, { kind: "success", message, progress: undefined });
          setTimeout(() => useToasts.getState().dismiss(id), 2800);
        } else { useToasts.getState().dismiss(id); }
      },
      fail: (message: string) => {
        useToasts.getState().update(id, { kind: "error", message, progress: undefined });
        setTimeout(() => useToasts.getState().dismiss(id), 6000);
      },
    };
  },
};
