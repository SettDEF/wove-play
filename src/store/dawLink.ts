import { create } from "zustand";

export type LinkStatus = "disconnected" | "connecting" | "connected" | "error";

/** Client seam for the WAVR DAW: a LAN WebSocket the DAW will expose. Transport/mixer commands
 *  are sent as JSON; the live monitor/visualizer feed lands in a later phase. */
const LS = "wavrplay-dawhost";
function loadHost(): string { try { return localStorage.getItem(LS) || "192.168.1.50:7700"; } catch { return "192.168.1.50:7700"; } }

interface DawLinkState {
  status: LinkStatus;
  host: string;
  lastError: string;
  lastMessage: unknown;
  setHost: (h: string) => void;
  connect: (host?: string) => void;
  disconnect: () => void;
  send: (msg: object) => void;
}

let ws: WebSocket | null = null;

export const useDawLink = create<DawLinkState>((set, get) => ({
  status: "disconnected",
  host: loadHost(),
  lastError: "",
  lastMessage: null,
  setHost: (host) => { try { localStorage.setItem(LS, host); } catch { /* ignore */ } set({ host }); },
  connect: (host) => {
    const h = (host ?? get().host).trim();
    try { ws?.close(); } catch { /* ignore */ }
    set({ status: "connecting", lastError: "" });
    try {
      const sock = new WebSocket(`ws://${h}/wavr`);
      ws = sock;
      sock.onopen = () => { set({ status: "connected" }); sock.send(JSON.stringify({ type: "hello", app: "wavr-play" })); };
      sock.onmessage = (ev) => { try { set({ lastMessage: JSON.parse(ev.data) }); } catch { set({ lastMessage: ev.data }); } };
      sock.onerror = () => set({ status: "error", lastError: `Couldn't reach WAVR at ${h}` });
      sock.onclose = () => set((s) => (s.status === "connected" ? { status: "disconnected" } : s));
    } catch (e) { set({ status: "error", lastError: String(e) }); }
  },
  disconnect: () => { try { ws?.close(); } catch { /* ignore */ } ws = null; set({ status: "disconnected" }); },
  send: (msg) => { try { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); } catch { /* ignore */ } },
}));
