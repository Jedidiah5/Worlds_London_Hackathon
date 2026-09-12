"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// Unified look input: pointer-locked mouse, mouse drag, touch drag, and device
// tilt all feed one place.
//
// Deltas (mouse, touch) accumulate and are drained by the consumer on a fast
// tick. Tilt is absolute, so it contributes a standing intent instead. The
// consumer turns the result into set_look_horizontal / set_look_vertical, which
// the model applies continuously — far smoother than posting one big camera
// pose per chunk.

export type LookDrain = {
  /** Accumulated pointer delta since the last drain, in pixels. */
  dx: number;
  dy: number;
  /** Standing tilt intent, -1..1. Zero when tilt is off or unsupported. */
  tiltX: number;
};

export type TiltPermission = "unsupported" | "prompt" | "granted" | "denied";

export function useLookInput(options: {
  enabled: boolean;
  invertY: boolean;
  tiltEnabled: boolean;
  tiltSensitivity: number;
}) {
  const { enabled, invertY, tiltEnabled, tiltSensitivity } = options;

  const [locked, setLocked] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [tiltPermission, setTiltPermission] =
    useState<TiltPermission>("unsupported");
  const [tiltActive, setTiltActive] = useState(false);

  const dxRef = useRef(0);
  const dyRef = useRef(0);
  const tiltXRef = useRef(0);
  const invertRef = useRef(invertY);
  invertRef.current = invertY;
  const tiltSensRef = useRef(tiltSensitivity);
  tiltSensRef.current = tiltSensitivity;
  const dragPointerRef = useRef<number | null>(null);
  const lastDragRef = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const hasOrientation = "DeviceOrientationEvent" in window;
    if (!hasOrientation) {
      setTiltPermission("unsupported");
      return;
    }
    const needsRequest =
      typeof (
        DeviceOrientationEvent as unknown as {
          requestPermission?: () => Promise<string>;
        }
      ).requestPermission === "function";
    setTiltPermission(needsRequest ? "prompt" : "granted");
  }, []);

  // Pointer lock state.
  useEffect(() => {
    const onChange = () => setLocked(Boolean(document.pointerLockElement));
    document.addEventListener("pointerlockchange", onChange);
    return () => document.removeEventListener("pointerlockchange", onChange);
  }, []);

  // Locked mouse movement.
  useEffect(() => {
    if (!enabled) return;
    const onMove = (event: MouseEvent) => {
      if (!document.pointerLockElement) return;
      dxRef.current += event.movementX;
      dyRef.current += event.movementY;
    };
    window.addEventListener("mousemove", onMove);
    return () => window.removeEventListener("mousemove", onMove);
  }, [enabled]);

  // Release the pointer as soon as play stops.
  useEffect(() => {
    if (!enabled && document.pointerLockElement) document.exitPointerLock();
  }, [enabled]);

  // Device tilt. gamma is the left/right roll in degrees.
  useEffect(() => {
    if (!enabled || !tiltEnabled || tiltPermission !== "granted") {
      tiltXRef.current = 0;
      setTiltActive(false);
      return;
    }
    const DEADZONE_DEG = 6;
    const RANGE_DEG = 32;
    const onOrientation = (event: DeviceOrientationEvent) => {
      const gamma = event.gamma;
      if (gamma === null || gamma === undefined) return;
      setTiltActive(true);
      const magnitude = Math.abs(gamma) - DEADZONE_DEG;
      if (magnitude <= 0) {
        tiltXRef.current = 0;
        return;
      }
      const normalized = Math.min(1, magnitude / RANGE_DEG);
      tiltXRef.current = Math.sign(gamma) * normalized * tiltSensRef.current;
    };
    window.addEventListener("deviceorientation", onOrientation);
    return () => {
      window.removeEventListener("deviceorientation", onOrientation);
      tiltXRef.current = 0;
      setTiltActive(false);
    };
  }, [enabled, tiltEnabled, tiltPermission]);

  const requestTilt = useCallback(async () => {
    const ctor = DeviceOrientationEvent as unknown as {
      requestPermission?: () => Promise<string>;
    };
    if (typeof ctor.requestPermission !== "function") {
      setTiltPermission("granted");
      return true;
    }
    try {
      const result = await ctor.requestPermission();
      const granted = result === "granted";
      setTiltPermission(granted ? "granted" : "denied");
      return granted;
    } catch {
      setTiltPermission("denied");
      return false;
    }
  }, []);

  const requestLock = useCallback((element: HTMLElement) => {
    if (document.pointerLockElement) return;
    try {
      const result = element.requestPointerLock() as unknown;
      if (result instanceof Promise) result.catch(() => undefined);
    } catch {
      // Pointer lock unavailable — drag-to-look still works.
    }
  }, []);

  const release = useCallback(() => {
    if (document.pointerLockElement) document.exitPointerLock();
  }, []);

  // Drag-to-look: the fallback when pointer lock is refused, and the primary
  // path on touch devices.
  const onDragStart = useCallback((event: React.PointerEvent) => {
    dragPointerRef.current = event.pointerId;
    lastDragRef.current = { x: event.clientX, y: event.clientY };
    setDragging(true);
    try {
      (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    } catch {
      // Capture is a nicety; movement still tracks without it.
    }
  }, []);

  const onDragMove = useCallback((event: React.PointerEvent) => {
    if (dragPointerRef.current !== event.pointerId) return;
    const last = lastDragRef.current;
    if (!last) return;
    dxRef.current += event.clientX - last.x;
    dyRef.current += event.clientY - last.y;
    lastDragRef.current = { x: event.clientX, y: event.clientY };
  }, []);

  const onDragEnd = useCallback((event: React.PointerEvent) => {
    if (dragPointerRef.current !== event.pointerId) return;
    dragPointerRef.current = null;
    lastDragRef.current = null;
    setDragging(false);
  }, []);

  /** Drain accumulated pointer movement and read standing tilt. */
  const drain = useCallback((): LookDrain => {
    const dx = dxRef.current;
    const dy = dyRef.current * (invertRef.current ? -1 : 1);
    dxRef.current = 0;
    dyRef.current = 0;
    return { dx, dy, tiltX: tiltXRef.current };
  }, []);

  const reset = useCallback(() => {
    dxRef.current = 0;
    dyRef.current = 0;
  }, []);

  return useMemo(
    () => ({
      locked,
      dragging,
      tiltPermission,
      tiltActive,
      requestLock,
      release,
      requestTilt,
      onDragStart,
      onDragMove,
      onDragEnd,
      drain,
      reset,
    }),
    [
      locked,
      dragging,
      tiltPermission,
      tiltActive,
      requestLock,
      release,
      requestTilt,
      onDragStart,
      onDragMove,
      onDragEnd,
      drain,
      reset,
    ],
  );
}
