import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { expectNoSeriousOrCriticalA11yIssues } from "../test/a11y";
import { WorkspaceRecoveryHarness } from "./WorkspaceRecoveryHarness";

vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
  callback(0);
  return 1;
});

describe("WorkspaceRecoveryHarness", () => {
  it("separates a copied project without exposing its path", async () => {
    const user = userEvent.setup();
    const { container } = render(<WorkspaceRecoveryHarness />);
    await user.selectOptions(screen.getByRole("combobox", { name: "Workspace condition" }), "copy");
    await user.click(screen.getByRole("button", { name: "Open project" }));

    expect(screen.getByText("Separate workspace created")).toBeInTheDocument();
    expect(screen.getByText("Matching project bytes were detected at a different source location.")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("separate workspace");
    expect(screen.getByText("Hidden")).toBeInTheDocument();
    await expectNoSeriousOrCriticalA11yIssues(container);
  });

  it("focuses stale-lock recovery and preserves every recovery class", async () => {
    const user = userEvent.setup();
    render(<WorkspaceRecoveryHarness />);
    await user.selectOptions(screen.getByRole("combobox", { name: "Workspace condition" }), "stale");
    await user.click(screen.getByRole("button", { name: "Open project" }));

    const heading = screen.getByRole("heading", { name: "Recovery required" });
    expect(heading).toHaveFocus();
    expect(screen.getAllByText("Retained")).toHaveLength(2);
    expect(screen.getAllByText("Unchanged")).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "Recover workspace" }));
    expect(screen.getByRole("button", { name: "Open project" })).toHaveFocus();
    expect(screen.getByRole("status")).toHaveTextContent("without deleting recoverable work");
  });

  it("focuses external-change choices and permits cancellation", async () => {
    const user = userEvent.setup();
    render(<WorkspaceRecoveryHarness />);
    await user.selectOptions(screen.getByRole("combobox", { name: "Workspace condition" }), "external");
    await user.click(screen.getByRole("button", { name: "Open project" }));
    await user.click(screen.getByRole("button", { name: "Check source before Save" }));

    const alert = screen.getByRole("alert");
    expect(alert).toHaveFocus();
    expect(screen.getByRole("button", { name: "Save as new project" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Replace changed source" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Cancel Save" }));
    expect(screen.getByRole("status")).toHaveTextContent("remain unchanged");
  });

  it("removes only clean cache and retains protected work", async () => {
    const user = userEvent.setup();
    const { container } = render(<WorkspaceRecoveryHarness />);
    await user.click(screen.getByRole("button", { name: "Open project" }));
    await user.click(screen.getByRole("button", { name: "Review cache cleanup" }));

    expect(screen.getByRole("heading", { name: "Cache cleanup" })).toHaveFocus();
    expect(screen.getByText("Interrupted recording")).toBeInTheDocument();
    expect(screen.getByText("Recovery and Project Trash")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remove 4 MB clean cache" }));
    expect(screen.getByRole("status")).toHaveTextContent("Protected work was retained");
    expect(screen.getByText("2 MB")).toBeInTheDocument();
    await expectNoSeriousOrCriticalA11yIssues(container);
  });
});
