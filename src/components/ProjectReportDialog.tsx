import { X } from "lucide-react";
import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import type { ProjectReportState } from "../hooks/useProjectV2";

interface ProjectReportDialogProps {
  state: ProjectReportState;
  onClose: () => void;
}

export function ProjectReportDialog({ state, onClose }: ProjectReportDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const restoreRef = useRef(document.activeElement as HTMLElement | null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      } else if (event.key === "Tab") {
        const controls = dialogRef.current?.querySelectorAll<HTMLElement>(
          "button:not(:disabled), [href], input:not(:disabled), [tabindex]:not([tabindex='-1'])",
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
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      restoreRef.current?.focus({ preventScroll: true });
    };
  }, [onClose]);

  const content = reportContent(state);
  return createPortal(
    <div className="modal-backdrop">
      <section
        ref={dialogRef}
        className="confirm-dialog project-report-dialog"
        role={content.assertive ? "alertdialog" : "dialog"}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
      >
        <button
          ref={closeRef}
          type="button"
          className="dialog-close"
          aria-label="Close project report"
          data-tooltip="Close report"
          onClick={onClose}
        >
          <X />
        </button>
        <h2 id={titleId}>{content.title}</h2>
        <p id={descriptionId}>{content.description}</p>
        {content.summary.length > 0 && (
          <dl className="report-summary">
            {content.summary.map(([term, detail]) => (
              <div key={term}>
                <dt>{term}</dt>
                <dd>{detail}</dd>
              </div>
            ))}
          </dl>
        )}
        {content.messages.length > 0 && (
          <div className="report-messages">
            <h3>Details</h3>
            <ul>
              {content.messages.map((message, index) => (
                <li key={`${message.code}-${index}`}>
                  <strong>{severityLabel(message.severity)}</strong>
                  <span>{message.detail}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>Close</button>
        </div>
      </section>
    </div>,
    document.body,
  );
}

function reportContent(state: ProjectReportState) {
  if (state.kind === "future-version") {
    return {
      title: "Newer project version",
      description:
        "This project requires a newer Gamebook version. The file was not changed and no workspace was created.",
      summary: [] as Array<[string, string]>,
      messages: [],
      assertive: true,
    };
  }
  if (state.kind === "migration") {
    const report = state.report;
    return {
      title: "Version 1 project migrated",
      description:
        "The project opened in a protected version 2 workspace. Its original file remains unchanged until you save.",
      summary: [
        ["Source", report.sourceFormat === "gzip-json-v1" ? "Compressed version 1" : "Plain JSON version 1"],
        ["Pages checked", String(report.pageResults.length)],
        ["Source images", report.assetResults.every((result) => isByteIdentical(result)) ? "Byte-identical" : "Review required"],
        ["Render comparison", `${(report.renderDiff.pixelsOverThresholdRatio * 100).toFixed(4)}% pixels over threshold`],
        ["First save", "Creates a collision-safe version 1 backup when replacing the source"],
      ] as Array<[string, string]>,
      messages: report.messages,
      assertive: false,
    };
  }
  const report = state.report;
  return {
    title: report.status === "recoverable" ? "Project repair report" : "Project could not be opened",
    description:
      report.status === "recoverable"
        ? "Valid content was inspected without changing the source. Review the report before deciding how to proceed."
        : "Gamebook inspected the source without changing it or inventing replacement content.",
    summary: [
      ["Status", report.status.replaceAll("-", " ")],
      ["Valid records", String(report.validRecordIds.length)],
      ["Invalid records", String(report.invalidRecordIds.length)],
      ["Missing assets", String(report.missingAssetDigests.length)],
    ] as Array<[string, string]>,
    messages: report.messages,
    assertive: report.status !== "recoverable",
  };
}

function isByteIdentical(value: unknown): boolean {
  return typeof value === "object" && value !== null &&
    (value as { byteIdentical?: unknown }).byteIdentical === true;
}

function severityLabel(severity: "info" | "warning" | "error"): string {
  if (severity === "error") return "Error";
  if (severity === "warning") return "Warning";
  return "Information";
}
