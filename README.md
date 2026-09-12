# THE LOOP HOUSE

A world-model time loop. You wake in a bed in a small terraced house. You can
walk through it. After 60 seconds you wake up in that bed again — and the house
has got worse. There is a key somewhere. Find it and you get out.

Built on [`reactor/lingbot-world-2`](https://docs.reactor.inc/model-api-reference/lingbot-world-2/overview).
Every frame is generated live in response to the player's input. Nothing is
pre-rendered, and there are no 3D assets — the only fixed art in the whole
project is one still image used to anchor the model's idea of the house.

## Why this needs a world model

A time loop is the one story structure that *requires* persistence. The beat is
"I have been here before," which only lands if it is recognisably the same house
each loop — and recognisably worse. That is exactly what a world model gives you
and a video model cannot: the house is re-derived live from the same anchor and
seed, then steered somewhere new by the atmosphere prompt.

Ask the test the judges will ask — *could this have been pre-rendered?* No: the
route through the house is chosen by whoever is holding the keyboard.

## Run it

Needs Node 20.9+ and a Reactor API key from
[reactor.inc/account/api-keys](https://reactor.inc/account/api-keys)
(hackathon credits code: `WORLDS.LONDON`).

```bash
npm install
cp .env.example .env.local     # then put your rk_... key in it
npm run dev
```

### The anchor frame — do this before demoing

The model takes its visual identity from a single image at
`public/anchors/bedroom.png`. **The app will not start without one.** Three ways
to get it, in order of preference:

1. `RUNWARE_API_KEY=... npm run anchor` — generates one via Runware
   (hackathon code `WMHACK26`). Re-run until a frame looks right; this is the
   single highest-leverage thing to iterate on.
2. Drop any 16:9 photo of a bedroom at that path.
3. Use the **choose image** picker on the title screen for a one-off.

A good anchor is first-person, at standing height, with an open doorway visible
so there is somewhere to walk. Avoid anything with a person, hands, or a mirror
in frame — the model will happily keep them.

## Controls

| Input | Does |
| --- | --- |
| `W` `A` `S` `D` | Walk and strafe |
| **Mouse** | Look — click the scene to capture the pointer, `Esc` releases it. If pointer lock is refused, click-and-drag still turns you |
| Arrow keys | Look, if you'd rather not capture the mouse |
| `E` | Search here / take the key / open the exit |
| Gear icon (top centre) | Settings — loop length, sensitivity, hints, difficulty, touch, tilt |
| `` ` `` | Debug panel (state readout + force reset, grant key, escape now) |
| `R` | Restart, on the end and error screens |

### On a phone

On-screen controls appear automatically on any coarse-pointer device (override
with **On-screen controls** in settings):

| Input | Does |
| --- | --- |
| Left thumbstick | Walk and strafe |
| Drag anywhere | Look |
| Big brass button | SEARCH / TAKE / OPEN, matching what you can do right now |
| **TILT** button | Tilt the phone left or right to steer |

Tilt uses `deviceorientation` gamma with a 6° deadzone. iOS requires a
permission prompt, which is why it is behind a button rather than on by default.

## Reactor capacity — read this before demoing

Reactor throws `429` for two different reasons and the app handles them apart:

- **`no available capacity`** — every GPU is busy. It queues, retrying every 3s
  up to 40 times, showing *"Every GPU is busy. Queueing for one…"*.
- **`quota_exceeded / sessions_per_minute`** — **you only get 10 new sessions a
  minute on this model.** The response carries `retry_after_seconds`, which the
  app now honours rather than hammering (retrying too eagerly just keeps the
  quota pinned). The boot screen counts the wait down.

That per-minute cap is the one to remember: restarting repeatedly while
rehearsing will hit it, and it looks like a mystery failure if you don't know.
The error screen names it explicitly.

Practically: **start the session a minute or two before a judge arrives** and
leave it running. Once connected, the loop resets reuse the same session, so
capacity is only a risk at the initial connect.

## Architecture

The split is the whole point, and it is what makes this demoable rather than
hopeful:

- **The model owns the world.** Rendering the house, the rooms, the light, the
  decay, the response to movement.
- **`lib/state.ts` owns the truth.** Loop number, seconds remaining, how many
  times you have searched, `keyVisible`, `hasKey`. The model is never asked to
  remember that the key is in a drawer, because it would not.

Each loop, `lib/house.ts` composes a prompt from four layers — an immutable
camera contract, an immutable environment contract, the atmosphere for *this*
loop, and the continuity rules — plus whatever transient event is in flight.
On reset the app calls `reset()`, re-uploads the same anchor, re-applies the
same seed, and sends the next loop's atmosphere. Same house, worse.

Loop-to-loop variation lives in `VARIATIONS` in `lib/house.ts`:
morning → dusk → night → rot. It stays on the final variation after loop 4; the
house does not heal.

Files worth knowing:

- `lib/world.ts` — all prompt content: the camera/environment contracts, the
  four loop variations, and the event prompts. Tune the story here.
- `lib/state.ts` — the state machine and the key rules.
- `lib/settings.ts` — the live-tunable knobs behind the gear icon.
- `lib/hints.ts` — the hint ladder and the objective line.
- `lib/frames.ts` — the collision approximation (see below).
- `hooks/useLookInput.ts` — mouse, drag, touch and tilt look input.
- `components/TouchControls.tsx` — the on-screen thumbstick and action button.
- `components/LoopHouse.tsx` — session lifecycle, input, prompt scheduling, HUD.
- `app/api/reactor/token/route.ts` — mints a short-lived scoped JWT. The API key
  stays on the server; the browser never sees it.

### The anchor is the venue

`public/anchors/bedroom.png` is a photo of the hackathon venue, and
`lib/world.ts` describes that exact space — green walls, hanging ferns, black
slatted booths, the reception counter, and the lit doorway at the end of the
corridor. A judge is standing *in* the room they are looking at, which is the
strongest version of the hook.

**The contract and the anchor must always agree.** If you swap the anchor for a
different photo, rewrite `WORLD` in `lib/world.ts` to describe the new image, or
the model gets contradictory conditioning and the output falls apart.

### Looking around

Look is a **continuous turn state**, not a per-chunk camera pose. An earlier
version posted one `set_camera_pose` per model chunk, which meant moving the
mouse did nothing for a second and then lurched — it felt broken. Instead,
`hooks/useLookInput.ts` accumulates pointer deltas (pointer-locked mouse, mouse
drag, touch drag) plus absolute device tilt, and a 100ms tick in
`components/LoopHouse.tsx` resolves them into `set_look_horizontal` /
`set_look_vertical`, scaling `set_rotation_speed_deg` by how hard you moved.
The model turns steadily in that direction until you stop, which is what the
chunked generation is actually good at.

Arrow keys override the pointer; the pointer overrides tilt. Sensitivity,
invert-Y and base turn speed are all in settings — if pitch feels backwards on
the day, flip **Invert look Y** rather than editing code.

### Session tokens — a trap worth knowing about

A Reactor session-scoped JWT is **bound to the session it opened**. That cuts
both ways, and both halves bite:

- Hand out a *different* token mid-session and the SDK's upload-slot and
  session-poll calls fail with `403 this token is session-scoped and is not
  authorized for this resource`.
- Reuse an *old* token against a newly created session and you get the same 403.

So the token is cached in module scope in `components/LoopHouse.tsx` and
explicitly invalidated with `invalidateToken()` immediately before each
`connect()`. The route sends `Cache-Control: private, no-store` so the browser
never second-guesses that. One token per session, a new token per session.

### Sound

Everything is synthesised in the browser in `lib/audio.ts` — there are no audio
files to license, load, or 404 on Vercel, and the whole bed follows the decay
arc by moving a few numbers:

- **Room tone** is brown noise through a lowpass plus two detuned oscillators.
  Each loop variation darkens the filter, drops the drone, and widens the
  detune, so by the overgrown loop the building is humming against itself.
- **Footsteps** are a bandpassed noise burst (heel) plus a pitched-down sine
  (weight), alternating heavier and lighter so it reads as left/right. The step
  interval follows the pace setting, and they stop the instant you hit a wall.
- **Events** have their own voices: a filtered sweep for the drawer, a metallic
  three-partial chime for the key, a filter-collapsing swell for the loop reset,
  and a rising wash that ducks the building for the escape.

An `AudioContext` cannot start without a user gesture, so it is created inside
the WAKE UP click. Sound and volume are both in settings.

### Walking like a person

Two problems the first version had: the camera sank toward the floor while
moving, and the walk felt like a dolly. Both are fixed through the camera pose,
where **the translation axis is y-down** (a negative `ty` lifts):

- `EYE_LIFT` is a constant upward nudge that cancels the sink.
- A sine across the chunk's latents gives the gait an actual bob, with a little
  roll on the same phase so it sways as well as bounces. Amplitude scales with
  pace. Turn it off with **Head bob** in settings.

The prompt carries the rest — each pace level describes footfalls, weight
shifting and arm swing, because "walking" is the only speed control the model
has. The camera contract now also states that height is constant and that
walking changes position, never height.

### The floor

The model would occasionally drop the ground out of the world entirely. The
continuity rules now spell out that there is *always* a complete, solid,
continuous floor running unbroken to the base of every wall, that it never opens
into a hole, void, water or darkness, and that the bottom of the frame is always
ground.

### Movement speed, and what it costs

LingBot has no speed parameter — `set_move_longitudinal` is just a direction. So
pace is carried two ways: the prompt wording (`PACE_PROMPTS` in `lib/world.ts`,
walk / brisk / fast) and a small per-latent forward translation on the camera
pose (`MOVE_PUSH_PER_STEP`). Pushing the thumbstick to its edge bumps one pace
step above the setting, so mobile has a way to hurry.

**The trade-off is real and worth knowing before you demo.** The faster the
viewer moves, the faster the world drifts away from the anchor frame — walk hard
for ten seconds and the venue can dissolve into somewhere else entirely. The
60-second loop is the natural cure, because every reset re-anchors from the same
photo. If a judge is wandering fast and it starts looking wrong, that is a
feature you can name out loud ("loop four gets strange") or you can drop
**Move speed** to `walk` in settings.

### Your hands

`showHands` puts the player's own arms in frame, and the search and take-key
events are written around them — the hands reach in, open the drawer, and lift
the key. Two things make this work:

1. The camera contract is obsessive about the count ("exactly two hands, five
   fingers each, never a third hand or a detached limb"), because that is what
   a world model gets wrong.
2. Event prompts **lead** the composed prompt under `HAPPENING RIGHT NOW:`.
   Buried after four contract paragraphs, the model ignored them entirely and no
   hands ever appeared.

If the anatomy goes wrong on the day, **Show your hands** in settings turns it
off and restores the old bodiless camera without a code change.

### Walls

A world model has no collision system, so this is approximated two ways, and
both are honest about what they are:

1. **Prompt-side.** The continuity rules tell the model that solid surfaces
   block movement and never dissolve or open.
2. **Frame-side.** `lib/frames.ts` samples the video at ~4Hz and measures how
   much the picture is changing. If the player holds forward and the frame stops
   changing, they have walked into something: the app stops pushing forward,
   flashes **THAT WAY IS SOLID**, and switches the prompt to the blocked line.

The threshold is `STALL_THRESHOLD` in `lib/frames.ts`. Turn the whole behaviour
off with **Wall feedback** in settings if it misfires on the day.

### Things that are deliberately simple

- **No position tracking.** Pressing `E` with the key opens the front door
  wherever you are. The model has no reliable notion of which room you are in,
  and inventing one from frame analysis would be the fragile part of the demo.
  In practice the player walks down the hallway and presses `E`, and it reads
  correctly. If you want a gate, require a few seconds of forward movement after
  taking the key in `interact()`.
- **The key is gated on loop 2+.** The first loop is for establishing the house,
  so the reset lands before anything else happens. After the loop takes the key
  back once, the next search re-finds it — the house is cruel, not tedious.
- **Failure is atmospheric.** If the session drops or a command errors mid-demo,
  the app freezes on the last frame with "The house holds its breath" and an
  `R` to restart, rather than a stack trace.

## Tuning for the demo

In `lib/state.ts`:

- `LOOP_SECONDS = 60` — a judge gets two resets in a two-minute visit. Drop to
  45 if they are moving fast; do not go above 90.
- `KEY_MIN_LOOP = 2`, `KEY_SEARCH_INDEX = 2` — how long the key stays hidden.
- `ESCAPE_SECONDS = 7` — the white-out before the end card.

## Verify

```bash
npm run typecheck && npm run build
```

Neither starts a paid model session. Live behaviour has to be checked by hand.

**Stop `next dev` before running these.** `tsconfig.json` includes Next's
generated `.next/dev/types`, and a running dev server rewrites those files
mid-check — you get `TS1109: Expression expected` in `validator.ts`, which is a
torn write, not a real error. Kill the dev server (or `rm -rf .next`) and re-run.
