import { Download, RotateCcw, Upload, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
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
  onClose: () => void;
}

export function SettingsDialog({
  settings,
  notices,
  writeProtected,
  onSave,
  onImport,
  onExport,
  onReset,
  onClose,
}: SettingsDialogProps) {
  const [draft, setDraft] = useState(() => structuredClone(settings));
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const restoreRef = useRef(document.activeElement as HTMLElement | null);

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
          <button type="button" onClick={() => onSave(draft)} disabled={writeProtected}>Save settings</button>
        </div>
      </section>
    </div>,
    document.body,
  );
}
