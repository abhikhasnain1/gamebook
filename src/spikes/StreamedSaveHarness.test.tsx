import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { expectNoSeriousOrCriticalA11yIssues } from "../test/a11y";
import { StreamedSaveHarness } from "./StreamedSaveHarness";

describe("StreamedSaveHarness", () => {
  it("exposes bounded progress and returns focus after successful replacement", async () => {
    const user = userEvent.setup();
    const { container } = render(<StreamedSaveHarness />);
    await user.click(screen.getByRole("button", { name: "Save project" }));

    expect(screen.getByRole("progressbar", { name: "Save progress" })).toHaveValue(48);
    expect(screen.getByRole("status")).toHaveTextContent("prior project remains available");
    await user.click(screen.getByRole("button", { name: "Complete Save" }));
    expect(screen.getByText("Validated replacement complete")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save project" })).toHaveFocus();
    await expectNoSeriousOrCriticalA11yIssues(container);
  });

  it("cancels from the keyboard-operable progress surface without changing the prior project", async () => {
    const user = userEvent.setup();
    render(<StreamedSaveHarness />);
    await user.click(screen.getByRole("button", { name: "Save project" }));
    await user.click(screen.getByRole("button", { name: "Cancel Save" }));

    expect(screen.getByRole("status")).toHaveTextContent("prior project and recoverable work remain unchanged");
    expect(screen.getByRole("button", { name: "Save project" })).toHaveFocus();
  });

  it("focuses external-change choices and supports explicit cancellation", async () => {
    const user = userEvent.setup();
    render(<StreamedSaveHarness />);
    await user.selectOptions(screen.getByRole("combobox", { name: "Save condition" }), "external");
    await user.click(screen.getByRole("button", { name: "Save project" }));

    expect(screen.getByRole("heading", { name: "Destination changed outside Gamebook" })).toHaveFocus();
    expect(screen.getByRole("button", { name: "Save as new project" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Replace changed destination" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Cancel Save" }));
    expect(screen.getByRole("status")).toHaveTextContent("remain unchanged");
  });

  it("focuses an actionable low-space error before any replacement is created", async () => {
    const user = userEvent.setup();
    const { container } = render(<StreamedSaveHarness />);
    await user.selectOptions(screen.getByRole("combobox", { name: "Save condition" }), "low-space");
    await user.click(screen.getByRole("button", { name: "Save project" }));

    expect(screen.getByRole("heading", { name: "Insufficient temporary space" })).toHaveFocus();
    expect(screen.getByText("No replacement archive was created.", { exact: false })).toBeInTheDocument();
    expect(screen.getByText("Protected")).toBeInTheDocument();
    await expectNoSeriousOrCriticalA11yIssues(container);
  });

  it("keeps a failed replacement unreferenced and offers recovery", async () => {
    const user = userEvent.setup();
    render(<StreamedSaveHarness />);
    await user.selectOptions(screen.getByRole("combobox", { name: "Save condition" }), "write-failure");
    await user.click(screen.getByRole("button", { name: "Save project" }));

    expect(screen.getByRole("heading", { name: "Replacement write failed" })).toHaveFocus();
    expect(screen.getByText("The partial replacement remains unreferenced until cleanup.", { exact: false })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review and retry" })).toBeEnabled();
  });
});
