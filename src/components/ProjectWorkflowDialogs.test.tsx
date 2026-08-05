import { fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { expectNoSeriousOrCriticalA11yIssues } from "../test/a11y";
import { ProjectReportDialog } from "./ProjectReportDialog";
import { ConfirmDialog } from "./ConfirmDialog";
import { ProjectStorageDialog } from "./ProjectStorageDialog";
import { SettingsDialog } from "./SettingsDialog";
import { SaveConflictDialog } from "./SaveConflictDialog";
import { TrashImpactDialog } from "./TrashImpactDialog";
import { defaultBrowserSettings } from "../hooks/useGlobalSettings";

describe("project workflow dialogs", () => {
  it("announces future-version rejection, traps focus, and restores the invoker", async () => {
    const invoker = document.createElement("button");
    invoker.textContent = "Open report";
    document.body.append(invoker);
    invoker.focus();
    const onClose = vi.fn();
    const { unmount } = render(
      <ProjectReportDialog state={{ kind: "future-version" }} onClose={onClose} />,
    );

    const dialog = screen.getByRole("alertdialog", { name: "Newer project version" });
    expect(dialog).toHaveTextContent("file was not changed");
    expect(screen.getByRole("button", { name: "Close project report" })).toHaveFocus();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
    await expectNoSeriousOrCriticalA11yIssues(document.body);
    unmount();
    expect(invoker).toHaveFocus();
    invoker.remove();
  });

  it("offers cancel, Save As, and explicit replacement for external changes", async () => {
    const onCancel = vi.fn();
    const onSaveAs = vi.fn();
    const onReplace = vi.fn();
    render(
      <SaveConflictDialog
        onCancel={onCancel}
        onSaveAs={onSaveAs}
        onReplace={onReplace}
      />,
    );

    expect(screen.getByRole("alertdialog", { name: /changed outside/i })).toBeVisible();
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Save As" }));
    fireEvent.click(screen.getByRole("button", { name: "Replace changed file" }));
    expect(onSaveAs).toHaveBeenCalledOnce();
    expect(onReplace).toHaveBeenCalledOnce();
    await expectNoSeriousOrCriticalA11yIssues(document.body);
  });

  it("exposes unsaved recovery and verified clean-cache actions", async () => {
    const onRecover = vi.fn();
    const onCleanCache = vi.fn();
    render(
      <ProjectStorageDialog
        recovery={[
          {
            workspaceId: "workspace-alpha",
            projectId: "project-alpha",
            state: "recovery-pending",
            protectedClasses: ["unsaved", "recovery"],
          },
        ]}
        trash={{
          transactions: [
            {
              transactionId: "trash-transaction-alpha",
              deletedAt: "2026-08-03T00:00:00Z",
              eligibleAfter: "2026-09-02T00:00:00Z",
              eligible: false,
              records: [
                {
                  trashId: "trash-alpha",
                  originalRecordType: "page",
                  originalRecordId: "page-alpha",
                  title: "Page 1",
                },
              ],
            },
          ],
          totalRecords: 1,
          eligibleTransactions: 0,
          retainedAssetBytes: 2048,
        }}
        onRecover={onRecover}
        onOpenSaved={vi.fn()}
        onCleanCache={onCleanCache}
        onRestoreTrash={vi.fn()}
        onEmptyEligibleTrash={vi.fn()}
        onEmptyAllTrash={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByRole("dialog", { name: "Project storage" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Recover" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear clean cache" }));
    expect(onRecover).toHaveBeenCalledWith("workspace-alpha");
    expect(onCleanCache).toHaveBeenCalledOnce();
    await expectNoSeriousOrCriticalA11yIssues(document.body);
  });

  it("edits versioned settings with named native file actions", async () => {
    const onSave = vi.fn();
    const onImport = vi.fn();
    render(
      <SettingsDialog
        settings={defaultBrowserSettings()}
        writeProtected={false}
        notices={[
          {
            code: "settings-field-defaulted",
            field: "playback.volume",
            message: "Invalid playback.volume was replaced with its default.",
          },
        ]}
        onSave={onSave}
        onImport={onImport}
        onExport={vi.fn()}
        onReset={vi.fn()}
        onPreviewHud={vi.fn().mockResolvedValue("The protected recording HUD is active.")}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByRole("dialog", { name: "Settings" })).toBeVisible();
    fireEvent.change(screen.getByLabelText("Trash retention (days)"), {
      target: { value: "45" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save settings/i }));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ trash: expect.objectContaining({ retentionDays: 45 }) }),
    );
    fireEvent.click(screen.getByRole("button", { name: /import/i }));
    expect(onImport).toHaveBeenCalledOnce();
    await expectNoSeriousOrCriticalA11yIssues(document.body);
  });

  it("disables settings mutation when a future settings file is protected", () => {
    render(
      <SettingsDialog
        settings={defaultBrowserSettings()}
        notices={[{
          code: "settings-future-version",
          field: null,
          message: "Settings from a newer Gamebook version were preserved.",
        }]}
        writeProtected
        onSave={vi.fn()}
        onImport={vi.fn()}
        onExport={vi.fn()}
        onReset={vi.fn()}
        onPreviewHud={vi.fn().mockResolvedValue("The protected recording HUD is active.")}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: /save settings/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /import/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /reset/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /export/i })).toBeEnabled();
  });

  it("edits recording settings with separate consent and captured shortcuts", async () => {
    const onSave = vi.fn();
    const onPreviewHud = vi.fn().mockResolvedValue(
      "Recording status moved to the Gamebook tray because visual HUD exclusion is not guaranteed for selected-window capture.",
    );
    render(
      <SettingsDialog
        settings={defaultBrowserSettings()}
        notices={[]}
        writeProtected={false}
        onSave={onSave}
        onImport={vi.fn()}
        onExport={vi.fn()}
        onReset={vi.fn()}
        onPreviewHud={onPreviewHud}
        onClose={vi.fn()}
      />,
    );

    const microphone = screen.getByRole("checkbox", { name: "Microphone" });
    expect(microphone).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "Consent to microphone capture" }));
    expect(microphone).toBeEnabled();
    fireEvent.click(microphone);
    fireEvent.click(screen.getByRole("checkbox", { name: "Acknowledge system-audio disclosure" }));
    fireEvent.change(screen.getByLabelText("Capture target"), {
      target: { value: "selected-window" },
    });
    fireEvent.keyDown(screen.getByLabelText("Video shortcut"), {
      key: "F10",
      code: "F10",
      ctrlKey: true,
      altKey: true,
    });
    expect(screen.getByLabelText("Video shortcut")).toHaveValue("Ctrl+Alt+F10");

    fireEvent.click(screen.getByRole("button", { name: "Preview recording HUD" }));
    expect(onPreviewHud).toHaveBeenCalledWith(
      expect.objectContaining({
        target: "selected-window",
        includeSystemAudio: true,
        includeMicrophone: true,
      }),
    );
    expect(await screen.findByText(/moved to the Gamebook tray/i)).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      capture: expect.objectContaining({
        target: "selected-window",
        includeMicrophone: true,
        systemAudioDisclosureVersion: "whole-system-audio-v1",
        microphoneConsentVersion: "microphone-capture-v1",
      }),
      shortcuts: expect.objectContaining({ video: "Ctrl+Alt+F10" }),
    }));
    await expectNoSeriousOrCriticalA11yIssues(document.body);
  });

  it("blocks duplicate screenshot and video shortcuts", () => {
    render(
      <SettingsDialog
        settings={defaultBrowserSettings()}
        notices={[]}
        writeProtected={false}
        onSave={vi.fn()}
        onImport={vi.fn()}
        onExport={vi.fn()}
        onReset={vi.fn()}
        onPreviewHud={vi.fn().mockResolvedValue("Preview ready")}
        onClose={vi.fn()}
      />,
    );

    fireEvent.keyDown(screen.getByLabelText("Screenshot shortcut"), {
      key: "F11",
      code: "F11",
      ctrlKey: true,
      shiftKey: true,
    });
    expect(screen.getByRole("alert")).toHaveTextContent("must be different");
    expect(screen.getByRole("button", { name: "Save settings" })).toBeDisabled();
  });

  it("restores destructive confirmation focus to a stable external control", () => {
    const restoreFocusTo = createRef<HTMLButtonElement>();
    const { rerender } = render(
      <>
        <button ref={restoreFocusTo}>Project storage</button>
        <ConfirmDialog
          title="Empty all Project Trash?"
          description="This removes all trashed records."
          confirmLabel="Empty all"
          restoreFocusTo={restoreFocusTo}
          onCancel={vi.fn()}
          onConfirm={vi.fn()}
        />
      </>,
    );

    rerender(<button ref={restoreFocusTo}>Project storage</button>);
    expect(restoreFocusTo.current).toHaveFocus();
  });

  it("announces Trash impact and blocks dependency-damaging confirmation", async () => {
    const onConfirm = vi.fn();
    const { rerender } = render(
      <TrashImpactDialog
        impact={{
          targets: [{ recordType: "evidence", recordId: "evidence-alpha" }],
          affected: [
            {
              kind: "target",
              recordType: "evidence",
              recordId: "evidence-alpha",
              label: "Screenshot 1",
            },
          ],
          blockers: [
            {
              kind: "finding-reference",
              recordType: "finding",
              recordId: "finding-alpha",
              label: "Input timing",
            },
          ],
          blocked: true,
          retainedAssetBytes: 1024,
        }}
        onCancel={vi.fn()}
        onConfirm={onConfirm}
      />,
    );
    expect(screen.getByRole("alertdialog", { name: "Cannot move to Trash" })).toBeVisible();
    expect(screen.queryByRole("button", { name: /move to trash/i })).not.toBeInTheDocument();

    rerender(
      <TrashImpactDialog
        impact={{
          targets: [{ recordType: "page", recordId: "page-alpha" }],
          affected: [
            { kind: "target", recordType: "page", recordId: "page-alpha", label: "Page 1" },
          ],
          blockers: [],
          blocked: false,
          retainedAssetBytes: 0,
        }}
        onCancel={vi.fn()}
        onConfirm={onConfirm}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /move to trash/i }));
    expect(onConfirm).toHaveBeenCalledOnce();
    await expectNoSeriousOrCriticalA11yIssues(document.body);
  });
});
