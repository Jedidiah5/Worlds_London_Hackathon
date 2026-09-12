"use client";

import {
  LingbotWorld2MainVideoView,
  LingbotWorld2Provider,
  useLingbotWorld2,
  useLingbotWorld2Message,
} from "@reactor-models/lingbot-world-2";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SettingsPanel } from "@/components/SettingsPanel";
import { useLookInput } from "@/hooks/useLookInput";
import { TouchControls, type MoveVector } from "@/components/TouchControls";
import {
  createFrameSampler,
  STALL_SAMPLES,
  STALL_THRESHOLD,
} from "@/lib/frames";
import { createAudioEngine, type EngineHandle } from "@/lib/audio";
import { currentHint, wakeHint } from "@/lib/hints";
import {
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  type Settings,
} from "@/lib/settings";
import {
  ANCHOR_URL,
  SEED,
  composeWorldPrompt,
  variationForLoop,
} from "@/lib/world";
import {
  ESCAPE_SECONDS,
  EVENT_CHUNKS,
  formatClock,
  initialState,
  searchRevealsKey,
  type GameState,
} from "@/lib/state";

const API_URL =
  process.env.NEXT_PUBLIC_COORDINATOR_URL ?? "https://api.reactor.inc";
const CHUNK_LATENTS = 3;
// Forward translation added per pace step above 1. The prompt does most of the
// work; this is the part you feel. Raising it also drifts off the anchor faster.
const MOVE_PUSH_PER_STEP = 0.055;
// Constant upward nudge (y is down) that cancels the model's tendency to sink
// toward the floor while walking.
const EYE_LIFT = 0.014;
// Gait bob amplitude and how fast the phase advances per latent frame.
const BOB_BASE = 0.006;
const BOB_PER_PACE = 0.0035;
const BOB_STEP = 0.9;

type MoveLong = "idle" | "forward" | "back";
type MoveLat = "idle" | "strafe_left" | "strafe_right";
type LookH = "idle" | "left" | "right";
type LookV = "idle" | "up" | "down";

// One token for the whole page load.
//
// A Reactor token is authorized for the sessions IT created. The SDK will also
// happily adopt a pre-existing live session ("Adopted session (not the
// creator)") — and uploads against a session this token did not create fail
// with "403 this token is session-scoped and is not authorized for this
// resource". So the rule is: keep one stable token, and when that 403 does
// appear, throw the session away and reconnect with a brand new token that
// will own what it creates.
let cachedToken: { jwt: string; expiresAtMs: number } | null = null;
let inflightToken: Promise<string> | null = null;
const TOKEN_SKEW_MS = 60_000;

function invalidateToken() {
  cachedToken = null;
}

async function fetchToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAtMs - TOKEN_SKEW_MS) {
    return cachedToken.jwt;
  }
  if (inflightToken) return inflightToken;
  inflightToken = (async () => {
    try {
      const response = await fetch("/api/reactor/token", { cache: "no-store" });
      const body = (await response.json().catch(() => ({}))) as {
        jwt?: string;
        expires_at?: number;
        error?: string;
      };
      if (!response.ok || !body.jwt) {
        throw new Error(
          body.error ?? `Token request failed (${response.status})`,
        );
      }
      cachedToken = {
        jwt: body.jwt,
        expiresAtMs: (body.expires_at ?? Math.floor(Date.now() / 1000) + 3600) * 1000,
      };
      return body.jwt;
    } finally {
      inflightToken = null;
    }
  })();
  return inflightToken;
}

function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  timeoutMessage: string,
) {
  return new Promise<void>((resolve, reject) => {
    const started = Date.now();
    const timer = window.setInterval(() => {
      if (predicate()) {
        window.clearInterval(timer);
        resolve();
      } else if (Date.now() - started > timeoutMs) {
        window.clearInterval(timer);
        reject(new Error(timeoutMessage));
      }
    }, 120);
  });
}

// Like waitFor, but also rejects as soon as a failure condition becomes true,
// so a dropped transport surfaces immediately instead of after the timeout.
function waitForOrFail(
  succeeded: () => boolean,
  failed: () => boolean,
  timeoutMs: number,
  timeoutMessage: string,
  failureMessage: string,
) {
  return new Promise<void>((resolve, reject) => {
    const started = Date.now();
    const timer = window.setInterval(() => {
      if (succeeded()) {
        window.clearInterval(timer);
        resolve();
      } else if (failed()) {
        window.clearInterval(timer);
        reject(new Error(failureMessage));
      } else if (Date.now() - started > timeoutMs) {
        window.clearInterval(timer);
        reject(new Error(timeoutMessage));
      }
    }, 120);
  });
}

function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

// Reactor answers 429 "no available capacity" when every GPU is busy. At a
// hackathon that is normal, not broken — so queue politely instead of dying.
const CAPACITY_ATTEMPTS = 40;
const CAPACITY_RETRY_MS = 3000;

function isCapacityError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("429") ||
    message.toLowerCase().includes("no available capacity") ||
    message.toLowerCase().includes("no available servers") ||
    message.toLowerCase().includes("quota_exceeded")
  );
}

// Reactor rejects with 429 for two different reasons and they want different
// handling: "no available capacity" means every GPU is busy and we just wait,
// while "quota_exceeded / sessions_per_minute" is a rate limit that tells us
// exactly how long to back off. Retrying the rate limit too eagerly keeps the
// quota pinned, so honour retry_after_seconds when it is offered.
function parseRetryAfterMs(error: unknown): number | null {
  const message = error instanceof Error ? error.message : String(error);
  // [\s\S] instead of the /s flag, which needs an ES2018 target.
  const match = message.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const payload = JSON.parse(match[0]) as {
      retry_after_seconds?: number;
      quota_type?: string;
    };
    if (typeof payload.retry_after_seconds === "number") {
      // Pad it: the server's own clock and ours will not agree exactly.
      return Math.ceil(payload.retry_after_seconds * 1000) + 1200;
    }
  } catch {
    // Not JSON; fall back to the fixed interval.
  }
  return null;
}

function isRateLimit(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("quota_exceeded") || message.includes("sessions_per_minute");
}

// The WebRTC transport to the GPU can drop while a session is coming up —
// venue wifi, a flaky GPU, a session that never finishes handshaking. Worth
// retrying the whole boot rather than showing a judge an error.
const TRANSPORT_ATTEMPTS = 3;

// The session-binding 403. Recoverable, but only by dropping the session and
// reconnecting with a fresh token — retrying the upload alone never works.
function isSessionBindingError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("403") && message.includes("session-scoped")
  );
}

function isTransientError(error: unknown): boolean {
  if (isCapacityError(error) || isSessionBindingError(error)) return true;
  const message = (
    error instanceof Error ? error.message : String(error)
  ).toLowerCase();
  return (
    message.includes("transport") ||
    message.includes("connection") ||
    message.includes("dropped") ||
    message.includes("did not become ready")
  );
}

function LoopHouseGame({ configured }: { configured: boolean }) {
  const lw2 = useLingbotWorld2();
  const { status, uploadFile } = lw2;

  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [game, setGame] = useState<GameState>(() =>
    initialState(DEFAULT_SETTINGS.loopSeconds),
  );
  const [bootMessage, setBootMessage] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [anchorState, setAnchorState] = useState<
    "checking" | "found" | "custom" | "missing"
  >("checking");
  const [chunkIndex, setChunkIndex] = useState(0);
  const [promptNote, setPromptNote] = useState("");
  const [blocked, setBlocked] = useState(false);
  const [motionDelta, setMotionDelta] = useState(0);
  const [lookDebug, setLookDebug] = useState({
    h: "idle",
    v: "idle",
    speed: "0",
    dx: "0",
  });

  const stageRef = useRef<HTMLElement>(null);
  const gameRef = useRef<GameState>(game);
  gameRef.current = game;
  const settingsRef = useRef<Settings>(settings);
  settingsRef.current = settings;
  const statusRef = useRef(status);
  statusRef.current = status;

  const anchorBlobRef = useRef<Blob | null>(null);
  const imageReadyRef = useRef<(() => void) | null>(null);
  const launchPendingRef = useRef(false);
  const resetPendingRef = useRef(false);

  // Movement input state.
  const moveLongStackRef = useRef<Exclude<MoveLong, "idle">[]>([]);
  const moveLatStackRef = useRef<Exclude<MoveLat, "idle">[]>([]);
  const lookHStackRef = useRef<Exclude<LookH, "idle">[]>([]);
  const lookVStackRef = useRef<Exclude<LookV, "idle">[]>([]);
  const lastMoveLongRef = useRef<MoveLong>("idle");
  const lastMoveLatRef = useRef<MoveLat>("idle");
  const lastLookHRef = useRef<LookH>("idle");
  const lastLookVRef = useRef<LookV>("idle");
  const movingRef = useRef(false);
  const blockedRef = useRef(false);

  // Transient event state (prompt-side).
  const searchChunksRef = useRef(0);
  const takeChunksRef = useRef(0);
  const pendingRevealRef = useRef(false);
  const escapingRef = useRef(false);

  // Prompt scheduling (one prompt slot per chunk, mirroring the cookbook).
  const lastPromptRef = useRef("");
  const promptQueuedRef = useRef<string | null>(null);
  const promptInFlightRef = useRef(false);
  const attnRef = useRef<"small" | "large">("small");
  const lastRotationSpeedRef = useRef(-1);
  const effectivePaceRef = useRef<1 | 2 | 3 | 4>(DEFAULT_SETTINGS.moveSpeed);
  const movePoseActiveRef = useRef(false);
  const bobPhaseRef = useRef(0);

  const samplerRef = useRef<ReturnType<typeof createFrameSampler> | null>(null);
  const stallCountRef = useRef(0);

  // Audio. The context can only be created from a user gesture, so it is
  // started on the WAKE UP click rather than on mount.
  const audioRef = useRef<EngineHandle | null>(null);
  const getAudio = useCallback(() => {
    if (!audioRef.current) audioRef.current = createAudioEngine();
    return audioRef.current;
  }, []);
  useEffect(() => () => audioRef.current?.stop(), []);

  const playing = game.phase === "loop";
  const look = useLookInput({
    enabled: playing,
    invertY: settings.invertY,
    tiltEnabled: settings.tiltEnabled,
    tiltSensitivity: settings.tiltSensitivity,
  });

  // Movement coming from the on-screen thumbstick, independent of the keyboard.
  const touchMoveRef = useRef<MoveVector>({ x: 0, y: 0 });
  const [coarsePointer, setCoarsePointer] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const query = window.matchMedia("(pointer: coarse)");
    const update = () => setCoarsePointer(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  // Stable handle so callbacks can reach the look input without re-binding.
  const lookRef = useRef(look);
  lookRef.current = look;

  useEffect(() => {
    const stored = loadSettings();
    setSettings(stored);
    settingsRef.current = stored;
    setGame((current) =>
      current.phase === "title"
        ? { ...current, secondsLeft: stored.loopSeconds }
        : current,
    );
  }, []);

  const updateSettings = useCallback((patch: Partial<Settings>) => {
    setSettings((current) => {
      const next = { ...current, ...patch };
      settingsRef.current = next;
      saveSettings(next);
      return next;
    });
  }, []);

  const resetSettings = useCallback(() => {
    settingsRef.current = DEFAULT_SETTINGS;
    saveSettings(DEFAULT_SETTINGS);
    setSettings(DEFAULT_SETTINGS);
  }, []);

  const updateGame = useCallback((patch: Partial<GameState>) => {
    setGame((current) => {
      const next = { ...current, ...patch };
      gameRef.current = next;
      return next;
    });
  }, []);

  const composeCurrentPrompt = useCallback(() => {
    const state = gameRef.current;
    return composeWorldPrompt({
      loopNumber: state.loopNumber,
      moving: movingRef.current,
      blocked: blockedRef.current,
      searchActive: searchChunksRef.current > 0,
      keyVisible: state.keyVisible,
      takeActive: takeChunksRef.current > 0,
      escaping: escapingRef.current,
      showHands: settingsRef.current.showHands,
      pace: effectivePaceRef.current,
    });
  }, []);

  const dispatchPrompt = useCallback(
    (force = false) => {
      if (statusRef.current !== "ready") return;
      const next = promptQueuedRef.current ?? composeCurrentPrompt();
      if (!force && next === lastPromptRef.current) {
        promptQueuedRef.current = null;
        return;
      }
      if (!force && promptInFlightRef.current) {
        promptQueuedRef.current = next;
        return;
      }
      promptQueuedRef.current = null;
      promptInFlightRef.current = true;
      lastPromptRef.current = next;
      setPromptNote("sending");
      lw2
        .setPrompt({ prompt: next })
        .then(() => setPromptNote("accepted"))
        .catch(() => {
          promptQueuedRef.current = next;
          setPromptNote("queued");
        })
        .finally(() => {
          promptInFlightRef.current = false;
        });
    },
    [composeCurrentPrompt, lw2],
  );

  const queuePrompt = useCallback(
    (priority = false) => {
      promptQueuedRef.current = composeCurrentPrompt();
      setPromptNote("queued");
      if (priority) dispatchPrompt();
    },
    [composeCurrentPrompt, dispatchPrompt],
  );

  const setAttention = useCallback(
    (next: "small" | "large") => {
      if (attnRef.current === next) return;
      attnRef.current = next;
      if (statusRef.current === "ready") {
        lw2.setAttnWindow({ attn_window: next }).catch(() => undefined);
      }
    },
    [lw2],
  );

  // Look is a continuous turn state, not a per-chunk pose.
  //
  // The first version posted one set_camera_pose per chunk, which meant moving
  // the mouse did nothing for a second and then lurched. set_look_horizontal is
  // a persistent direction the model turns at steadily, so driving that on a
  // fast tick — and scaling set_rotation_speed_deg by how hard you moved —
  // feels like a camera instead of a slideshow.
  const applyLook = useCallback(
    (lookH: LookH, lookV: LookV, speedDeg: number) => {
      if (statusRef.current !== "ready") return;
      if (lookH !== lastLookHRef.current) {
        lastLookHRef.current = lookH;
        lw2.setLookHorizontal({ look_horizontal: lookH }).catch(() => undefined);
      }
      if (lookV !== lastLookVRef.current) {
        lastLookVRef.current = lookV;
        lw2.setLookVertical({ look_vertical: lookV }).catch(() => undefined);
      }
      const rounded = Math.round(speedDeg * 2) / 2;
      if (rounded !== lastRotationSpeedRef.current) {
        lastRotationSpeedRef.current = rounded;
        lw2
          .setRotationSpeedDeg({ rotation_speed_deg: rounded })
          .catch(() => undefined);
      }
      if (settingsRef.current.showDebug) {
        setLookDebug((prev) => ({
          ...prev,
          h: lookH,
          v: lookV,
          speed: String(rounded),
        }));
      }
    },
    [lw2],
  );

  // Movement speed boost.
  //
  // LingBot has no speed parameter — set_move_longitudinal is just a direction.
  // Pace is carried mainly by the prompt wording, and reinforced here with a
  // small per-latent forward translation on the camera pose. At pace 1 no pose
  // is sent at all, so this can always be dialled back out.
  const sendMovePose = useCallback(() => {
    if (statusRef.current !== "ready" || gameRef.current.phase !== "loop") return;
    const pace = effectivePaceRef.current;
    const forward = lastMoveLongRef.current;
    const moving = forward !== "idle" && !blockedRef.current;
    const push = (pace - 1) * MOVE_PUSH_PER_STEP;
    const bob = settingsRef.current.headBob;

    if (!moving) {
      if (movePoseActiveRef.current) {
        lw2.setCameraPose({ camera_pose: [] }).catch(() => undefined);
        movePoseActiveRef.current = false;
      }
      return;
    }

    // [rx, ry, rz, tx, ty, tz]. LingBot's translation axis is y-DOWN, so a
    // negative ty lifts the camera.
    //
    // Two jobs here. EYE_LIFT is a constant nudge upward that cancels the
    // model's habit of sinking toward the floor while walking — the "height
    // reduces when moving" problem. On top of that, a sine across the chunk's
    // latents gives the gait an actual bob, which is most of what makes the
    // walk read as a person rather than a dolly.
    const tz = forward === "forward" ? push : -push;
    const bobAmount = bob ? BOB_BASE + pace * BOB_PER_PACE : 0;
    const pose: number[] = [];
    for (let i = 0; i < CHUNK_LATENTS; i += 1) {
      bobPhaseRef.current += BOB_STEP * (0.7 + pace * 0.18);
      const ty = -EYE_LIFT + Math.sin(bobPhaseRef.current) * bobAmount;
      // A touch of roll on the same phase, offset, so it sways as well as bobs.
      const rz = bob ? Math.cos(bobPhaseRef.current) * bobAmount * 0.25 : 0;
      pose.push(0, 0, rz, 0, ty, tz);
    }
    lw2.setCameraPose({ camera_pose: pose }).catch(() => undefined);
    movePoseActiveRef.current = true;
  }, [lw2]);
  const sendMovePoseRef = useRef(sendMovePose);
  sendMovePoseRef.current = sendMovePose;

  const clearBlocked = useCallback(() => {
    if (!blockedRef.current) return;
    blockedRef.current = false;
    stallCountRef.current = 0;
    setBlocked(false);
  }, []);

  const sendMovementCommands = useCallback(() => {
    if (statusRef.current !== "ready") return;
    // The thumbstick wins while it is being held; otherwise the keyboard.
    const stick = touchMoveRef.current;
    // Low deadzone so the stick bites early — it felt sluggish at 0.34.
    const STICK_DEADZONE = 0.2;
    const stickLong: MoveLong =
      stick.y > STICK_DEADZONE
        ? "forward"
        : stick.y < -STICK_DEADZONE
          ? "back"
          : "idle";
    const stickLat: MoveLat =
      stick.x > STICK_DEADZONE
        ? "strafe_right"
        : stick.x < -STICK_DEADZONE
          ? "strafe_left"
          : "idle";
    const moveLong: MoveLong =
      stickLong !== "idle"
        ? stickLong
        : (moveLongStackRef.current.at(-1) ?? "idle");
    const moveLat: MoveLat =
      stickLat !== "idle" ? stickLat : (moveLatStackRef.current.at(-1) ?? "idle");
    let changed = false;
    if (moveLong !== lastMoveLongRef.current) {
      lastMoveLongRef.current = moveLong;
      changed = true;
      lw2
        .setMoveLongitudinal({ move_longitudinal: moveLong })
        .catch(() => undefined);
    }
    if (moveLat !== lastMoveLatRef.current) {
      lastMoveLatRef.current = moveLat;
      changed = true;
      lw2.setMoveLateral({ move_lateral: moveLat }).catch(() => undefined);
    }
    // Pushing the stick to its edge is an explicit "go faster" — bump a pace
    // step above the setting so mobile has a way to hurry.
    const stickMagnitude = Math.hypot(stick.x, stick.y);
    const basePace = settingsRef.current.moveSpeed;
    const nextPace = (
      stickMagnitude > 0.85 ? Math.min(4, basePace + 1) : basePace
    ) as 1 | 2 | 3 | 4;
    if (nextPace !== effectivePaceRef.current) {
      effectivePaceRef.current = nextPace;
      changed = true;
    }

    const moving = moveLong !== "idle" || moveLat !== "idle";
    if (moving !== movingRef.current) {
      movingRef.current = moving;
      changed = true;
      sendMovePoseRef.current();
    }
    // Footsteps follow the real movement state, so they stop dead on a wall.
    if (settingsRef.current.soundEnabled) {
      audioRef.current?.setWalking(moving && !blockedRef.current, nextPace);
    }
    setAttention(
      moving || searchChunksRef.current > 0 || takeChunksRef.current > 0
        ? "large"
        : "small",
    );
    if (changed) {
      samplerRef.current?.reset();
      stallCountRef.current = 0;
      queuePrompt(true);
    }
  }, [lw2, queuePrompt, setAttention]);

  const stopMovement = useCallback(() => {
    moveLongStackRef.current = [];
    moveLatStackRef.current = [];
    lookHStackRef.current = [];
    lookVStackRef.current = [];
    movingRef.current = false;
    clearBlocked();
    audioRef.current?.setWalking(false);
    if (statusRef.current !== "ready") return;
    lastMoveLongRef.current = "idle";
    lastMoveLatRef.current = "idle";
    lastLookHRef.current = "idle";
    lastLookVRef.current = "idle";
    lw2.setMoveLongitudinal({ move_longitudinal: "idle" }).catch(() => undefined);
    lw2.setMoveLateral({ move_lateral: "idle" }).catch(() => undefined);
    lw2.setLookHorizontal({ look_horizontal: "idle" }).catch(() => undefined);
    lw2.setLookVertical({ look_vertical: "idle" }).catch(() => undefined);
    touchMoveRef.current = { x: 0, y: 0 };
    lookRef.current.reset();
    if (movePoseActiveRef.current) {
      lw2.setCameraPose({ camera_pose: [] }).catch(() => undefined);
      movePoseActiveRef.current = false;
    }
  }, [clearBlocked, lw2]);

  // Upload the anchor, condition the model for the given loop, and start.
  const stageAndStart = useCallback(
    async (loopNumber: number) => {
      const blob = anchorBlobRef.current;
      if (!blob) throw new Error("The anchor frame is missing.");
      setBootMessage("Anchoring the floor…");
      const file = new File([blob], "loop-house-anchor.png", {
        type: blob.type || "image/png",
      });
      const imageReady = new Promise<void>((resolve) => {
        imageReadyRef.current = resolve;
      });
      const fileRef = await uploadFile(file);
      await lw2.setImage({ image: fileRef });
      await Promise.race([
        imageReady,
        waitFor(
          () => imageReadyRef.current === null,
          60_000,
          "The anchor frame was not accepted in time.",
        ),
      ]);
      setBootMessage("Conditioning the loop…");
      await lw2.setSeed({ seed: SEED });
      await lw2.setAttnWindow({ attn_window: "small" });
      attnRef.current = "small";
      escapingRef.current = false;
      searchChunksRef.current = 0;
      takeChunksRef.current = 0;
      pendingRevealRef.current = false;
      blockedRef.current = false;
      stallCountRef.current = 0;
      samplerRef.current?.reset();
      setBlocked(false);
      const prompt = composeWorldPrompt({
        loopNumber,
        moving: false,
        blocked: false,
        searchActive: false,
        keyVisible: false,
        takeActive: false,
        escaping: false,
        showHands: settingsRef.current.showHands,
        pace: settingsRef.current.moveSpeed,
      });
      lastPromptRef.current = prompt;
      promptQueuedRef.current = null;
      await lw2.setPrompt({ prompt });
      await lw2.setRotationSpeedDeg({
        rotation_speed_deg: settingsRef.current.lookSpeedDeg,
      });
      await delay(650);
      setBootMessage("Waking up…");
      await lw2.start();
    },
    [lw2, uploadFile],
  );

  const failToError = useCallback(
    (error: unknown, fallback: string) => {
      setErrorMessage(error instanceof Error ? error.message : fallback);
      updateGame({ phase: "error" });
    },
    [updateGame],
  );

  const launch = useCallback(async () => {
    if (launchPendingRef.current) return;
    if (!configured) {
      setErrorMessage(
        "REACTOR_API_KEY is not set. Add it to .env.local and restart the dev server.",
      );
      updateGame({ phase: "error" });
      return;
    }
    if (!anchorBlobRef.current) return;
    launchPendingRef.current = true;
    setErrorMessage(null);
    // This call is inside the WAKE UP click, which is the gesture the browser
    // requires before an AudioContext may start.
    if (settingsRef.current.soundEnabled) {
      const audio = getAudio();
      audio.start();
      audio.resume();
      audio.setVolume(settingsRef.current.volume);
      audio.setAmbience(0);
    }
    updateGame({
      ...initialState(settingsRef.current.loopSeconds),
      phase: "booting",
    });
    try {
      for (let attempt = 1; attempt <= TRANSPORT_ATTEMPTS; attempt += 1) {
        try {
          setBootMessage("Connecting…");
          let connectError: unknown = null;
          for (let tries = 1; tries <= CAPACITY_ATTEMPTS; tries += 1) {
            if (statusRef.current !== "disconnected") break;
            try {
              await lw2.connect();
              connectError = null;
              break;
            } catch (error) {
              connectError = error;
              if (!isCapacityError(error)) throw error;
              const backoff = parseRetryAfterMs(error) ?? CAPACITY_RETRY_MS;
              setBootMessage(
                isRateLimit(error)
                  ? `Too many sessions this minute. Waiting ${Math.ceil(
                      backoff / 1000,
                    )}s… (${tries}/${CAPACITY_ATTEMPTS})`
                  : `Every GPU is busy. Queueing for one… (${tries}/${CAPACITY_ATTEMPTS})`,
              );
              await delay(backoff);
            }
          }
          if (connectError) throw connectError;

          setBootMessage("Waiting for the GPU…");
          // Only treat "disconnected" as a drop once we have actually seen the
          // session leave that state — the ref can lag a render behind connect().
          let sawLive = false;
          await waitForOrFail(
            () => statusRef.current === "ready",
            () => {
              if (statusRef.current !== "disconnected") sawLive = true;
              return sawLive && statusRef.current === "disconnected";
            },
            120_000,
            "The world session did not become ready in time.",
            "The connection to the GPU dropped while starting up.",
          );

          await stageAndStart(1);
          await waitFor(
            () => gameRef.current.phase === "loop",
            120_000,
            "The floor did not return its first frame in time.",
          );
          break;
        } catch (error) {
          if (attempt === TRANSPORT_ATTEMPTS || !isTransientError(error)) throw error;
          if (isSessionBindingError(error)) {
            // We adopted someone else's session. Drop it and take a new token
            // so the next session is one we own.
            setBootMessage(
              `Session handover. Starting a clean one… (${attempt}/${TRANSPORT_ATTEMPTS})`,
            );
            invalidateToken();
          } else {
            setBootMessage(
              `Connection dropped. Retrying… (${attempt}/${TRANSPORT_ATTEMPTS})`,
            );
          }
          await lw2.disconnect().catch(() => undefined);
          await delay(2500);
        }
      }
    } catch (error) {
      failToError(error, "The world session could not start.");
    } finally {
      launchPendingRef.current = false;
    }
  }, [configured, failToError, lw2, stageAndStart, updateGame]);

  // The loop reset: the model forgets, our code remembers.
  const beginLoopReset = useCallback(async () => {
    if (resetPendingRef.current) return;
    resetPendingRef.current = true;
    const nextLoop = gameRef.current.loopNumber + 1;
    stopMovement();
    if (settingsRef.current.soundEnabled) {
      audioRef.current?.setWalking(false);
      audioRef.current?.playReset();
      // Variation index is zero-based and clamps at the last preset, so the
      // room tone gets darker exactly in step with the visuals.
      audioRef.current?.setAmbience(nextLoop - 1);
    }
    lookRef.current.release();
    updateGame({
      phase: "waking",
      loopNumber: nextLoop,
      secondsLeft: settingsRef.current.loopSeconds,
      searchesThisLoop: 0,
      keyVisible: false,
      hasKey: false,
    });
    try {
      if (statusRef.current === "ready") await lw2.reset();
      await delay(600);
      await stageAndStart(nextLoop);
      await waitFor(
        () => gameRef.current.phase === "loop",
        120_000,
        "The floor did not come back in time.",
      );
    } catch (error) {
      // A reset failing must not end the demo. Rebuild the session from
      // scratch and carry on at the same loop number — the player should only
      // notice a slightly longer blackout.
      if (!isTransientError(error)) {
        failToError(error, "The loop could not restart.");
        resetPendingRef.current = false;
        return;
      }
      try {
        setBootMessage("The building is slow to come back…");
        if (isSessionBindingError(error)) invalidateToken();
        await lw2.disconnect().catch(() => undefined);
        await delay(1500);
        await lw2.connect();
        await waitFor(
          () => statusRef.current === "ready",
          120_000,
          "The world session did not become ready in time.",
        );
        await stageAndStart(nextLoop);
        await waitFor(
          () => gameRef.current.phase === "loop",
          120_000,
          "The floor did not come back in time.",
        );
      } catch (retryError) {
        failToError(retryError, "The loop could not restart.");
      }
    } finally {
      resetPendingRef.current = false;
    }
  }, [failToError, lw2, stageAndStart, stopMovement, updateGame]);

  const beginEscape = useCallback(() => {
    if (gameRef.current.phase !== "loop") return;
    escapingRef.current = true;
    stopMovement();
    if (settingsRef.current.soundEnabled) {
      audioRef.current?.setWalking(false);
      audioRef.current?.playEscape();
    }
    lookRef.current.release();
    updateGame({ phase: "escape" });
    queuePrompt(true);
    dispatchPrompt(true);
    window.setTimeout(() => {
      updateGame({ phase: "ended" });
      if (statusRef.current === "ready") lw2.reset().catch(() => undefined);
    }, ESCAPE_SECONDS * 1000);
  }, [dispatchPrompt, lw2, queuePrompt, stopMovement, updateGame]);

  const interact = useCallback(() => {
    const state = gameRef.current;
    if (state.phase !== "loop") return;
    if (state.hasKey) {
      beginEscape();
      return;
    }
    if (state.keyVisible) {
      takeChunksRef.current = EVENT_CHUNKS;
      if (settingsRef.current.soundEnabled) audioRef.current?.playKey();
      updateGame({ keyVisible: false, hasKey: true, hadKeyEver: true });
      queuePrompt(true);
      return;
    }
    const searches = state.searchesThisLoop + 1;
    updateGame({ searchesThisLoop: searches });
    searchChunksRef.current = EVENT_CHUNKS;
    if (settingsRef.current.soundEnabled) audioRef.current?.playSearch();
    pendingRevealRef.current = searchRevealsKey(
      { ...state, searchesThisLoop: searches },
      settingsRef.current,
    );
    setAttention("large");
    queuePrompt(true);
  }, [beginEscape, queuePrompt, setAttention, updateGame]);

  const restart = useCallback(() => {
    escapingRef.current = false;
    searchChunksRef.current = 0;
    takeChunksRef.current = 0;
    pendingRevealRef.current = false;
    stopMovement();
    if (statusRef.current === "ready") lw2.reset().catch(() => undefined);
    setErrorMessage(null);
    const fresh = initialState(settingsRef.current.loopSeconds);
    gameRef.current = fresh;
    setGame(fresh);
  }, [lw2, stopMovement]);

  // Model events drive phase changes; commands only request them.
  useLingbotWorld2Message((message) => {
    switch (message.type) {
      case "image_accepted":
        imageReadyRef.current?.();
        imageReadyRef.current = null;
        break;
      case "generation_started": {
        const phase = gameRef.current.phase;
        if (phase === "booting" || phase === "waking") {
          updateGame({ phase: "loop" });
        }
        break;
      }
      case "chunk_complete":
        setChunkIndex(message.chunk_index);
        // Pose is a per-chunk buffer, so a sustained push has to be re-sent.
        sendMovePoseRef.current();
        if (searchChunksRef.current > 0) {
          searchChunksRef.current -= 1;
          if (searchChunksRef.current === 0) {
            if (pendingRevealRef.current) {
              pendingRevealRef.current = false;
              updateGame({ keyVisible: true });
            }
            queuePrompt();
          }
        }
        if (takeChunksRef.current > 0) {
          takeChunksRef.current -= 1;
          if (takeChunksRef.current === 0) queuePrompt();
        }
        dispatchPrompt();
        break;
      case "command_error":
        setPromptNote(`error: ${message.command}`);
        break;
    }
  });

  const sendMovementCommandsRef = useRef(sendMovementCommands);
  sendMovementCommandsRef.current = sendMovementCommands;

  // Look tick. Runs at 100ms so turning tracks the hand, not the chunk rate.
  const lookTickRef = useRef({ look, applyLook, settings });
  lookTickRef.current = { look, applyLook, settings };

  useEffect(() => {
    const LOOK_TICK_MS = 100;
    const PIXEL_DEADZONE = 2.2; // px per tick before we call it a turn
    const PIXEL_FULL = 42; // px per tick that counts as a hard flick
    const TILT_DEADZONE = 0.08;

    const timer = window.setInterval(() => {
      const { look, applyLook, settings } = lookTickRef.current;
      if (gameRef.current.phase !== "loop") return;

      const { dx, dy, tiltX } = look.drain();
      const sens = settings.mouseSensitivity;
      const px = dx * sens;
      const py = dy * sens;
      if (settings.showDebug && (dx !== 0 || dy !== 0)) {
        setLookDebug((prev) => ({
          ...prev,
          dx: `${dx.toFixed(0)}/${dy.toFixed(0)}`,
        }));
      }

      // Arrow keys are explicit and win outright.
      const keyH = lookHStackRef.current.at(-1);
      const keyV = lookVStackRef.current.at(-1);

      let lookH: LookH = "idle";
      let lookV: LookV = "idle";
      let intensity = 0;

      if (keyH) {
        lookH = keyH;
        intensity = 0.6;
      } else if (Math.abs(px) > PIXEL_DEADZONE) {
        lookH = px > 0 ? "right" : "left";
        intensity = Math.max(intensity, Math.min(1, Math.abs(px) / PIXEL_FULL));
      } else if (Math.abs(tiltX) > TILT_DEADZONE) {
        lookH = tiltX > 0 ? "right" : "left";
        intensity = Math.max(intensity, Math.min(1, Math.abs(tiltX)));
      }

      if (keyV) {
        lookV = keyV;
        intensity = Math.max(intensity, 0.6);
      } else if (Math.abs(py) > PIXEL_DEADZONE) {
        lookV = py > 0 ? "down" : "up";
        intensity = Math.max(intensity, Math.min(1, Math.abs(py) / PIXEL_FULL));
      }

      // Scale turn speed with how hard the player moved, around their setting.
      const base = settings.lookSpeedDeg;
      const speed =
        lookH === "idle" && lookV === "idle"
          ? base
          : Math.min(30, Math.max(1, base * (0.45 + intensity * 1.6)));
      applyLook(lookH, lookV, speed);
    }, LOOK_TICK_MS);
    return () => window.clearInterval(timer);
  }, []);

  // The loop clock. Truth lives here, not in the model.
  //
  // These intervals MUST mount once. Anything in the dependency array that gets
  // a fresh identity each render (the SDK handle, hook return objects) tears the
  // interval down and re-creates it before it can ever fire, and the clock
  // silently never ticks. Reach through refs instead.
  const beginLoopResetRef = useRef(beginLoopReset);
  beginLoopResetRef.current = beginLoopReset;

  useEffect(() => {
    const timer = window.setInterval(() => {
      const state = gameRef.current;
      if (state.phase !== "loop") return;
      const secondsLeft = state.secondsLeft - 1;
      const totalSeconds = state.totalSeconds + 1;
      if (secondsLeft <= 0) {
        updateGame({ totalSeconds });
        void beginLoopResetRef.current();
      } else {
        updateGame({ secondsLeft, totalSeconds });
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [updateGame]);

  // Collision approximation: if the picture stops changing while walking
  // forward, the player has walked into something solid.
  const collisionDepsRef = useRef({ clearBlocked, queuePrompt, lw2 });
  collisionDepsRef.current = { clearBlocked, queuePrompt, lw2 };

  useEffect(() => {
    if (!settings.collisionFeedback) return;
    if (!samplerRef.current) samplerRef.current = createFrameSampler();
    const sampler = samplerRef.current;
    const timer = window.setInterval(() => {
      const { clearBlocked, queuePrompt, lw2 } = collisionDepsRef.current;
      if (gameRef.current.phase !== "loop") return;
      const delta = sampler.sample();
      if (delta === null) return;
      setMotionDelta(delta);
      const walkingForward = lastMoveLongRef.current === "forward";
      if (!walkingForward) {
        stallCountRef.current = 0;
        if (blockedRef.current) clearBlocked();
        return;
      }
      if (delta < STALL_THRESHOLD) {
        stallCountRef.current += 1;
        if (stallCountRef.current >= STALL_SAMPLES && !blockedRef.current) {
          blockedRef.current = true;
          setBlocked(true);
          // Stop pushing into the wall; the model is already refusing to move.
          lastMoveLongRef.current = "idle";
          lw2
            .setMoveLongitudinal({ move_longitudinal: "idle" })
            .catch(() => undefined);
          movingRef.current = lastMoveLatRef.current !== "idle";
          queuePrompt(true);
        }
      } else {
        stallCountRef.current = 0;
        if (blockedRef.current) clearBlocked();
      }
    }, 260);
    return () => window.clearInterval(timer);
  }, [settings.collisionFeedback]);

  // Keep the mixer in step with the settings panel.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.setMuted(!settings.soundEnabled);
    audio.setVolume(settings.volume);
  }, [settings.soundEnabled, settings.volume]);

  // Silence the footsteps whenever play stops.
  useEffect(() => {
    if (game.phase !== "loop") audioRef.current?.setWalking(false);
  }, [game.phase]);

  // Push turn speed to the model when the setting changes mid-session.
  useEffect(() => {
    if (statusRef.current !== "ready") return;
    lw2
      .setRotationSpeedDeg({ rotation_speed_deg: settings.lookSpeedDeg })
      .catch(() => undefined);
  }, [lw2, settings.lookSpeedDeg]);

  // Resolve the anchor frame from /public.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(ANCHOR_URL, { cache: "no-store" });
        if (!response.ok) throw new Error("missing");
        const blob = await response.blob();
        if (cancelled) return;
        if (!blob.type.startsWith("image/")) throw new Error("not an image");
        anchorBlobRef.current = blob;
        setAnchorState("found");
      } catch {
        if (!cancelled && !anchorBlobRef.current) setAnchorState("missing");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const onAnchorFile = useCallback((file: File | undefined) => {
    if (!file || !file.type.startsWith("image/")) return;
    anchorBlobRef.current = file;
    setAnchorState("custom");
  }, []);

  // Keyboard.
  useEffect(() => {
    const pushUnique = <T,>(stack: T[], value: T) => {
      if (!stack.includes(value)) stack.push(value);
    };
    const remove = <T,>(stack: T[], value: T) => {
      const index = stack.indexOf(value);
      if (index >= 0) stack.splice(index, 1);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        target.closest("input, textarea, select, button")
      ) {
        return;
      }
      const key = event.key.toLowerCase();
      const state = gameRef.current;
      if (key === "`") {
        updateSettings({ showDebug: !settingsRef.current.showDebug });
        return;
      }
      if (state.phase === "title" && (key === "enter" || key === " ")) {
        event.preventDefault();
        void launch();
        return;
      }
      if ((state.phase === "ended" || state.phase === "error") && key === "r") {
        restart();
        return;
      }
      if (state.phase !== "loop") return;
      if (key === "e") {
        event.preventDefault();
        interact();
        return;
      }
      if (key === "w") pushUnique(moveLongStackRef.current, "forward");
      else if (key === "s") pushUnique(moveLongStackRef.current, "back");
      else if (key === "a") pushUnique(moveLatStackRef.current, "strafe_left");
      else if (key === "d") pushUnique(moveLatStackRef.current, "strafe_right");
      else if (event.key === "ArrowLeft") pushUnique(lookHStackRef.current, "left");
      else if (event.key === "ArrowRight") pushUnique(lookHStackRef.current, "right");
      else if (event.key === "ArrowUp") pushUnique(lookVStackRef.current, "up");
      else if (event.key === "ArrowDown") pushUnique(lookVStackRef.current, "down");
      else return;
      event.preventDefault();
      clearBlocked();
      sendMovementCommands();
    };
    const onKeyUp = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      if (key === "w") remove(moveLongStackRef.current, "forward");
      else if (key === "s") remove(moveLongStackRef.current, "back");
      else if (key === "a") remove(moveLatStackRef.current, "strafe_left");
      else if (key === "d") remove(moveLatStackRef.current, "strafe_right");
      else if (event.key === "ArrowLeft") remove(lookHStackRef.current, "left");
      else if (event.key === "ArrowRight") remove(lookHStackRef.current, "right");
      else if (event.key === "ArrowUp") remove(lookVStackRef.current, "up");
      else if (event.key === "ArrowDown") remove(lookVStackRef.current, "down");
      else return;
      clearBlocked();
      sendMovementCommands();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [
    clearBlocked,
    interact,
    launch,
    restart,
    sendMovementCommands,
    updateSettings,
  ]);

  // If the transport drops mid-demo, degrade gracefully instead of crashing.
  useEffect(() => {
    if (status !== "disconnected") return;
    const phase = gameRef.current.phase;
    if (phase === "loop" || phase === "waking" || phase === "escape") {
      setErrorMessage("The connection to the world model dropped.");
      updateGame({ phase: "error" });
    }
  }, [status, updateGame]);

  const { phase } = game;
  const variation = variationForLoop(game.loopNumber);
  const timeFraction = Math.max(
    0,
    Math.min(1, game.secondsLeft / settings.loopSeconds),
  );
  const critical = phase === "loop" && game.secondsLeft <= 10;
  const elapsedThisLoop = settings.loopSeconds - game.secondsLeft;
  // Touch controls: on by default wherever the primary input is coarse.
  // Resolved before the hint copy, which names a different verb on touch.
  const touchMode =
    settings.touchControls === "on" ||
    (settings.touchControls === "auto" && coarsePointer);

  const onTouchMove = useCallback((vector: MoveVector) => {
    touchMoveRef.current = vector;
    sendMovementCommandsRef.current();
  }, []);

  const hint = useMemo(
    () => currentHint(game, settings, elapsedThisLoop, touchMode),
    [game, settings, elapsedThisLoop, touchMode],
  );
  const wake = wakeHint(game, settings);

  const showVideo =
    phase === "loop" ||
    phase === "waking" ||
    phase === "escape" ||
    phase === "booting" ||
    phase === "error";

  return (
    <main
      ref={stageRef}
      className={`stage phase-${phase} ${critical ? "is-critical" : ""}`}
      style={
        { "--vig": String(0.25 + (1 - timeFraction) * 0.55) } as React.CSSProperties
      }
      onPointerDown={(event) => {
        if (!playing) return;
        const target = event.target;
        if (
          target instanceof HTMLElement &&
          target.closest("button, input, label, .settings-panel")
        ) {
          return;
        }
        // On touch the drag pad handles looking; pointer lock is desktop-only.
        if (touchMode || event.pointerType === "touch") return;
        if (stageRef.current) look.requestLock(stageRef.current);
        // Also arm drag-to-look, so a refused or unavailable pointer lock still
        // leaves the player a way to turn.
        look.onDragStart(event);
      }}
      onPointerMove={(event) => {
        if (!playing || touchMode || look.locked) return;
        look.onDragMove(event);
      }}
      onPointerUp={(event) => {
        if (touchMode) return;
        look.onDragEnd(event);
      }}
      onPointerCancel={(event) => {
        if (touchMode) return;
        look.onDragEnd(event);
      }}
    >
      {showVideo && (
        <LingbotWorld2MainVideoView
          videoObjectFit="cover"
          className="world-video"
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
        />
      )}
      <div className="grain" aria-hidden="true" />
      <div className="vignette" aria-hidden="true" />

      {(phase === "loop" || phase === "title") && (
        <SettingsPanel
          open={settingsOpen}
          settings={settings}
          tiltSupported={look.tiltPermission !== "unsupported"}
          onToggle={() => setSettingsOpen((value) => !value)}
          onChange={updateSettings}
          onTiltChange={async (enabled) => {
            if (!enabled) {
              updateSettings({ tiltEnabled: false });
              return;
            }
            const granted =
              look.tiltPermission === "granted" || (await look.requestTilt());
            if (granted) updateSettings({ tiltEnabled: true });
          }}
          onReset={resetSettings}
        />
      )}

      {phase === "loop" && (
        <div className="hud">
          <div className="hud-corner hud-top-left">
            <span className="loop-counter">
              LOOP {String(game.loopNumber).padStart(2, "0")}
            </span>
            <span className="variation-label">{variation.label}</span>
          </div>
          <div className="hud-corner hud-top-right">
            <span className={`clock ${critical ? "clock-critical" : ""}`}>
              {formatClock(game.secondsLeft)}
            </span>
            <div className="time-bar">
              <div className="time-bar-fill" style={{ width: `${timeFraction * 100}%` }} />
            </div>
          </div>
          <div className="hud-corner hud-bottom-left">
            <span className={`key-tag ${game.hasKey ? "key-held" : ""}`}>
              {game.hasKey ? "✦ THE KEY" : "the key is here somewhere"}
            </span>
          </div>
          <div className="hud-corner hud-bottom-right">
            <span className="controls-hint">
              {touchMode
                ? "STICK MOVES · DRAG LOOKS"
                : "WASD MOVE · MOUSE LOOK · E INTERACT"}
            </span>
          </div>

          {blocked && <div className="blocked-flash">THAT WAY IS SOLID</div>}

          {hint && (
            <div className={`hud-hint hint-${hint.tone}`} key={hint.text}>
              {hint.text}
            </div>
          )}

          {!look.locked && !touchMode && (
            <div className="lock-prompt">CLICK TO LOOK AROUND · ESC TO RELEASE</div>
          )}
        </div>
      )}

      {phase === "loop" && touchMode && (
        <TouchControls
          onMove={onTouchMove}
          onInteract={interact}
          interactLabel={
            game.hasKey ? "OPEN" : game.keyVisible ? "TAKE" : "SEARCH"
          }
          lookHandlers={{
            onPointerDown: look.onDragStart,
            onPointerMove: look.onDragMove,
            onPointerUp: look.onDragEnd,
          }}
          showTiltButton={look.tiltPermission !== "unsupported"}
          tiltOn={settings.tiltEnabled}
          onToggleTilt={async () => {
            if (!settings.tiltEnabled) {
              const granted =
                look.tiltPermission === "granted" || (await look.requestTilt());
              if (!granted) return;
              updateSettings({ tiltEnabled: true });
            } else {
              updateSettings({ tiltEnabled: false });
            }
          }}
        />
      )}

      {phase === "title" && (
        <div className="overlay overlay-title">
          <p className="kicker">A WORLD MODEL TIME LOOP</p>
          <h1 className="title">THE LOOP HOUSE</h1>
          <p className="premise">
            You wake up in a building you were just standing in. It resets every{" "}
            {settings.loopSeconds} seconds. Somewhere in it there is a key.
          </p>
          <div className="anchor-row">
            {anchorState === "checking" && <span>checking anchor frame…</span>}
            {anchorState === "found" && <span>anchor frame ✦ ready</span>}
            {anchorState === "custom" && <span>anchor frame ✦ custom</span>}
            {anchorState === "missing" && (
              <span className="anchor-missing">
                no anchor frame — add public/anchors/bedroom.png or drop one here
              </span>
            )}
            <label className="anchor-pick">
              choose image
              <input
                type="file"
                accept="image/*"
                onChange={(event) => onAnchorFile(event.target.files?.[0])}
              />
            </label>
          </div>
          <button
            className="start-button"
            onClick={() => void launch()}
            disabled={anchorState === "checking" || anchorState === "missing"}
          >
            WAKE UP
          </button>
          {!configured && (
            <p className="config-warning">
              REACTOR_API_KEY is not set — add it to .env.local
            </p>
          )}
        </div>
      )}

      {phase === "booting" && (
        <div className="overlay overlay-boot">
          <p className="boot-line">{bootMessage}</p>
        </div>
      )}

      {phase === "waking" && (
        <div className="overlay overlay-wake">
          <p className="wake-line">
            {game.hadKeyEver && !game.hasKey
              ? "It was in your hand."
              : variation.wakeLine}
          </p>
          <p className="wake-loop">LOOP {String(game.loopNumber).padStart(2, "0")}</p>
          {wake && <p className="wake-hint">{wake}</p>}
        </div>
      )}

      {phase === "escape" && <div className="overlay overlay-escape" />}

      {phase === "ended" && (
        <div className="overlay overlay-end">
          <h2 className="end-title">You left the building.</h2>
          <p className="end-stats">
            {game.loopNumber} {game.loopNumber === 1 ? "loop" : "loops"} ·{" "}
            {formatClock(game.totalSeconds)} inside
          </p>
          <p className="end-hint">R — begin again</p>
        </div>
      )}

      {phase === "error" && (
        <div className="overlay overlay-error">
          <h2 className="error-title">The building holds its breath.</h2>
          {errorMessage && isRateLimit(errorMessage) ? (
            <p className="error-detail">
              Reactor allows 10 new sessions a minute for this model and we have
              used them up. Wait a minute, then try again — nothing is broken.
            </p>
          ) : errorMessage && isCapacityError(errorMessage) ? (
            <p className="error-detail">
              Reactor has no free GPUs right now — every world model server is
              busy. This is capacity, not a bug. Try again in a moment.
            </p>
          ) : (
            errorMessage && <p className="error-detail">{errorMessage}</p>
          )}
          <button className="start-button error-retry" onClick={restart}>
            TRY AGAIN
          </button>
          <p className="end-hint">or press R</p>
        </div>
      )}

      {settings.showDebug && (
        <div className="debug-panel">
          <p>
            status: {status} · chunk: {chunkIndex} · prompt: {promptNote} ·
            motion: {motionDelta.toFixed(2)} {blocked ? "· BLOCKED" : ""}
          </p>
          <p>
            phase: {phase} · loop: {game.loopNumber} · t-{game.secondsLeft}s ·
            searches: {game.searchesThisLoop} · keyVisible:{" "}
            {String(game.keyVisible)} · hasKey: {String(game.hasKey)}
          </p>
          <p>
            lock: {String(look.locked)} · drag: {String(look.dragging)} · touch:{" "}
            {String(touchMode)} · look: {lookDebug.h}/{lookDebug.v} @{" "}
            {lookDebug.speed}° · d: {lookDebug.dx} · tilt: {look.tiltPermission}
            {look.tiltActive ? " (live)" : ""}
          </p>
          <p className="debug-prompt">{lastPromptRef.current.slice(0, 200)}…</p>
          <div className="debug-actions">
            <button onClick={() => void beginLoopReset()}>force reset</button>
            <button onClick={() => updateGame({ keyVisible: true })}>
              reveal key
            </button>
            <button
              onClick={() =>
                updateGame({ keyVisible: false, hasKey: true, hadKeyEver: true })
              }
            >
              grant key
            </button>
            <button onClick={beginEscape}>escape now</button>
          </div>
        </div>
      )}
    </main>
  );
}

export function LoopHouse({ configured }: { configured: boolean }) {
  return (
    <LingbotWorld2Provider apiUrl={API_URL} getJwt={fetchToken}>
      <LoopHouseGame configured={configured} />
    </LingbotWorld2Provider>
  );
}
