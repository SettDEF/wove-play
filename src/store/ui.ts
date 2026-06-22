import { create } from "zustand";

/** Ephemeral, app-wide UI state (not persisted). Keeps one-off overlays out of the data stores. */
interface UiState {
  introOpen: boolean;
  openIntro: () => void;
  closeIntro: () => void;
  /** A Settings sub-page to jump to (e.g. from a nav-bloom action). Settings consumes + clears it. */
  settingsSub: string | null;
  /** Optional Look category (e.g. "player") to drill into when sub === "appearance". */
  settingsLook: string | null;
  openSettings: (sub: string, look?: string | null) => void;
  clearSettingsSub: () => void;
}

export const useUi = create<UiState>((set) => ({
  introOpen: false,
  openIntro: () => set({ introOpen: true }),
  closeIntro: () => set({ introOpen: false }),
  settingsSub: null,
  settingsLook: null,
  openSettings: (settingsSub, settingsLook = null) => set({ settingsSub, settingsLook }),
  clearSettingsSub: () => set({ settingsSub: null, settingsLook: null }),
}));
