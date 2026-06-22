import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { toast } from "./store/toasts";
import "./index.scss";

// Safety net: surface stray async failures as a toast instead of letting them go silent (or, on some
// webviews, tear down the page). Keeps a single bad native call from feeling like a crash.
window.addEventListener("unhandledrejection", (e) => {
  // eslint-disable-next-line no-console
  console.error("[Wove] unhandled rejection:", e.reason);
  try { toast.error("Something failed: " + (e.reason?.message ?? String(e.reason))); } catch { /* ignore */ }
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
