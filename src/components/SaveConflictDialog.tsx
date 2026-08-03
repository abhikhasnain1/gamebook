import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";

interface SaveConflictDialogProps {
  onCancel: () => void;
  onSaveAs: () => void;
  onReplace: () => void;
}

export function SaveConflictDialog({
  onCancel,
  onSaveAs,
  onReplace,
}: SaveConflictDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const restoreRef = useRef(document.activeElement as HTMLElement | null);

  useEffect(() => {
    cancelRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
      } else if (event.key === "Tab") {
        const controls = dialogRef.current?.querySelectorAll<HTMLButtonElement>("button");
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
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      restoreRef.current?.focus({ preventScroll: true });
    };
  }, [onCancel]);

  return createPortal(
    <div className="modal-backdrop">
      <section
        ref={dialogRef}
        className="confirm-dialog save-conflict-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
      >
        <h2 id={titleId}>Project changed outside Gamebook</h2>
        <p id={descriptionId}>
          The file changed after it was opened. Choose a new file, replace the changed file explicitly, or cancel and keep this workspace recoverable.
        </p>
        <div className="dialog-actions conflict-actions">
          <button ref={cancelRef} type="button" onClick={onCancel}>Cancel</button>
          <button type="button" onClick={onSaveAs}>Save As</button>
          <button type="button" className="danger-command" onClick={onReplace}>Replace changed file</button>
        </div>
      </section>
    </div>,
    document.body,
  );
}
