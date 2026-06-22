/** A single playable track in the library / queue. */
export interface Track {
  /** Stable id — the absolute file path (or a synthetic id for demo tracks). */
  id: string;
  /** Absolute filesystem path (native) or a URL (browser/demo). */
  path: string;
  title: string;
  artist: string;
  album: string;
  /** Seconds (0 if unknown until loaded). */
  duration: number;
  albumArtist?: string;
  genre?: string;
  year?: number;
  trackNo?: number;
  discNo?: number;
  /** File modified time (secs since epoch) — for incremental rescans. */
  mtime?: number;
  /** Containing folder (real path/relative-path). Lets the Folders view group content:// tracks whose
   *  `path` is a media id, not a filesystem path. */
  folder?: string;
  /** Optional data/asset URL for album art (lazily filled via coverArt()). */
  artUrl?: string;
  /** Online stream (http(s) URL) — routed to the <audio> backend (not the file-based native engine) and
   *  played without requiring CORS. Internet radio, M3U entries, podcast episodes, etc. */
  streaming?: boolean;
  /** Where this track came from, for display + return-to-origin (e.g. "Radio", a station/playlist name). */
  source?: string;
}

export type RepeatMode = "off" | "all" | "one";

/** A 10-band graphic-EQ preset (gains in dB, −12..+12). Mirrors Poweramp's bands. */
export interface EqPreset {
  name: string;
  /** 10 band gains in dB, low→high. */
  gains: number[];
  /** Pre-amp gain in dB. */
  preamp: number;
  enabled: boolean;
}

/** A FULL EQ state (gains + per-band freq/Q + preamp), e.g. an AutoEq curve or a per-song pin.
 *  Richer than EqPreset because AutoEq/parametric curves move band centres + widths, not just gain. */
export interface EqSnapshot {
  name: string;
  gains: number[];   // 10 band gains, dB
  freqs: number[];   // 10 band centre frequencies, Hz
  qs: number[];      // 10 band Q
  preamp: number;
  enabled: boolean;
}
