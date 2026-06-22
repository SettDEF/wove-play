import { useDawLink, type LinkStatus } from "@/store/dawLink";
import { Icon } from "./Icons";

const FEATURES = [
  { icon: "graphicEq", title: "Remote control", body: "Transport, faders, mute/solo over your local network." },
  { icon: "volume", title: "Live monitor", body: "Stream WAVR's master or a stem straight to this device." },
  { icon: "library", title: "Library & renders", body: "Browse WAVR projects and pull bounced tracks into your library." },
  { icon: "hub", title: "Visualizer feed", body: "Drive the visualiser from the live DAW signal." },
];

const STATUS_LABEL: Record<LinkStatus, string> = { disconnected: "Not connected", connecting: "Connecting…", connected: "Connected", error: "Connection failed" };

/** WAVR DAW link: connect to the DAW's LAN WebSocket and send transport commands.
 *  (Live monitor / visualizer feed are a later phase — this is the control seam.) */
export function DawLink() {
  const { status, host, lastError } = useDawLink();
  const { setHost, connect, disconnect, send } = useDawLink.getState();
  const connected = status === "connected";

  const transport = (action: string) => send({ type: "transport", action });

  return (
    <div className="wp-screen wp-daw">
      <div className="wp-daw-hero">
        <div className={`wp-daw-logo wp-link-${status}`}><Icon name="hub" size={40} color="var(--md-on-primary)" /></div>
        <div className="md-headline-s">Connect to WAVR</div>
        <div className={`wp-link-status md-label-m wp-link-${status}`}>
          <span className="wp-link-dot" /> {STATUS_LABEL[status]}
        </div>

        <div className="wp-daw-conn">
          <input className="wp-search-input md-body-l" placeholder="host:port (e.g. 192.168.1.50:7700)" value={host}
            onChange={(e) => setHost(e.target.value)} disabled={connected || status === "connecting"} />
          {connected
            ? <button className="wp-filled-btn" onClick={() => disconnect()}>Disconnect</button>
            : <button className="wp-filled-btn" onClick={() => connect()} disabled={status === "connecting"}>{status === "connecting" ? "Connecting…" : "Connect"}</button>}
        </div>
        {lastError && status === "error" && <div className="md-body-s wp-muted">{lastError}</div>}

        {connected && (
          <div className="wp-daw-transport">
            <button className="md-icon-btn wp-big" title="Previous" onClick={() => transport("prev")}><Icon name="prev" size={28} /></button>
            <button className="md-icon-btn wp-big" title="Stop" onClick={() => transport("stop")}><Icon name="pause" size={28} /></button>
            <button className="wp-fab" title="Play" onClick={() => transport("play")}><Icon name="play" size={30} /></button>
            <button className="md-icon-btn wp-big" title="Record" onClick={() => transport("record")}><Icon name="power" size={26} /></button>
            <button className="md-icon-btn wp-big" title="Next" onClick={() => transport("next")}><Icon name="next" size={28} /></button>
          </div>
        )}
      </div>

      <div className="wp-daw-grid">
        {FEATURES.map((f) => (
          <div key={f.title} className="wp-daw-card">
            <Icon name={f.icon} size={22} color="var(--md-primary)" />
            <div className="md-title-s">{f.title}</div>
            <div className="md-body-s wp-muted">{f.body}</div>
          </div>
        ))}
      </div>
      <div className="md-body-s wp-muted wp-daw-note">WAVR exposes a local WebSocket; enter its host and connect. Live audio monitoring arrives in a later update.</div>
    </div>
  );
}
