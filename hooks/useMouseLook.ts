"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// Pixels of mouse movement to rotation units, before the user's sensitivity.
// LingBot takes per-latent-frame deltas, so this is "per latent", not per frame.
const BASE_SCALE = 0.0009;
const MAX_PER_LATENT = 0.14;

function clamp(value: number, limit: number) {
  return Math.max(-limit, Math.min(limit, value));
}

export type MouseLook = {
  locked: boolean;
  /** Call from a click handler on the element that should capture the pointer. */
  requestLock: (element: HTMLElement) => void;
  release: () => void;
  /** Drains accumulated movement into clamped per-latent yaw/pitch deltas. */
  consume: () => { yaw: number; pitch: number };
  /** True if the mouse has moved since the last consume. */
  pendingRef: React.RefObject<boolean>;
};

export function useMouseLook(options: {
  enabled: boolean;
  sensitivity: number;
  invertY: boolean;
}): MouseLook {
  const { enabled, sensitivity, invertY } = options;
  const [locked, setLocked] = useState(false);
  const dxRef = useRef(0);
  const dyRef = useRef(0);
  const pendingRef = useRef(false);
  const sensitivityRef = useRef(sensitivity);
  const invertRef = useRef(invertY);
  sensitivityRef.current = sensitivity;
  invertRef.current = invertY;

  useEffect(() => {
    const onPointerLockChange = () => {
      setLocked(Boolean(document.pointerLockElement));
    };
    document.addEventListener("pointerlockchange", onPointerLockChange);
    return () =>
      document.removeEventListener("pointerlockchange", onPointerLockChange);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const onMove = (event: MouseEvent) => {
      // Only steer while the pointer is captured, so stray cursor movement over
      // the HUD never turns the camera.
      if (!document.pointerLockElement) return;
      dxRef.current += event.movementX;
      dyRef.current += event.movementY;
      pendingRef.current = true;
    };
    window.addEventListener("mousemove", onMove);
    return () => window.removeEventListener("mousemove", onMove);
  }, [enabled]);

  // Never leave the pointer captured once play stops.
  useEffect(() => {
    if (!enabled && document.pointerLockElement) document.exitPointerLock();
  }, [enabled]);

  const requestLock = useCallback((element: HTMLElement) => {
    if (document.pointerLockElement) return;
    try {
      const result = element.requestPointerLock() as unknown;
      if (result instanceof Promise) result.catch(() => undefined);
    } catch {
      // Pointer lock is unavailable; arrow keys still work.
    }
  }, []);

  const release = useCallback(() => {
    if (document.pointerLockElement) document.exitPointerLock();
  }, []);

  const consume = useCallback(() => {
    const scale = BASE_SCALE * sensitivityRef.current;
    const yaw = clamp(dxRef.current * scale, MAX_PER_LATENT);
    const rawPitch = dyRef.current * scale * (invertRef.current ? -1 : 1);
    const pitch = clamp(rawPitch, MAX_PER_LATENT);
    dxRef.current = 0;
    dyRef.current = 0;
    pendingRef.current = false;
    return { yaw, pitch };
  }, []);

  // Stable identity: callers put this in dependency arrays, and a fresh object
  // each render silently tears down their intervals.
  return useMemo(
    () => ({ locked, requestLock, release, consume, pendingRef }),
    [locked, requestLock, release, consume],
  );
}
