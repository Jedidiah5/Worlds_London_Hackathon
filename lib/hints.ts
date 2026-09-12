// The hint ladder. A judge has two minutes and no manual — they must never be
// stuck wondering what the verb is. Hints escalate with time and loop number,
// and the objective line is always present once it matters.

import type { GameState } from "@/lib/state";
import type { Settings } from "@/lib/settings";

export type Hint = {
  // The single line shown in the centre of the screen.
  text: string;
  // "objective" lines are persistent and brass; "nudge" lines are transient.
  tone: "objective" | "nudge";
};

export function currentHint(
  state: GameState,
  settings: Settings,
  elapsedThisLoop: number,
): Hint | null {
  if (!settings.hintsEnabled) return null;

  // Once you hold the key there is exactly one thing to do, and the app says so
  // until it is done. This is the answer to "nothing tells me how to finish".
  if (state.hasKey) {
    return {
      text: "GO TO THE LIT DOORWAY AT THE END OF THE CORRIDOR — PRESS E THERE",
      tone: "objective",
    };
  }

  if (state.keyVisible) {
    return { text: "THERE IT IS — PRESS E TO TAKE THE KEY", tone: "objective" };
  }

  // First loop is for learning the floor, not for winning.
  if (state.loopNumber < settings.keyMinLoop) {
    if (elapsedThisLoop < 8) {
      return { text: "W A S D TO WALK · MOVE THE MOUSE TO LOOK", tone: "nudge" };
    }
    if (elapsedThisLoop < 16) {
      return { text: "LOOK AROUND. LEARN THE FLOOR.", tone: "nudge" };
    }
    if (elapsedThisLoop > 26 && elapsedThisLoop < 36) {
      return { text: "YOU WILL NOT GET OUT ON THE FIRST LOOP.", tone: "nudge" };
    }
    return null;
  }

  // Eligible loops: teach the search verb, then push them to move on.
  if (state.searchesThisLoop === 0) {
    return { text: "PRESS E TO SEARCH WHATEVER IS IN FRONT OF YOU", tone: "objective" };
  }

  const remaining =
    (state.hadKeyEver ? 1 : settings.keySearchIndex) - state.searchesThisLoop;
  if (remaining > 0) {
    return { text: "NOT HERE. WALK SOMEWHERE ELSE AND SEARCH AGAIN.", tone: "nudge" };
  }

  return null;
}

// Shown on the wake card from loop 2 onward, so the reset always teaches
// something rather than only repeating.
export function wakeHint(state: GameState, settings: Settings): string | null {
  if (!settings.hintsEnabled) return null;
  if (state.hadKeyEver) return "It took the key back. Find it again — it is faster now.";
  if (state.loopNumber === settings.keyMinLoop) {
    return "Something is different this time. Search the furniture.";
  }
  return null;
}
