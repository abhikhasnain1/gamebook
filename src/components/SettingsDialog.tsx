import { Download, MonitorPlay, RotateCcw, Upload, X } from "lucide-react";
import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { GlobalSettings, SettingsNotice } from "../lib/native";

interface SettingsDialogProps {
  settings: GlobalSettings;
  notices: SettingsNotice[];
  writeProtected: boolean;
  onSave: (settings: GlobalSettings) => void;
  onImport: () => void;
  onExport: () => void;
  onReset: () => void;
  onPreviewHud: (capture: GlobalSettings["capture"]) => Promise<string>;
  onClose: () => void;
}

const SYSTEM_AUDIO_DISCLOSURE_VERSION = "whole-system-audio-v1";
const MICROPHONE_CONSENT_VERSION = "microphone-capture-v1";

export function SettingsDialog({
  settings,
  notices,
  writeProtected,
  onSave,
  onImport,
  onExport,
  onReset,
  onPreviewHud,
  onClose,
}: SettingsDialogProps) {
  const [draft, setDraft] = useState(() => structuredClone(settings));
  const [previewMessage, setPreviewMessage] = useState("");
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const restoreRef = useRef(document.activeElement as HTMLElement | null);
  const shortcutConflict = shortcutIdentity(draft.shortcuts.screenshot)
    === shortcutIdentity(draft.shortcuts.video);

  useEffect(() => {
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const controls = dialogRef.current?.querySelectorAll<HTMLElement>(
        "button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex='-1'])",
      );
      if (!controls?.length) return;
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      restoreRef.current?.focus({ preventScroll: true });
    };
  }, [onClose]);

  return createPortal(
    <div className="modal-backdrop">
      <section
        ref={dialogRef}
        className="confirm-dialog settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
      >
        <button ref={closeRef} type="button" className="dialog-close" aria-label="Close settings" onClick={onClose}>
          <X />
        </button>
        <h2 id={titleId}>Settings</h2>
        <p id={descriptionId}>Global Gamebook preferences</p>

        {notices.length > 0 && (
          <div className="settings-notices" role="status" aria-live="polite">
            {notices.map((notice) => <p key={`${notice.code}-${notice.field}`}>{notice.message}</p>)}
          </div>
        )}

        <div className="settings-sections">
          <fieldset disabled={writeProtected}>
            <legend>Recording</legend>
            <label>
              Capture target
              <select
                value={draft.capture.target}
                onChange={(event) => setDraft((current) => ({
                  ...current,
                  capture: {
                    ...current.capture,
                    target: event.target.value as GlobalSettings["capture"]["target"],
                  },
                }))}
              >
                <option value="monitor-under-pointer">Monitor under pointer</option>
                <option value="selected-monitor">Selected monitor</option>
                <option value="selected-window">Selected window</option>
              </select>
            </label>
            <label>
              Duration (seconds)
              <input
                type="number"
                min="5"
                max="300"
                step="1"
                value={draft.capture.durationSeconds}
                onChange={(event) => setDraft((current) => ({
                  ...current,
                  capture: { ...current.capture, durationSeconds: Number(event.target.value) },
                }))}
              />
            </label>
            <label>
              Frame rate
              <select
                value={draft.capture.frameRateCap}
                onChange={(event) => setDraft((current) => ({
                  ...current,
                  capture: {
                    ...current.capture,
                    frameRateCap: Number(event.target.value) as 30 | 60,
                  },
                }))}
              >
                <option value="30">30 FPS</option>
                <option value="60" disabled>60 FPS (not qualified)</option>
              </select>
            </label>
            <label className="checkbox-setting">
              <input
                type="checkbox"
                checked={draft.capture.includeCursor}
                onChange={(event) => setDraft((current) => ({
                  ...current,
                  capture: { ...current.capture, includeCursor: event.target.checked },
                }))}
              />
              Include cursor
            </label>
            <label className="checkbox-setting">
              <input
                type="checkbox"
                checked={draft.capture.includeSystemAudio}
                onChange={(event) => setDraft((current) => ({
                  ...current,
                  capture: { ...current.capture, includeSystemAudio: event.target.checked },
                }))}
              />
              System audio
            </label>
            <p className="settings-disclosure">
              Records the complete output-device mix, including notifications, voice chat, browsers, music, and other applications.
            </p>
            <label className="checkbox-setting settings-consent">
              <input
                type="checkbox"
                checked={draft.capture.systemAudioDisclosureVersion === SYSTEM_AUDIO_DISCLOSURE_VERSION}
                onChange={(event) => setDraft((current) => ({
                  ...current,
                  capture: {
                    ...current.capture,
                    systemAudioDisclosureVersion: event.target.checked
                      ? SYSTEM_AUDIO_DISCLOSURE_VERSION
                      : null,
                  },
                }))}
              />
              Acknowledge system-audio disclosure
            </label>
            <label className="checkbox-setting settings-consent">
              <input
                type="checkbox"
                checked={draft.capture.microphoneConsentVersion === MICROPHONE_CONSENT_VERSION}
                onChange={(event) => setDraft((current) => ({
                  ...current,
                  capture: {
                    ...current.capture,
                    includeMicrophone: event.target.checked
                      ? current.capture.includeMicrophone
                      : false,
                    microphoneConsentVersion: event.target.checked
                      ? MICROPHONE_CONSENT_VERSION
                      : null,
                  },
                }))}
              />
              Consent to microphone capture
            </label>
            <label className="checkbox-setting">
              <input
                type="checkbox"
                checked={draft.capture.includeMicrophone}
                disabled={draft.capture.microphoneConsentVersion !== MICROPHONE_CONSENT_VERSION}
                onChange={(event) => setDraft((current) => ({
                  ...current,
                  capture: { ...current.capture, includeMicrophone: event.target.checked },
                }))}
              />
              Microphone
            </label>
            <button
              type="button"
              className="settings-preview-command"
              onClick={() => {
                void onPreviewHud(draft.capture)
                  .then(setPreviewMessage)
                  .catch((error: unknown) => setPreviewMessage(String(error)));
              }}
            >
              <MonitorPlay /> Preview recording HUD
            </button>
            <output className="settings-preview-status" aria-live="polite">
              {previewMessage}
            </output>
          </fieldset>

          <fieldset disabled={writeProtected}>
            <legend>Shortcuts</legend>
            <ShortcutInput
              label="Screenshot shortcut"
              value={draft.shortcuts.screenshot}
              onChange={(value) => setDraft((current) => ({
                ...current,
                shortcuts: { ...current.shortcuts, screenshot: value },
              }))}
            />
            <ShortcutInput
              label="Video shortcut"
              value={draft.shortcuts.video}
              onChange={(value) => setDraft((current) => ({
                ...current,
                shortcuts: { ...current.shortcuts, video: value },
              }))}
            />
            <p className="settings-shortcut-help">Focus a shortcut field, then press a modifier and one key.</p>
            {shortcutConflict && (
              <p className="settings-field-error" role="alert">
                Screenshot and video shortcuts must be different.
              </p>
            )}
          </fieldset>

          <fieldset disabled={writeProtected}>
            <legend>Playback</legend>
            <label className="checkbox-setting">
              <input
                type="checkbox"
                checked={draft.playback.autoplay}
                onChange={(event) => setDraft((current) => ({
                  ...current,
                  playback: { ...current.playback, autoplay: event.target.checked },
                }))}
              />
              Autoplay media
            </label>
            <label>
              Volume
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={draft.playback.volume}
                onChange={(event) => setDraft((current) => ({
                  ...current,
                  playback: { ...current.playback, volume: Number(event.target.value) },
                }))}
              />
              <output>{Math.round(draft.playback.volume * 100)}%</output>
            </label>
          </fieldset>

          <fieldset disabled={writeProtected}>
            <legend>Accessibility</legend>
            <label>
              Reduced motion
              <select
                value={draft.accessibility.reducedMotion}
                onChange={(event) => setDraft((current) => ({
                  ...current,
                  accessibility: {
                    ...current.accessibility,
                    reducedMotion: event.target.value as GlobalSettings["accessibility"]["reducedMotion"],
                  },
                }))}
              >
                <option value="system">Use Windows setting</option>
                <option value="reduce">Reduce motion</option>
                <option value="allow">Allow motion</option>
              </select>
            </label>
            <label>
              UI scale
              <select
                value={draft.accessibility.uiScalePercent}
                onChange={(event) => setDraft((current) => ({
                  ...current,
                  accessibility: {
                    ...current.accessibility,
                    uiScalePercent: Number(event.target.value) as 100 | 150 | 200,
                  },
                }))}
              >
                <option value="100">100%</option>
                <option value="150">150%</option>
                <option value="200">200%</option>
              </select>
            </label>
          </fieldset>

          <fieldset disabled={writeProtected}>
            <legend>Storage</legend>
            <label>
              Cache limit (GB)
              <input
                type="number"
                min="0"
                max="1024"
                step="1"
                value={Math.round(draft.storage.cacheLimitBytes / 1_073_741_824)}
                onChange={(event) => setDraft((current) => ({
                  ...current,
                  storage: {
                    ...current.storage,
                    cacheLimitBytes: Math.max(0, Number(event.target.value)) * 1_073_741_824,
                  },
                }))}
              />
            </label>
            <label>
              Trash retention (days)
              <input
                type="number"
                min="1"
                max="3650"
                value={draft.trash.retentionDays}
                onChange={(event) => setDraft((current) => ({
                  ...current,
                  trash: { ...current.trash, retentionDays: Number(event.target.value) },
                }))}
              />
            </label>
          </fieldset>

          <fieldset disabled={writeProtected}>
            <legend>Diagnostics</legend>
            <label className="checkbox-setting">
              <input
                type="checkbox"
                checked={draft.diagnostics.localLogging}
                onChange={(event) => setDraft((current) => ({
                  ...current,
                  diagnostics: { ...current.diagnostics, localLogging: event.target.checked },
                }))}
              />
              Local diagnostic logging
            </label>
          </fieldset>
        </div>

        <div className="settings-file-actions" aria-label="Settings file actions">
          <button type="button" onClick={onImport} disabled={writeProtected}><Upload /> Import</button>
          <button type="button" onClick={onExport}><Download /> Export</button>
          <button type="button" onClick={onReset} disabled={writeProtected}><RotateCcw /> Reset</button>
        </div>
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="button" onClick={() => onSave(draft)} disabled={writeProtected || shortcutConflict}>Save settings</button>
        </div>
      </section>
    </div>,
    document.body,
  );
}

interface ShortcutInputProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
}

function ShortcutInput({ label, value, onChange }: ShortcutInputProps) {
  function capture(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (["Control", "Shift", "Alt", "Meta"].includes(event.key)) return;
    if (!event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey) return;
    const key = shortcutKey(event.code);
    if (!key) return;
    event.preventDefault();
    event.stopPropagation();
    const parts = [
      event.ctrlKey ? "Ctrl" : "",
      event.shiftKey ? "Shift" : "",
      event.altKey ? "Alt" : "",
      event.metaKey ? "Windows" : "",
      key,
    ].filter(Boolean);
    onChange(parts.join("+"));
  }

  return (
    <label>
      {label}
      <input
        type="text"
        value={value}
        readOnly
        spellCheck={false}
        autoComplete="off"
        onKeyDown={capture}
      />
    </label>
  );
}

function shortcutKey(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F(?:[1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  const named: Record<string, string> = {
    ArrowDown: "ArrowDown",
    ArrowLeft: "ArrowLeft",
    ArrowRight: "ArrowRight",
    ArrowUp: "ArrowUp",
    Backquote: "Backquote",
    Comma: "Comma",
    Equal: "Equal",
    Minus: "Minus",
    Period: "Period",
    Semicolon: "Semicolon",
    Slash: "Slash",
    Space: "Space",
  };
  return named[code] ?? null;
}

function shortcutIdentity(value: string): string {
  const aliases: Record<string, string> = {
    control: "ctrl",
    cmd: "windows",
    command: "windows",
    meta: "windows",
    super: "windows",
  };
  const parts = value
    .toLowerCase()
    .split("+")
    .map((part) => aliases[part.trim()] ?? part.trim())
    .filter(Boolean);
  const key = parts.pop() ?? "";
  return `${parts.sort().join("+")}+${key}`;
}
