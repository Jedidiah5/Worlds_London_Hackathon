# The two-minute demo

No stage, no slides. A judge walks up, you hand them the keyboard. Say this
while they play — do not narrate the architecture until they ask.

## Before they arrive

- Dev server running, browser at `localhost:3000`, **fullscreen**, title screen up.
- **Start the session before they walk over and leave it running.** Reactor
  regularly answers `429 no available capacity` during the hackathon; the app
  queues for a GPU automatically, but that can take a minute or two. Once
  connected, loop resets reuse the same session, so the risk is only at startup.
- **Click the scene once** to capture the mouse before handing it over, so their
  first mouse movement actually turns the camera.
- Debug panel **off** (`` ` `` toggles it).
- One rehearsal run done end to end.
- Know your escape hatch: if the session dies, `R` or **TRY AGAIN** restarts
  cleanly. Say "the building does that" and restart. Do not open dev tools in
  front of a judge.

## The script

**As you hand it over (~15s)**

The opening line is the whole pitch, because they are standing in the room:

> That's this building. You're looking at the floor you're standing on. It's a
> time loop — walk around, and every sixty seconds you wake up back here.
> There's a key somewhere. Try WASD, and move the mouse to look.

Let them walk. Say nothing for a few seconds — the first thing that has to land
is that the building responds to *them*, not to a script.

**Around 0:30 (~15s)**

> Nothing here is pre-rendered. There's no 3D model of this floor — every frame
> is being generated live from one photograph, right now, from wherever they
> point the camera.

**At the first reset, ~1:00 — this is the moment (~20s)**

Let the black wake-up card land. Then:

> Same building, same seed, same photo. But look at the light — that was nine in
> the morning, this is after hours. The plants have grown. It keeps going:
> the lights fail, and by the fourth loop the place is overgrown.

> That's the whole reason this is a world model and not a video model. A video
> model gives you a clip that's already decided. This is re-deriving the same
> building live, and letting it rot.

**Around 1:20 — the key (~15s)**

> Press E to search whatever's in front of you. You won't find it on the first
> loop, and the loop takes it back off you if you're too slow.

The hint line on screen always tells them the next verb, so you don't have to.
Once they hold the key, a brass banner says exactly how to finish.

If they find it: let them walk down the corridor and press `E`. The white-out
and end card are the payoff — shut up and let it play.

If they don't find it: hit `` ` `` → **grant key** → **escape now**, and say
"let me show you the ending." Better a shown ending than a hunted one.

**If they ask how it works (~20s)**

> The model owns the world — rendering, the rooms, the decay. My code owns the
> truth: loop number, the timer, whether you're holding the key. World models
> don't reliably track discrete objects, so I never ask it to remember where the
> key is. It renders; the state machine decides.

## If it breaks

- **"Every GPU is busy":** it is queueing, not broken. Say so — "Reactor's
  capacity is hammered today, it's waiting in line" — and keep talking. This is
  the single most likely failure, so have a sentence ready for it.
- **Session drops:** `R` or **TRY AGAIN**. "The building does that."
- **The camera tilts at the floor or the geometry melts:** that is *in theme*.
  Say "loop four gets strange" and keep going. Do not apologise for the model
  being weird — dread is the product.
- **Mouse look feels inverted:** gear icon → **Invert look Y**. Do it while
  talking; it applies immediately.
- **The world drifts somewhere that isn't the venue:** they walked fast for a
  while. The next reset re-anchors it. Either wait it out, or drop **Move
  speed** to `walk` in settings.
- **The hands come out wrong:** gear icon → **Show your hands** off. The camera
  goes back to bodiless and nothing else changes.
- **"That way is solid" fires when it shouldn't:** gear icon → turn off
  **Wall feedback**.
- **Total failure:** the title screen alone is a legible artefact. Talk them
  through the architecture with the README open. Criterion 3 is "does it run" —
  a calm recovery reads far better than a panic.

## Judging criteria, in their order

1. **Use of world models** — lead with this. The loop *is* the capability.
2. **Ambition** — a persistent, decaying, explorable house in one day, solo.
3. **Execution** — it is running in front of them. Protect this above all else.
4. **Craft** — the HUD, the wake cards, the ending. Let them speak for themselves.

## Don't forget

- **Submission form closes 17:30 — hard.** Budget 15 minutes, start at 17:10.
- Category: **Narrative**. One category, locked at submission.
- If an avatar ends up in the build, ask an organiser whether a Narrative entry
  can also be considered for the Veed prize.
