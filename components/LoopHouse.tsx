"use client";

import {
  LingbotWorld2MainVideoView,
  LingbotWorld2Provider,
  useLingbotWorld2,
  useLingbotWorld2Message,
} from "@reactor-models/lingbot-world-2";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SettingsPanel } from "@/components/SettingsPanel";
import { useMouseLook } from "@/hooks/useMouseLook";
import {
  createFrameSampler,
  STALL_SAMPLES,
  STALL_THRESHOLD,
} from "@/lib/frames";
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

type MoveLong = "idle" | "forward" | "back";
type MoveLat = "idle" | "strafe_left" | "strafe_right";
type LookH = "idle" | "left" | "right";
type LookV = "idle" | "up" | "down";

async function fetchToken(): Promise<string> {
  const response = await fetch("/api/reactor/token");
  const body = (await response.json().catch(() => ({}))) as {
    jwt?: string;
    error?: string;
  };
  if (!response.ok || !body.jwt) {
    throw new Error(body.error ?? `Token request failed (${response.status})`);
  }
  return body.jwt;
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
    message.toLowerCase().includes("no available servers")
  );
}

// The WebRTC transport to the GPU can drop while a session is coming up —
// venue wifi, a flaky GPU, a session that never finishes handshaking. Worth
// retrying the whole boot rather than showing a judge an error.
const TRANSPORT_ATTEMPTS = 3;

function isTransientError(error: unknown): boolean {
  if (isCapacityError(error)) return true;
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
  const poseActiveRef = useRef(false);

  const samplerRef = useRef<ReturnType<typeof createFrameSampler> | null>(null);
  const stallCountRef = useRef(0);

  const playing = game.phase === "loop";
  const mouseLook = useMouseLook({
    enabled: playing,
    sensitivity: settings.mouseSensitivity,
    invertY: settings.invertY,
  });

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

  // Mouse look is delivered as per-latent camera deltas, re-sent each chunk.
  const sendCameraPose = useCallback(() => {
    if (statusRef.current !== "ready" || gameRef.current.phase !== "loop") return;
    const { yaw, pitch } = mouseLook.consume();
    const active = Math.abs(yaw) > 0.0005 || Math.abs(pitch) > 0.0005;
    if (!active) {
      if (poseActiveRef.current) {
        lw2.setCameraPose({ camera_pose: [] }).catch(() => undefined);
        poseActiveRef.current = false;
      }
      return;
    }
    const pose: number[] = [];
    for (let i = 0; i < CHUNK_LATENTS; i += 1) {
      // [rx, ry, rz, tx, ty, tz] — pitch, yaw, roll, then translation.
      pose.push(pitch, yaw, 0, 0, 0, 0);
    }
    lw2.setCameraPose({ camera_pose: pose }).catch(() => undefined);
    poseActiveRef.current = true;
  }, [lw2, mouseLook]);

  const clearBlocked = useCallback(() => {
    if (!blockedRef.current) return;
    blockedRef.current = false;
    stallCountRef.current = 0;
    setBlocked(false);
  }, []);

  const sendMovementCommands = useCallback(() => {
    if (statusRef.current !== "ready") return;
    const moveLong: MoveLong = moveLongStackRef.current.at(-1) ?? "idle";
    const moveLat: MoveLat = moveLatStackRef.current.at(-1) ?? "idle";
    const lookH: LookH = lookHStackRef.current.at(-1) ?? "idle";
    const lookV: LookV = lookVStackRef.current.at(-1) ?? "idle";
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
    if (lookH !== lastLookHRef.current) {
      lastLookHRef.current = lookH;
      lw2.setLookHorizontal({ look_horizontal: lookH }).catch(() => undefined);
    }
    if (lookV !== lastLookVRef.current) {
      lastLookVRef.current = lookV;
      lw2.setLookVertical({ look_vertical: lookV }).catch(() => undefined);
    }
    const moving = moveLong !== "idle" || moveLat !== "idle";
    if (moving !== movingRef.current) {
      movingRef.current = moving;
      changed = true;
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
    if (statusRef.current !== "ready") return;
    lastMoveLongRef.current = "idle";
    lastMoveLatRef.current = "idle";
    lastLookHRef.current = "idle";
    lastLookVRef.current = "idle";
    lw2.setMoveLongitudinal({ move_longitudinal: "idle" }).catch(() => undefined);
    lw2.setMoveLateral({ move_lateral: "idle" }).catch(() => undefined);
    lw2.setLookHorizontal({ look_horizontal: "idle" }).catch(() => undefined);
    lw2.setLookVertical({ look_vertical: "idle" }).catch(() => undefined);
    if (poseActiveRef.current) {
      lw2.setCameraPose({ camera_pose: [] }).catch(() => undefined);
      poseActiveRef.current = false;
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
              setBootMessage(
                `Every GPU is busy. Queueing for one… (${tries}/${CAPACITY_ATTEMPTS})`,
              );
              await delay(CAPACITY_RETRY_MS);
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
          setBootMessage(
            `Connection dropped. Retrying… (${attempt}/${TRANSPORT_ATTEMPTS})`,
          );
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
    mouseLook.release();
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
      failToError(error, "The loop could not restart.");
    } finally {
      resetPendingRef.current = false;
    }
  }, [failToError, lw2, mouseLook, stageAndStart, stopMovement, updateGame]);

  const beginEscape = useCallback(() => {
    if (gameRef.current.phase !== "loop") return;
    escapingRef.current = true;
    stopMovement();
    mouseLook.release();
    updateGame({ phase: "escape" });
    queuePrompt(true);
    dispatchPrompt(true);
    window.setTimeout(() => {
      updateGame({ phase: "ended" });
      if (statusRef.current === "ready") lw2.reset().catch(() => undefined);
    }, ESCAPE_SECONDS * 1000);
  }, [dispatchPrompt, lw2, mouseLook, queuePrompt, stopMovement, updateGame]);

  const interact = useCallback(() => {
    const state = gameRef.current;
    if (state.phase !== "loop") return;
    if (state.hasKey) {
      beginEscape();
      return;
    }
    if (state.keyVisible) {
      takeChunksRef.current = EVENT_CHUNKS;
      updateGame({ keyVisible: false, hasKey: true, hadKeyEver: true });
      queuePrompt(true);
      return;
    }
    const searches = state.searchesThisLoop + 1;
    updateGame({ searchesThisLoop: searches });
    searchChunksRef.current = EVENT_CHUNKS;
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
        sendCameraPose();
        dispatchPrompt();
        break;
      case "command_error":
        setPromptNote(`error: ${message.command}`);
        break;
    }
  });

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
  const hint = useMemo(
    () => currentHint(game, settings, elapsedThisLoop),
    [game, settings, elapsedThisLoop],
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
        if (stageRef.current) mouseLook.requestLock(stageRef.current);
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
          onToggle={() => setSettingsOpen((value) => !value)}
          onChange={updateSettings}
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
              WASD MOVE · MOUSE LOOK · E INTERACT
            </span>
          </div>

          {blocked && <div className="blocked-flash">THAT WAY IS SOLID</div>}

          {hint && (
            <div className={`hud-hint hint-${hint.tone}`} key={hint.text}>
              {hint.text}
            </div>
          )}

          {!mouseLook.locked && (
            <div className="lock-prompt">CLICK TO LOOK AROUND · ESC TO RELEASE</div>
          )}
        </div>
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
          {errorMessage && isCapacityError(errorMessage) ? (
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
            {String(game.keyVisible)} · hasKey: {String(game.hasKey)} · lock:{" "}
            {String(mouseLook.locked)}
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
