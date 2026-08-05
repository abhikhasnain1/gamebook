import { AlertTriangle, Trash2, X } from "lucide-react";
import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import type { TrashImpact } from "../lib/native";

interface TrashImpactDialogProps {
  impact: TrashImpact;
  onCancel: () => void;
  onConfirm: () => void;
}

export function TrashImpactDialog({ impact, onCancel, onConfirm }: TrashImpactDialogProps) {
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
        return;
      }
      if (event.key !== "Tab") return;
      const controls = dialogRef.current?.querySelectorAll<HTMLElement>(
        "button:not(:disabled), [tabindex]:not([tabindex='-1'])",
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
  }, [onCancel]);

  return createPortal(
    <div className="modal-backdrop">
      <section
        ref={dialogRef}
        className="confirm-dialog trash-impact-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
      >
        <button type="button" className="dialog-close" aria-label="Cancel deletion" onClick={onCancel}><X /></button>
        <h2 id={titleId}>{impact.blocked ? "Cannot move to Trash" : "Move to Project Trash?"}</h2>
        <p id={descriptionId}>
          {impact.blocked
            ? "Remove the listed dependencies before deleting this content."
            : `${impact.affected.length} record${impact.affected.length === 1 ? "" : "s"} will move as one restorable transaction.`}
        </p>
        <section aria-labelledby={`${titleId}-affected`}>
          <h3 id={`${titleId}-affected`}>Affected records</h3>
          <ul className="impact-list">
            {impact.affected.map((item) => (
              <li key={`${item.recordType}:${item.recordId}`}>
                <span>{item.label}</span>
                <small>{item.recordType.replaceAll("-", " ")}</small>
              </li>
            ))}
          </ul>
        </section>
        {impact.blockers.length > 0 && (
          <section className="trash-blockers" aria-labelledby={`${titleId}-blockers`}>
            <h3 id={`${titleId}-blockers`}><AlertTriangle /> Dependencies</h3>
            <ul className="impact-list">
              {impact.blockers.map((item) => (
                <li key={`${item.kind}:${item.recordType}:${item.recordId}`}>
                  <span>{item.label}</span>
                  <small>{item.kind.replaceAll("-", " ")}</small>
                </li>
              ))}
            </ul>
          </section>
        )}
        <div className="dialog-actions">
          <button ref={cancelRef} type="button" onClick={onCancel}>
            {impact.blocked ? "Close" : "Cancel"}
          </button>
          {!impact.blocked && (
            <button type="button" className="danger-command" onClick={onConfirm}>
              <Trash2 /> Move to Trash
            </button>
          )}
        </div>
      </section>
    </div>,
    document.body,
  );
}
