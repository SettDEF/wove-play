import type { Track } from "./types";
import type { SwipeAct } from "@/components/SwipeRow";
import { usePlayer } from "@/store/player";
import { useRatings } from "@/store/ratings";
import { toast } from "@/store/toasts";

/** Every action a row swipe can perform. Context-specific ones (remove…) are supplied by the caller. */
export type SwipeActionId =
  | "like" | "queue" | "playNext" | "play" | "goArtist" | "none"
  | "removeQueue" | "removePlaylist";

export interface SwipeActionDef {
  id: SwipeActionId;
  label: string;
  icon: string;
  color: string;
  /** Only the actions a user may freely assign to the Songs list appear in Settings. */
  assignable: boolean;
}

// Solid, theme-harmonious swipe colors (the old palette put a kelly-green "Like" next to the maroon
// accent, which clashed). Each is a saturated tone that reads clearly behind a row with white icons;
// they're deliberately distinct from each other and from the accent so the action is obvious at a glance.
const ROSE = "#e0566f";   // like / love (NOT green — love reads red/pink)
const TEAL = "#2f8f9e";   // add to queue
const VIOLET = "#7c6fcf"; // play next
const GREEN = "#3fa45c";  // play now (go)
const SLATE = "#5a6b8c";  // go to artist
const RED = "#c5402f";    // remove / destructive

export const SWIPE_ACTIONS: SwipeActionDef[] = [
  { id: "none", label: "Nothing", icon: "close", color: "#555", assignable: true },
  { id: "like", label: "Like", icon: "favorite", color: ROSE, assignable: true },
  { id: "queue", label: "Add to queue", icon: "queue", color: TEAL, assignable: true },
  { id: "playNext", label: "Play next", icon: "playNextIcon", color: VIOLET, assignable: true },
  { id: "play", label: "Play now", icon: "play", color: GREEN, assignable: true },
  { id: "goArtist", label: "Go to artist", icon: "artist", color: SLATE, assignable: true },
  { id: "removeQueue", label: "Remove", icon: "close", color: RED, assignable: false },
  { id: "removePlaylist", label: "Remove", icon: "close", color: RED, assignable: false },
];

export const def = (id: SwipeActionId) => SWIPE_ACTIONS.find((a) => a.id === id) ?? SWIPE_ACTIONS[0];

/**
 * Build a concrete SwipeAct for a track. `ctx` carries handlers only the caller knows
 * (e.g. remove-at-index for the queue / playlist). Returns null for "none".
 */
export function makeSwipeAct(id: SwipeActionId, t: Track, ctx?: { onRemove?: () => void }): SwipeAct | undefined {
  const d = def(id);
  const base = { icon: d.icon, label: d.label, color: d.color };
  switch (id) {
    case "none":
      return undefined;
    case "like":
      return { ...base, on: () => {
        const r = useRatings.getState(); const loved = (r.stats[t.id]?.rating ?? 0) >= 4;
        r.setRating(t.id, loved ? 0 : 5); toast.success(loved ? "Removed from liked" : "Added to liked songs");
      } };
    case "queue":
      return { ...base, on: () => { usePlayer.getState().addToQueue([t]); toast.success("Added to queue"); } };
    case "playNext":
      return { ...base, on: () => { usePlayer.getState().playNext([t]); toast.success("Playing next"); } };
    case "play":
      return { ...base, on: () => usePlayer.getState().playFrom([t], 0) };
    case "goArtist":
      return { ...base, on: () => { if (t.artist) usePlayer.getState().goToArtist(t.artist); } };
    case "removeQueue":
    case "removePlaylist":
      return { ...base, on: () => ctx?.onRemove?.() };
  }
}
