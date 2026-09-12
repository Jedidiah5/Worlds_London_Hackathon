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

// Framing shared by both embodiment modes.
const CAMERA_BASE =
  "First-person view at standing human eye height, roughly 1.6 metres above the floor, looking straight ahead and level down the corridor. The horizon stays near the middle of the frame with the ceiling visible across the top of the shot and the floor filling no more than the bottom third. The camera height above the floor is absolutely constant and never changes: it does not sink, lower, descend, crouch, drop toward the ground, or drift downward while walking, and it never rises toward the ceiling. Walking changes position, never height. Never tilt the camera down toward the floor, never look at the ground, never angle up into the ceiling, and never roll the horizon.";

// Hands are the thing most likely to come out wrong — a world model will grow
// extra fingers or a second pair given the chance. Be relentlessly specific
// about the count and keep them low in the frame. Toggleable in settings so a
// bad run can be cut without a code change.
export const CAMERA_WITH_HANDS = `${CAMERA_BASE} The viewer's own two arms and hands are visible entering the frame from the bottom edge, exactly as a first-person video game shows the player's hands: exactly two hands, one left and one right, five fingers on each, natural adult human proportions and consistent skin tone, wearing plain dark long sleeves. The hands stay low in the lower third of the frame and sway gently with the walking rhythm. Never show a third hand, extra fingers, a floating or detached limb, or any part of the viewer's body above the forearms — no torso, no head, no legs, no reflection.`;

export const CAMERA_NO_HANDS = `${CAMERA_BASE} No body, hands, feet, avatar, or reflection of the viewer is ever visible.`;

export const WORLD: WorldContract = {
  camera: CAMERA_WITH_HANDS,
  environment:
    "The same modern open-plan office floor throughout: deep forest-green painted walls and columns, a black exposed ceiling of ducts and pipes on the left, trailing green ferns hanging from the ceiling line, tall black slatted timber screens enclosing soft seating booths with grey sofas and dark green cushions, a tan leather armchair and a woven rattan chair in the near foreground, warm oak flooring in the lounge, pale grey tiled flooring in the corridor, a long dark wood reception counter along the right wall, recessed ceiling downlights and linear LED strips, and a bright white-lit doorway at the far end of the corridor straight ahead.",
  invariants:
    "Never go outside and never show the outdoors except as white light through the far doorway. Never show any other person, figure, face, crowd, animal, or creature anywhere — the viewer's own hands are the only human part ever in frame, and no one else exists in this building. Never change the floor plan: the corridor, the seating booths, the reception counter, the columns, and the far doorway stay exactly where they are relative to each other. Solid surfaces block movement — the viewer never passes through walls, columns, glass, slatted screens, the reception counter, or furniture; when the viewer moves toward a solid surface the view stops advancing and that surface stays solid and intact in front of them, never dissolving or opening. There is ALWAYS a complete, solid, continuous floor beneath the viewer, running unbroken from the bottom edge of the frame to the base of every wall — grey tile in the corridor, warm oak in the lounge. The floor never disappears, never opens into a hole, pit, void, water, sky, or darkness, and never becomes transparent or missing; the bottom of the frame is always ground. Maintain strict spatial continuity: walls, doors, floor, and furniture never move or vanish between moments. This is one fixed, unchanging, permanent building with a single floor plan that the viewer walks around inside. Turning the head or walking away and coming back does not change anything: every wall, doorway, column, booth, chair, counter and light is exactly where it was and looks exactly as it did before. When the viewer returns to a place they have already been, it is identical to how they left it. Nothing is ever rebuilt, redecorated, rearranged, or replaced with a different room.",
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

export const BLOCKED_PROMPT =
  "The viewer has walked into a solid surface and cannot go further. The view stops advancing, the surface directly ahead stays solid and intact, and the camera settles as the viewer stops.";

// How fast the world reads as moving. The model has no speed parameter, so
// pace is carried by the prompt (and reinforced by camera-pose translation in
// the app). 1 is the old sluggish default; 3 is close to a jog.
export type Pace = 1 | 2 | 3 | 4;

// Each level describes the gait, because "walking" is the only speed control
// the model has. The human-movement cues — weight shifting, footfalls, a slight
// side-to-side roll — are what stop it feeling like a camera on rails.
export const PACE_PROMPTS: Record<Pace, string> = {
  1: "The viewer walks through the office floor at a calm, steady human pace, weight shifting naturally from foot to foot with a gentle, barely perceptible side-to-side sway at constant eye height.",
  2: "The viewer walks briskly and purposefully through the office floor, covering ground at a good speed. The gait is unmistakably human: a steady rhythm of footfalls, a slight natural bob and side-to-side roll with each step, arms swinging in time, eye height constant throughout.",
  3: "The viewer moves quickly through the office floor, covering ground fast with long purposeful strides. The walls, columns and booths sweep past at speed. The gait stays human — a firm rhythm of footfalls, a pronounced but natural bob and roll with each stride, arms pumping — and the eye height stays constant.",
  4: "The viewer is running, moving urgently and very fast down the corridor. The walls, columns and booths rush past. The motion is a human run: rapid footfalls, a strong rhythmic bob and roll with each stride, arms pumping hard, and the eye height stays constant at standing head height and never drops.",
};

const MOVING_TAIL =
  "The walls, booths, counter, floor, and doorway stay solid and consistent throughout, and the camera stays at the same constant height above an unbroken floor.";

export function movingPrompt(pace: Pace): string {
  return `${PACE_PROMPTS[pace]} ${MOVING_TAIL}`;
}

// Transient event prompts, appended for a couple of chunks then dropped.
// The searching pair are written around the hands, because that is the moment
// the player asked to actually feel like a body in the room.
export const EVENTS = {
  search:
    "The viewer's own two hands reach forward into the frame from the bottom edge and search the surface directly ahead: the fingers make visible contact, grip the edge of a drawer and slide it open, then push aside the clutter inside. The hands stay clearly in view throughout, exactly two hands with five fingers each, before withdrawing back down out of frame. The furniture itself stays exactly in place.",
  keyReveal:
    "In the opened drawer directly ahead, a single small tarnished brass key lies in plain view, faintly catching the light.",
  takeKey:
    "The viewer's own hand reaches down into the frame, the fingers close around the small brass key and lift it, holding it up briefly in clear view in the centre of the frame before lowering it out of shot. Exactly one hand with five fingers. The drawer and the room are unchanged.",
  escape:
    "The viewer's hand reaches forward into the frame and pushes the door at the bright far end of the corridor. It swings slowly open and blinding white daylight floods in, growing brighter and brighter until the whole corridor dissolves entirely into pure white light.",
} as const;

export function composeWorldPrompt(options: {
  loopNumber: number;
  moving: boolean;
  blocked: boolean;
  searchActive: boolean;
  keyVisible: boolean;
  takeActive: boolean;
  escaping: boolean;
  showHands: boolean;
  pace: Pace;
}): string {
  const variation = variationForLoop(options.loopNumber);

  // A transient event is the whole point of its chunk, so it leads. Buried
  // after four contract paragraphs the model simply ignored it.
  const lead: string[] = [];
  if (options.escaping) lead.push(EVENTS.escape);
  if (options.searchActive) lead.push(EVENTS.search);
  if (options.takeActive) lead.push(EVENTS.takeKey);

  const parts = lead.length ? [`HAPPENING RIGHT NOW: ${lead.join(" ")}`] : [];

  parts.push(
    `IMMUTABLE CAMERA CONTRACT: ${
      options.showHands ? CAMERA_WITH_HANDS : CAMERA_NO_HANDS
    }`,
    `IMMUTABLE ENVIRONMENT CONTRACT: ${WORLD.environment}`,
    `CURRENT ATMOSPHERE: ${variation.atmosphere}`,
    `NON-NEGOTIABLE CONTINUITY RULES: ${WORLD.invariants}`,
  );

  if (options.escaping) return parts.join(" ");

  if (options.blocked) {
    parts.push(BLOCKED_PROMPT);
  } else if (!options.searchActive && !options.takeActive) {
    // While searching, the hands are the action — do not also describe walking.
    parts.push(
      options.moving
        ? movingPrompt(options.pace)
        : `${STATIC_PROMPT} ${variation.ambient}`,
    );
  }
  if (options.keyVisible) parts.push(EVENTS.keyReveal);
  return parts.join(" ");
}
