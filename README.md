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
| **Mouse** | Look — click the scene to capture the pointer, `Esc` releases it |
| Arrow keys | Look, if you'd rather not capture the mouse |
| `E` | Search here / take the key / open the exit |
| Gear icon (top centre) | Settings — loop length, sensitivity, hints, difficulty |
| `` ` `` | Debug panel (state readout + force reset, grant key, escape now) |
| `R` | Restart, on the end and error screens |

## Reactor capacity — read this before demoing

Reactor returns `429 no available capacity` when every GPU is busy, and during
the hackathon that happens often. The app treats it as a queue, not a failure:
it retries every 3s up to 40 times and shows *"Every GPU is busy. Queueing for
one…"* on the boot screen. If it still can't get a slot, the error screen says
so in plain language with a **TRY AGAIN** button.

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
- `hooks/useMouseLook.ts` — pointer lock and mouse-to-camera-delta conversion.
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

### Mouse look

Pointer lock captures the mouse; movement accumulates and is drained once per
model chunk into `set_camera_pose` as per-latent `[rx, ry, rz, tx, ty, tz]`
deltas. Sensitivity and invert-Y are in settings, as is turn speed
(`set_rotation_speed_deg`). If the pitch axis feels backwards on the day, flip
**Invert look Y** in settings rather than editing code.

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
