// The truth lives here, outside the model. Dead simple on purpose —
// it will be edited under time pressure.

import type { Settings } from "@/lib/settings";

export const EVENT_CHUNKS = 2; // How many model chunks a transient event persists.
export const ESCAPE_SECONDS = 7; // White-out duration before the end card.

export type Phase =
  | "title" // start screen, waiting for anchor + start
  | "booting" // connecting / conditioning the model
  | "loop" // playing; timer runs
  | "waking" // between loops; model is being re-staged behind a black overlay
  | "escape" // door is open; white-out running
  | "ended" // end card
  | "error"; // degraded; frozen frame + retry

export type GameState = {
  phase: Phase;
  loopNumber: number; // 1-based
  secondsLeft: number;
  searchesThisLoop: number;
  keyVisible: boolean;
  hasKey: boolean;
  hadKeyEver: boolean; // the loop takes the key back, but the player remembers
  totalSeconds: number; // time spent inside, for the end card
};

export function initialState(loopSeconds: number): GameState {
  return {
    phase: "title",
    loopNumber: 1,
    secondsLeft: loopSeconds,
    searchesThisLoop: 0,
    keyVisible: false,
    hasKey: false,
    hadKeyEver: false,
    totalSeconds: 0,
  };
}

// Does this search (already counted) reveal the key?
// After the loop has stolen the key back once, the first search re-finds it.
export function searchRevealsKey(state: GameState, settings: Settings): boolean {
  const threshold = state.hadKeyEver ? 1 : settings.keySearchIndex;
  return (
    !state.hasKey &&
    !state.keyVisible &&
    state.loopNumber >= settings.keyMinLoop &&
    state.searchesThisLoop >= threshold
  );
}

export function formatClock(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
