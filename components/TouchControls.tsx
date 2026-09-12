"use client";

import { useCallback, useRef, useState } from "react";

// Left thumbstick drives movement; the rest of the screen is a look pad handled
// by the parent. Everything is pointer-events based so it works with touch,
// pen, and a mouse on a small screen.

const STICK_RADIUS = 56;

export type MoveVector = { x: number; y: number };

export function TouchControls({
  onMove,
  onInteract,
  interactLabel,
  lookHandlers,
  showTiltButton,
  tiltOn,
  onToggleTilt,
}: {
  onMove: (vector: MoveVector) => void;
  onInteract: () => void;
  interactLabel: string;
  lookHandlers: {
    onPointerDown: (event: React.PointerEvent) => void;
    onPointerMove: (event: React.PointerEvent) => void;
    onPointerUp: (event: React.PointerEvent) => void;
  };
  showTiltButton: boolean;
  tiltOn: boolean;
  onToggleTilt: () => void;
}) {
  const baseRef = useRef<HTMLDivElement>(null);
  const pointerRef = useRef<number | null>(null);
  const [knob, setKnob] = useState<MoveVector>({ x: 0, y: 0 });

  const updateFromEvent = useCallback(
    (event: React.PointerEvent) => {
      const base = baseRef.current;
      if (!base) return;
      const rect = base.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      let dx = event.clientX - cx;
      let dy = event.clientY - cy;
      const distance = Math.hypot(dx, dy);
      if (distance > STICK_RADIUS) {
        dx = (dx / distance) * STICK_RADIUS;
        dy = (dy / distance) * STICK_RADIUS;
      }
      setKnob({ x: dx, y: dy });
      // Screen y grows downward; forward is negative y.
      onMove({ x: dx / STICK_RADIUS, y: -dy / STICK_RADIUS });
    },
    [onMove],
  );

  const onStickDown = useCallback(
    (event: React.PointerEvent) => {
      event.preventDefault();
      event.stopPropagation();
      pointerRef.current = event.pointerId;
      try {
        (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
      } catch {
        // Non-fatal.
      }
      updateFromEvent(event);
    },
    [updateFromEvent],
  );

  const onStickMove = useCallback(
    (event: React.PointerEvent) => {
      if (pointerRef.current !== event.pointerId) return;
      event.preventDefault();
      event.stopPropagation();
      updateFromEvent(event);
    },
    [updateFromEvent],
  );

  const onStickUp = useCallback(
    (event: React.PointerEvent) => {
      if (pointerRef.current !== event.pointerId) return;
      event.stopPropagation();
      pointerRef.current = null;
      setKnob({ x: 0, y: 0 });
      onMove({ x: 0, y: 0 });
    },
    [onMove],
  );

  return (
    <div className="touch-controls">
      {/* The look pad sits behind the widgets and covers the whole screen. */}
      <div
        className="touch-look-pad"
        onPointerDown={lookHandlers.onPointerDown}
        onPointerMove={lookHandlers.onPointerMove}
        onPointerUp={lookHandlers.onPointerUp}
        onPointerCancel={lookHandlers.onPointerUp}
      />

      <div
        ref={baseRef}
        className="touch-stick"
        onPointerDown={onStickDown}
        onPointerMove={onStickMove}
        onPointerUp={onStickUp}
        onPointerCancel={onStickUp}
      >
        <span className="touch-stick-ring" />
        <span
          className="touch-stick-knob"
          style={{ transform: `translate(${knob.x}px, ${knob.y}px)` }}
        />
        <span className="touch-stick-label">MOVE</span>
      </div>

      <div className="touch-actions">
        {showTiltButton && (
          <button
            className={`touch-tilt ${tiltOn ? "is-on" : ""}`}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={onToggleTilt}
          >
            TILT {tiltOn ? "ON" : "OFF"}
          </button>
        )}
        <button
          className="touch-interact"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={onInteract}
        >
          {interactLabel}
        </button>
      </div>
    </div>
  );
}
