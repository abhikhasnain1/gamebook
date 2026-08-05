import { RotateCcw, Trash2, X } from "lucide-react";
import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import type { ProjectV2RecoverySummary, TrashState } from "../lib/native";

interface ProjectStorageDialogProps {
  recovery: ProjectV2RecoverySummary[];
  trash: TrashState;
  onRecover: (workspaceId: string) => void;
  onOpenSaved: () => void;
  onCleanCache: () => void;
  onRestoreTrash: (transactionId: string) => void;
  onEmptyEligibleTrash: () => void;
  onEmptyAllTrash: () => void;
  onClose: () => void;
}

export function ProjectStorageDialog({
  recovery,
  trash,
  onRecover,
  onOpenSaved,
  onCleanCache,
  onRestoreTrash,
  onEmptyEligibleTrash,
  onEmptyAllTrash,
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
        <section className="storage-section" aria-labelledby={`${titleId}-trash`}>
          <h3 id={`${titleId}-trash`}>Project Trash</h3>
          {trash.transactions.length === 0 ? (
            <p>Project Trash is empty.</p>
          ) : (
            <>
              <p role="status">
                {trash.totalRecords} record{trash.totalRecords === 1 ? "" : "s"}; {formatBytes(trash.retainedAssetBytes)} retained
              </p>
              <ul className="trash-transaction-list">
                {trash.transactions.map((transaction) => (
                  <li key={transaction.transactionId}>
                    <div>
                      <strong>{transaction.records.map((record) => record.title).join(", ")}</strong>
                      <small>
                        Deleted {formatDate(transaction.deletedAt)}; {transaction.eligible ? "eligible for cleanup" : `retained until ${formatDate(transaction.eligibleAfter)}`}
                      </small>
                    </div>
                    <button type="button" onClick={() => onRestoreTrash(transaction.transactionId)}>
                      <RotateCcw /> Restore
                    </button>
                  </li>
                ))}
              </ul>
              <div className="trash-actions">
                <button
                  type="button"
                  disabled={trash.eligibleTransactions === 0}
                  onClick={onEmptyEligibleTrash}
                >
                  <Trash2 /> Empty eligible
                </button>
                <button type="button" className="danger-command" onClick={onEmptyAllTrash}>
                  <Trash2 /> Empty all
                </button>
              </div>
            </>
          )}
        </section>
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>Close</button>
        </div>
      </section>
    </div>,
    document.body,
  );
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "unknown date" : date.toLocaleDateString();
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
