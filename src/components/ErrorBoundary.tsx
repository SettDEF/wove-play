import { Component, type ReactNode } from "react";

interface State { error: Error | null }

/** Last-resort guard: a render error anywhere below this would otherwise unmount the whole React
 *  tree → a blank white screen (reads as an app "crash", especially on Android). Instead we catch it
 *  and show a recoverable fallback so the user can reload rather than being stuck. */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State { return { error }; }

  componentDidCatch(error: Error) {
    // eslint-disable-next-line no-console
    console.error("[Wove] render crash:", error);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div style={{
        position: "fixed", inset: 0, display: "flex", flexDirection: "column",
        alignItems: "center", justifyContent: "center", gap: 16, padding: 24,
        textAlign: "center", background: "var(--md-surface, #111)", color: "var(--md-on-surface, #eee)",
      }}>
        <div style={{ fontSize: 18, fontWeight: 600 }}>Something went wrong</div>
        <div style={{ fontSize: 13, opacity: 0.7, maxWidth: 420, wordBreak: "break-word" }}>
          {this.state.error.message || String(this.state.error)}
        </div>
        {this.state.error.stack && (
          <div style={{ fontSize: 11, opacity: 0.5, maxWidth: 460, maxHeight: 120, overflow: "auto", whiteSpace: "pre-wrap", fontFamily: "monospace" }}>
            {this.state.error.stack.split("\n").slice(0, 4).join("\n")}
          </div>
        )}
        <button
          onClick={() => { this.setState({ error: null }); location.reload(); }}
          style={{
            padding: "10px 22px", borderRadius: 22, border: "none", cursor: "pointer",
            background: "var(--md-primary, #c9a6ff)", color: "var(--md-on-primary, #1a1024)", fontWeight: 600,
          }}
        >Reload</button>
      </div>
    );
  }
}
