import { X } from "lucide-react";
import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import type { ProjectV2RecoverySummary } from "../lib/native";

interface ProjectStorageDialogProps {
  recovery: ProjectV2RecoverySummary[];
  onRecover: (workspaceId: string) => void;
  onOpenSaved: () => void;
  onCleanCache: () => void;
  onClose: () => void;
}

export function ProjectStorageDialog({
  recovery,
  onRecover,
  onOpenSaved,
  onCleanCache,
  onClose,
}: ProjectStorageDialogProps) {
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
        "button:not(:disabled), [href], [tabindex]:not([tabindex='-1'])",
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
        className="confirm-dialog project-storage-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
      >
        <button
          ref={closeRef}
          type="button"
          className="dialog-close"
          aria-label="Close project storage"
          onClick={onClose}
        >
          <X />
        </button>
        <h2 id={titleId}>Project storage</h2>
        <p id={descriptionId}>
          Recover protected workspaces or clear verified cache files that can be recreated.
        </p>
        <section className="storage-section" aria-labelledby={`${titleId}-recovery`}>
          <h3 id={`${titleId}-recovery`}>Recovery</h3>
          {recovery.length === 0 ? (
            <p>No recoverable workspaces.</p>
          ) : (
            <ul className="recovery-list">
              {recovery.map((summary, index) => {
                const unsaved = summary.protectedClasses?.includes("unsaved");
                return (
                  <li key={summary.workspaceId}>
                    <span>Project {index + 1}: {summary.state.replaceAll("-", " ")}</span>
                    <button
                      type="button"
                      onClick={() =>
                        unsaved ? onRecover(summary.workspaceId) : onOpenSaved()
                      }
                    >
                      {unsaved ? "Recover" : "Open project"}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
        <section className="storage-section" aria-labelledby={`${titleId}-cache`}>
          <h3 id={`${titleId}-cache`}>Clean cache</h3>
          <p>Protected unsaved and recovery data is never removed by this action.</p>
          <button type="button" onClick={onCleanCache}>Clear clean cache</button>
        </section>
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>Close</button>
        </div>
      </section>
    </div>,
    document.body,
  );
}
