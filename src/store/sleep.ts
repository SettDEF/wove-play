import { create } from "zustand";

/** Sleep timer — playback pauses when `endsAt` (epoch seconds) is reached. */
interface SleepState {
  endsAt: number | null;
  minutes: number;       // last chosen duration (for the UI)
  start: (min: number) => void;
  cancel: () => void;
}

export const useSleep = create<SleepState>((set) => ({
  endsAt: null,
  minutes: 0,
  start: (min) => set({ minutes: min, endsAt: min > 0 ? Math.floor(Date.now() / 1000) + min * 60 : null }),
  cancel: () => set({ endsAt: null, minutes: 0 }),
}));

/** Seconds left on the timer (0 if inactive). Compute against the live clock. */
export function sleepRemaining(endsAt: number | null): number {
  return endsAt ? Math.max(0, endsAt - Math.floor(Date.now() / 1000)) : 0;
}
