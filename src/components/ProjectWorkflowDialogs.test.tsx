import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { expectNoSeriousOrCriticalA11yIssues } from "../test/a11y";
import { ProjectReportDialog } from "./ProjectReportDialog";
import { ProjectStorageDialog } from "./ProjectStorageDialog";
import { SaveConflictDialog } from "./SaveConflictDialog";

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
        onRecover={onRecover}
        onOpenSaved={vi.fn()}
        onCleanCache={onCleanCache}
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
});
