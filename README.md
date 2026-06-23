# Wove

A Material 3 music player with a live visualizer, parametric EQ, and on-device
taste mixes — for **Linux/desktop** and **Android**. Built with React + Zustand
on a Tauri 2 / Rust shell, with a native Rust audio engine for gapless,
Poweramp-grade playback.

> Status: active development (pre-1.0).

## Features

- **Player** — gapless playback, smart crossfade, ReplayGain-style leveling, an
  "Endless" auto-queue, A–B loop, and vinyl scrub gestures.
- **Native audio engine** — decode → DSP → cpal/oboe, with
  dual-voice gapless + crossfade, balance/mono, and hi-res output.
- **Parametric EQ** — per-track AutoEq (FFT), per-song pinned curves, and a
  Poweramp-style preset browser; optional Bluetooth-device EQ auto-switching.
- **Sound-DNA glyphs** — a unique, deterministic generative fingerprint for tracks
  without cover art.
- **Taste engine** — a fully on-device, content-based recommender:
  genre/BPM/key analysis, clustering, a "For You" feed, and an Explore map.
- **Library** — fast indexing of large (50k+) libraries, tag editing, cover
  picker, folders/albums/artists/genres/years views.
- **Streaming (all legal)** — stream URLs/M3U/PLS, internet radio, Jamendo (CC),
  Subsonic/Navidrome, podcasts, plus a sandboxed community **extension host**.
- **Desktop integration** — MPRIS media controls, a proper `.desktop` entry, and
  configurable keyboard shortcuts. Android: foreground MediaSession, Android
  Auto, and lock-screen controls.

## Tech stack

| Layer   | Tech                                                       |
| ------- | --------------------------------------------------------- |
| UI      | React 18, Zustand, Sass (runtime CSS custom-prop theming) |
| Shell   | Tauri 2                                                    |
| Engine  | Rust (native audio + on-device taste engine), cpal / oboe  |
| Targets | Linux desktop, Android (Windows/macOS untested)           |

## Development

Requires Node 18+, Rust (stable), and the
[Tauri prerequisites](https://tauri.app/start/prerequisites/) for your platform.

```bash
npm install
npm run tauri:dev        # desktop dev (Rust + Vite)
npm run build            # type-check + build the web bundle
```

On a multi-display Linux setup you may need to pin the display, e.g.
`DISPLAY=:1 npm run tauri:dev`.

## Building

```bash
npm run tauri:build      # deb + rpm + AppImage (Linux)
```

The `tauri:build` script sets `NO_STRIP=1 APPIMAGE_EXTRACT_AND_RUN=1` — required
on modern toolchains (Arch, etc.) where `linuxdeploy`'s bundled `strip` can't
parse the new ELF `.relr.dyn` section and the AppImage step otherwise fails.

Android:

```bash
npm run android:init     # once
npm run android:dev      # or: tauri android build --apk  (needs JDK 17 + NDK)
```

## Changelog

See [CHANGELOG.md](./CHANGELOG.md) for per-version notes, or the
[Releases page](https://github.com/SettDEF/wove-play/releases) for downloads.

## Roadmap

Planned / ideas (unordered, not promises):

- [ ] Windows & macOS installers (via CI)
- [ ] Signed auto-updater (download + install in-app)
- [ ] Distribution: AUR · Flathub · F-Droid
- [ ] AcoustID fingerprinting + online cover art (Deezer / Cover Art Archive)
- [ ] Jellyfin support (alongside Subsonic / Navidrome)
- [ ] Sharper key / BPM detection
- [ ] **Live audio-reactive visualizer** — unfinished / work in progress
- [ ] Lyrics improvements (synced, more providers)

Got an idea? Open an issue.

## License

[GPL-3.0-or-later](./LICENSE) © 2026 Wove

Open source under the GPL so the community can use, study and improve it, while the
shared audio/taste engine can't be folded into a closed competing product.
