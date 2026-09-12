"use client";

import { DEFAULT_SETTINGS, type Settings } from "@/lib/settings";

function GearIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path
        fill="currentColor"
        d="M19.4 13a7.8 7.8 0 0 0 0-2l2-1.6a.5.5 0 0 0 .1-.6l-1.9-3.2a.5.5 0 0 0-.6-.2l-2.4 1a7.4 7.4 0 0 0-1.7-1l-.4-2.5a.5.5 0 0 0-.5-.4h-3.8a.5.5 0 0 0-.5.4l-.4 2.5a7.4 7.4 0 0 0-1.7 1l-2.4-1a.5.5 0 0 0-.6.2L2.5 8.8a.5.5 0 0 0 .1.6L4.6 11a7.8 7.8 0 0 0 0 2l-2 1.6a.5.5 0 0 0-.1.6l1.9 3.2a.5.5 0 0 0 .6.2l2.4-1a7.4 7.4 0 0 0 1.7 1l.4 2.5a.5.5 0 0 0 .5.4h3.8a.5.5 0 0 0 .5-.4l.4-2.5a7.4 7.4 0 0 0 1.7-1l2.4 1a.5.5 0 0 0 .6-.2l1.9-3.2a.5.5 0 0 0-.1-.6ZM12 15.5A3.5 3.5 0 1 1 15.5 12 3.5 3.5 0 0 1 12 15.5Z"
      />
    </svg>
  );
}

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="setting-row">
      <span className="setting-label">
        {label}
        {hint && <span className="setting-hint">{hint}</span>}
      </span>
      <span className="setting-control">{children}</span>
    </label>
  );
}

export function SettingsPanel({
  open,
  settings,
  tiltSupported,
  onToggle,
  onChange,
  onTiltChange,
  onReset,
}: {
  open: boolean;
  settings: Settings;
  tiltSupported: boolean;
  onToggle: () => void;
  onChange: (patch: Partial<Settings>) => void;
  /** Separate because enabling tilt may need an OS permission prompt. */
  onTiltChange: (enabled: boolean) => void;
  onReset: () => void;
}) {
  return (
    <div className="settings-root">
      <button
        className={`settings-gear ${open ? "is-open" : ""}`}
        onClick={onToggle}
        aria-label="Settings"
        aria-expanded={open}
        title="Settings"
      >
        <GearIcon />
      </button>

      {open && (
        <div className="settings-panel" role="dialog" aria-label="Settings">
          <p className="settings-title">SETTINGS</p>

          <Row label="Loop length" hint={`${settings.loopSeconds}s`}>
            <input
              type="range"
              min={30}
              max={120}
              step={5}
              value={settings.loopSeconds}
              onChange={(e) => onChange({ loopSeconds: Number(e.target.value) })}
            />
          </Row>

          <Row
            label="Move speed"
            hint={
              ["walk", "brisk", "fast", "run"][settings.moveSpeed - 1] ?? "fast"
            }
          >
            <input
              type="range"
              min={1}
              max={4}
              step={1}
              value={settings.moveSpeed}
              onChange={(e) =>
                onChange({ moveSpeed: Number(e.target.value) as 1 | 2 | 3 | 4 })
              }
            />
          </Row>

          <Row label="Head bob" hint="walking gait">
            <input
              type="checkbox"
              checked={settings.headBob}
              onChange={(e) => onChange({ headBob: e.target.checked })}
            />
          </Row>

          <Row label="Show your hands" hint="first-person arms">
            <input
              type="checkbox"
              checked={settings.showHands}
              onChange={(e) => onChange({ showHands: e.target.checked })}
            />
          </Row>

          <div className="settings-divider" />

          <Row label="Sound" hint="footsteps + room tone">
            <input
              type="checkbox"
              checked={settings.soundEnabled}
              onChange={(e) => onChange({ soundEnabled: e.target.checked })}
            />
          </Row>

          {settings.soundEnabled && (
            <Row label="Volume" hint={`${Math.round(settings.volume * 100)}%`}>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={settings.volume}
                onChange={(e) => onChange({ volume: Number(e.target.value) })}
              />
            </Row>
          )}

          <Row
            label="Mouse sensitivity"
            hint={settings.mouseSensitivity.toFixed(1)}
          >
            <input
              type="range"
              min={0.2}
              max={3}
              step={0.1}
              value={settings.mouseSensitivity}
              onChange={(e) =>
                onChange({ mouseSensitivity: Number(e.target.value) })
              }
            />
          </Row>

          <Row label="Invert look Y">
            <input
              type="checkbox"
              checked={settings.invertY}
              onChange={(e) => onChange({ invertY: e.target.checked })}
            />
          </Row>

          <Row label="Turn speed" hint={`${settings.lookSpeedDeg.toFixed(1)}°`}>
            <input
              type="range"
              min={1}
              max={15}
              step={0.5}
              value={settings.lookSpeedDeg}
              onChange={(e) => onChange({ lookSpeedDeg: Number(e.target.value) })}
            />
          </Row>

          <Row label="On-screen controls" hint={settings.touchControls}>
            <select
              value={settings.touchControls}
              onChange={(e) =>
                onChange({
                  touchControls: e.target.value as Settings["touchControls"],
                })
              }
            >
              <option value="auto">auto</option>
              <option value="on">always</option>
              <option value="off">never</option>
            </select>
          </Row>

          {tiltSupported && (
            <>
              <Row label="Tilt to steer" hint="phone only">
                <input
                  type="checkbox"
                  checked={settings.tiltEnabled}
                  onChange={(e) => onTiltChange(e.target.checked)}
                />
              </Row>
              {settings.tiltEnabled && (
                <Row
                  label="Tilt sensitivity"
                  hint={settings.tiltSensitivity.toFixed(1)}
                >
                  <input
                    type="range"
                    min={0.2}
                    max={3}
                    step={0.1}
                    value={settings.tiltSensitivity}
                    onChange={(e) =>
                      onChange({ tiltSensitivity: Number(e.target.value) })
                    }
                  />
                </Row>
              )}
            </>
          )}

          <div className="settings-divider" />

          <Row label="Hints">
            <input
              type="checkbox"
              checked={settings.hintsEnabled}
              onChange={(e) => onChange({ hintsEnabled: e.target.checked })}
            />
          </Row>

          <Row label="Wall feedback" hint="stops you walking through">
            <input
              type="checkbox"
              checked={settings.collisionFeedback}
              onChange={(e) =>
                onChange({ collisionFeedback: e.target.checked })
              }
            />
          </Row>

          <Row label="Key from loop" hint={`loop ${settings.keyMinLoop}`}>
            <input
              type="range"
              min={1}
              max={4}
              step={1}
              value={settings.keyMinLoop}
              onChange={(e) => onChange({ keyMinLoop: Number(e.target.value) })}
            />
          </Row>

          <Row
            label="Searches to find"
            hint={`${settings.keySearchIndex}`}
          >
            <input
              type="range"
              min={1}
              max={4}
              step={1}
              value={settings.keySearchIndex}
              onChange={(e) =>
                onChange({ keySearchIndex: Number(e.target.value) })
              }
            />
          </Row>

          <div className="settings-divider" />

          <Row label="Debug panel" hint="or press `">
            <input
              type="checkbox"
              checked={settings.showDebug}
              onChange={(e) => onChange({ showDebug: e.target.checked })}
            />
          </Row>

          <div className="settings-footer">
            <button onClick={onReset} disabled={
              JSON.stringify(settings) === JSON.stringify(DEFAULT_SETTINGS)
            }>
              reset to defaults
            </button>
            <span>loop length applies next loop</span>
          </div>
        </div>
      )}
    </div>
  );
}
