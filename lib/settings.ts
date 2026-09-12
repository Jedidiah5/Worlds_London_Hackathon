// Live-tunable knobs, exposed through the gear icon and persisted per browser.
// Everything here is safe to change mid-demo.

export type Settings = {
  loopSeconds: number;
  mouseSensitivity: number; // 0.2 – 3.0
  invertY: boolean;
  lookSpeedDeg: number; // maps to set_rotation_speed_deg, 0 – 30
  hintsEnabled: boolean;
  keyMinLoop: number; // earliest loop the key can appear
  keySearchIndex: number; // searches needed in an eligible loop
  collisionFeedback: boolean; // detect walking into a wall
  showDebug: boolean;
  tiltEnabled: boolean; // phone tilt steers left/right
  tiltSensitivity: number; // 0.2 – 3.0
  touchControls: "auto" | "on" | "off";
  moveSpeed: 1 | 2 | 3 | 4; // walking pace: prompt wording + camera-pose push
  showHands: boolean; // render the player's own hands in first person
  headBob: boolean; // gait bob applied through camera pose
  soundEnabled: boolean;
  volume: number; // 0 – 1
};

export const DEFAULT_SETTINGS: Settings = {
  loopSeconds: 60,
  mouseSensitivity: 1,
  invertY: false,
  // Degrees of turn per latent frame. Reactor's prompt guide asks for
  // <= ~0.05 rad/frame (~2.9 deg) because rotation compounds and drives drift.
  lookSpeedDeg: 2.5,
  hintsEnabled: true,
  keyMinLoop: 2,
  keySearchIndex: 2,
  collisionFeedback: true,
  showDebug: false,
  tiltEnabled: false,
  tiltSensitivity: 1,
  touchControls: "auto",
  // Faster movement generates more novel views and drifts off the anchor
  // sooner. Brisk is the compromise that still reads as the same building.
  moveSpeed: 2,
  showHands: true,
  headBob: true,
  soundEnabled: true,
  volume: 0.7,
};

const STORAGE_KEY = "loop-house-settings";

export function loadSettings(): Settings {
  if (typeof window === "undefined") return DEFAULT_SETTINGS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(settings: Settings) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // A blocked storage API must never take the demo down.
  }
}
