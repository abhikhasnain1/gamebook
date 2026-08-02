import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { expectNoSeriousOrCriticalA11yIssues } from "../test/a11y";
import { ArchiveMaterializationHarness } from "./ArchiveMaterializationHarness";

vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
  callback(0);
  return 1;
});

describe("ArchiveMaterializationHarness", () => {
  it("completes lazy open and selected materialization from the keyboard", async () => {
    const user = userEvent.setup();
    const { container } = render(<ArchiveMaterializationHarness />);

    const open = screen.getByRole("button", { name: "Open archive" });
    open.focus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("status")).toHaveTextContent("No media extracted");
    expect(screen.getByText("None")).toBeInTheDocument();

    const materialize = screen.getByRole("button", { name: "Materialize selected asset" });
    materialize.focus();
    await user.keyboard(" ");
    expect(screen.getByRole("progressbar", { name: "Selected asset materialization" })).toHaveAttribute("aria-valuenow", "50");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByText("Selected asset available")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("unselected asset remained in the archive");

    await expectNoSeriousOrCriticalA11yIssues(container);
  });

  it("focuses an actionable digest error and exposes safe recovery", async () => {
    const user = userEvent.setup();
    render(<ArchiveMaterializationHarness />);
    await user.click(screen.getByRole("button", { name: "Open archive" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Asset verification" }), "digest");
    await user.click(screen.getByRole("button", { name: "Materialize selected asset" }));
    await user.click(screen.getByRole("button", { name: "Continue" }));

    const alert = screen.getByRole("alert");
    expect(alert).toHaveFocus();
    expect(alert).toHaveTextContent("SHA-256 verification failed");
    await user.click(screen.getByRole("button", { name: "Review recovery" }));
    expect(screen.getByRole("heading", { name: "Recovery" })).toHaveFocus();
    expect(screen.getByText("Unreferenced")).toBeInTheDocument();
  });

  it("rejects an unsafe archive before state changes", async () => {
    const user = userEvent.setup();
    render(<ArchiveMaterializationHarness />);
    await user.selectOptions(screen.getByRole("combobox", { name: "Archive condition" }), "traversal");
    await user.click(screen.getByRole("button", { name: "Open archive" }));

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("unsafe parent path");
    expect(alert).toHaveTextContent("existing project is unchanged");
    expect(screen.getByRole("button", { name: "Materialize selected asset" })).toBeDisabled();
  });

  it("cancels without exposing an output", async () => {
    const user = userEvent.setup();
    render(<ArchiveMaterializationHarness />);
    await user.click(screen.getByRole("button", { name: "Open archive" }));
    await user.click(screen.getByRole("button", { name: "Materialize selected asset" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.getByText("No asset was added to the project.")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("temporary output is isolated");
  });
});
