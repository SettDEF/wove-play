import { useEffect, useState } from "react";
import { Icon } from "./Icons";
import { Sheet } from "./Sheet";
import { castDiscover, castPlay, castStop, streamSetLan, type CastDevice } from "@/lib/backend";
import { useSettings } from "@/store/settings";
import { toast } from "@/store/toasts";
import type { Track } from "@/lib/types";

/** Cast picker: ensures LAN sharing is on, scans the network, and streams the current track to the
 *  chosen TV / Chromecast. DLNA renderers play today; Chromecasts are listed (handshake is a
 *  follow-up) and reported honestly. */
export function CastSheet({ track, onClose }: { track: Track; onClose: () => void }) {
  const [devices, setDevices] = useState<CastDevice[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [casting, setCasting] = useState<string | null>(null);
  const streamLan = useSettings((s) => s.streamLan);
  const setStreamLan = useSettings((s) => s.setStreamLan);

  const scan = async () => {
    setDevices(null);
    if (!streamLan) setStreamLan(true);   // casting needs the server reachable on the LAN
    await streamSetLan(true);
    setDevices(await castDiscover());
  };
  useEffect(() => { scan(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const send = async (d: CastDevice) => {
    setBusy(d.id);
    try {
      await castPlay(d.id, track.path, track.title);
      setCasting(d.id);
      toast.info(`Casting to ${d.name}`);
    } catch (e) {
      toast.info(e instanceof Error ? e.message : "Couldn't cast to that device");
    } finally { setBusy(null); }
  };
  const disconnect = async (d: CastDevice) => { await castStop(d.id); setCasting(null); toast.info("Stopped casting"); };

  return (
    <Sheet onClose={onClose} className="wp-cast">
      <header className="wp-sheet-head">
        <div className="wp-row-text">
          <div className="md-title-m">Cast to device</div>
          <div className="md-body-s wp-muted">On this Wi-Fi · streamed from your library</div>
        </div>
        <button className="md-icon-btn" onClick={scan} title="Rescan"><Icon name="refresh" size={20} /></button>
      </header>

      {devices === null ? (
        <div className="wp-cast-state md-body-m wp-muted"><span className="wp-spin"><Icon name="refresh" size={20} /></span> Looking for devices…</div>
      ) : devices.length === 0 ? (
        <div className="wp-cast-state md-body-m wp-muted">
          <Icon name="cast" size={28} color="var(--md-on-surface-variant)" />
          No devices found on this network. Make sure your TV or speaker is on the same Wi-Fi, then rescan.
        </div>
      ) : (
        <div className="wp-list">
          {devices.map((d) => {
            const on = casting === d.id;
            return (
              <div key={d.id} className="wp-row wp-cast-row">
                <div className="wp-art"><Icon name={d.kind === "chromecast" ? "cast" : "tv"} size={20} color={on ? "var(--md-primary)" : undefined} /></div>
                <div className="wp-row-text">
                  <div className="md-body-l ellipsis">{d.name}</div>
                  <div className="md-body-s wp-muted ellipsis">{on ? "Casting now" : `${d.kind === "chromecast" ? "Chromecast" : "DLNA"} · ${d.address}`}</div>
                </div>
                {on ? (
                  <button className="wp-filled-btn wp-btn-sm" onClick={() => disconnect(d)}>Stop</button>
                ) : (
                  <button className="wp-filled-btn wp-btn-sm" disabled={busy === d.id} onClick={() => send(d)}>
                    {busy === d.id ? "…" : "Cast"}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Sheet>
  );
}
