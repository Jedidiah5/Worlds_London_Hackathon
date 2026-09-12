// The content layer. Everything a judge sees the model do is described here.
// Tune prompts in this file; the state machine lives in lib/state.ts.
//
// The anchor is the venue itself — a judge standing in this building is looking
// at the room they are standing in. That is the hook; keep the contract matched
// to whatever public/anchors/bedroom.png actually shows.

export const SEED = 1408;

export const ANCHOR_URL = "/anchors/bedroom.png";

export type WorldContract = {
  camera: string;
  environment: string;
  invariants: string;
};

export const WORLD: WorldContract = {
  camera:
    "First-person view at standing human eye height, roughly 1.6 metres above the floor, looking straight ahead and level down the corridor. The horizon stays near the middle of the frame with the ceiling visible across the top of the shot and the floor filling no more than the bottom third. Never tilt the camera down toward the floor, never look at the ground, never angle up into the ceiling, and never roll the horizon. No body, hands, feet, avatar, or reflection of the viewer is ever visible. Movement is a steady, calm human walking pace with natural gentle head motion. Never float, never rise to ceiling height, never sink toward the floor.",
  environment:
    "The same modern open-plan office floor throughout: deep forest-green painted walls and columns, a black exposed ceiling of ducts and pipes on the left, trailing green ferns hanging from the ceiling line, tall black slatted timber screens enclosing soft seating booths with grey sofas and dark green cushions, a tan leather armchair and a woven rattan chair in the near foreground, warm oak flooring in the lounge, pale grey tiled flooring in the corridor, a long dark wood reception counter along the right wall, recessed ceiling downlights and linear LED strips, and a bright white-lit doorway at the far end of the corridor straight ahead.",
  invariants:
    "Never go outside and never show the outdoors except as white light through the far doorway. Never show any person, figure, face, crowd, animal, or creature anywhere. Never change the floor plan: the corridor, the seating booths, the reception counter, the columns, and the far doorway stay exactly where they are relative to each other. Solid surfaces block movement — the viewer never passes through walls, columns, glass, slatted screens, the reception counter, or furniture; when the viewer moves toward a solid surface the view stops advancing and that surface stays solid and intact in front of them, never dissolving or opening. Maintain strict spatial continuity: walls, doors, and furniture never move or vanish between moments.",
};

export type LoopVariation = {
  label: string;
  // The atmosphere for this pass through the floor. This is the visible
  // loop-to-loop change — the reason this needs a world model.
  atmosphere: string;
  // Ambient motion for when the viewer stands still.
  ambient: string;
  // The line shown on the wake-up overlay entering this loop.
  wakeLine: string;
};

export const VARIATIONS: LoopVariation[] = [
  {
    label: "09:00",
    atmosphere:
      "Ordinary working daylight. Every downlight and LED strip is on, the green walls read clean and even, the plants are neatly trimmed, and the floor is spotless. Everything is completely normal, and completely empty of people.",
    ambient:
      "The hanging ferns stir very slightly in the air conditioning; the light is flat and steady.",
    wakeLine: "You wake up.",
  },
  {
    label: "AFTER HOURS",
    atmosphere:
      "The overhead lights have dropped to a dim standby amber and long shadows stretch down the corridor. The ferns have grown noticeably longer, trailing far down the green columns. Chairs sit at angles nobody left them at, and the far doorway glows a little too brightly.",
    ambient:
      "The long shadows creep almost imperceptibly; a trailing frond sways with no breeze.",
    wakeLine: "You wake up. Again.",
  },
  {
    label: "FAILING",
    atmosphere:
      "Most of the lighting has failed. The remaining LED strips flicker and buzz, throwing the booths into deep shadow. The ferns have overgrown into a dense curtain across the ceiling, the green walls are streaked with damp, and moisture pools on the grey tiles, reflecting the flicker.",
    ambient:
      "The surviving strip lights stutter unevenly; shadows tremble across the slatted screens.",
    wakeLine: "Again.",
  },
  {
    label: "OVERGROWN",
    atmosphere:
      "Near-total darkness lit only by a faint sickly green glow with no visible source. The plants have taken the building: roots split the ceiling tiles, ivy swallows the reception counter and the slatted screens, and the corridor is choked to a narrow path. The corridor also looks longer than it should be.",
    ambient:
      "The green glow pulses very slowly, as if the building is breathing through the leaves.",
    wakeLine: "The building is warmer than it was.",
  },
];

// Loops beyond the list stay on the final variation. The building does not heal.
export function variationForLoop(loopNumber: number): LoopVariation {
  return VARIATIONS[Math.min(loopNumber - 1, VARIATIONS.length - 1)];
}

export const STATIC_PROMPT =
  "The viewer stands still at standing eye height, looking level straight ahead along the corridor with the ceiling visible above and the far doorway ahead. Nothing moves except ambient detail.";

export const MOVING_PROMPT =
  "The viewer walks smoothly through the office floor at a calm, wary human pace, moving along the corridor and between the columns naturally while the walls, booths, counter, and doorway stay solid and consistent.";

export const BLOCKED_PROMPT =
  "The viewer has walked into a solid surface and cannot go further. The view stops advancing, the surface directly ahead stays solid and intact, and the camera settles as the viewer stops.";

// Transient event prompts, appended for a couple of chunks then dropped.
export const EVENTS = {
  search:
    "The camera dips and tilts downward briefly as the viewer searches the nearest surface — a drawer slides open, cushions and clutter shift — then the camera returns to standing eye height. The furniture itself stays exactly in place.",
  keyReveal:
    "In the opened drawer directly ahead, a single small tarnished brass key lies in plain view, faintly catching the light.",
  takeKey:
    "The camera dips toward the open drawer and the small brass key is taken out of view, then the camera returns to standing eye height. The drawer and the room are unchanged.",
  escape:
    "The door at the bright far end of the corridor swings slowly open and blinding white daylight floods in, growing brighter and brighter until the whole corridor dissolves entirely into pure white light.",
} as const;

export function composeWorldPrompt(options: {
  loopNumber: number;
  moving: boolean;
  blocked: boolean;
  searchActive: boolean;
  keyVisible: boolean;
  takeActive: boolean;
  escaping: boolean;
}): string {
  const variation = variationForLoop(options.loopNumber);
  const parts = [
    `IMMUTABLE CAMERA CONTRACT: ${WORLD.camera}`,
    `IMMUTABLE ENVIRONMENT CONTRACT: ${WORLD.environment}`,
    `CURRENT ATMOSPHERE: ${variation.atmosphere}`,
    `NON-NEGOTIABLE CONTINUITY RULES: ${WORLD.invariants}`,
  ];
  if (options.escaping) {
    parts.push(EVENTS.escape);
    return parts.join(" ");
  }
  if (options.blocked) {
    parts.push(BLOCKED_PROMPT);
  } else {
    parts.push(
      options.moving ? MOVING_PROMPT : `${STATIC_PROMPT} ${variation.ambient}`,
    );
  }
  if (options.searchActive) parts.push(EVENTS.search);
  if (options.keyVisible) parts.push(EVENTS.keyReveal);
  if (options.takeActive) parts.push(EVENTS.takeKey);
  return parts.join(" ");
}
