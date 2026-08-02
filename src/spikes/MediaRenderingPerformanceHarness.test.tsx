import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { expectNoSeriousOrCriticalA11yIssues } from "../test/a11y";
import { MediaRenderingPerformanceHarness } from "./MediaRenderingPerformanceHarness";

vi.mock("fabric", () => ({
  Canvas: class {
    dispose() {}
  },
  FabricImage: class {},
  Line: class {},
  Rect: class {},
  classRegistry: { setClass: vi.fn() },
}));

describe("MediaRenderingPerformanceHarness", () => {
  it("exposes one named keyboard command and accessible benchmark state", async () => {
    const { container } = render(<MediaRenderingPerformanceHarness />);

    expect(screen.getByRole("main")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Media rendering benchmark workspace" })).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "Benchmark measurements" })).toBeInTheDocument();
    const progress = screen.getByText("Ready to measure");
    expect(progress).toHaveAttribute("role", "status");
    expect(progress).toHaveAttribute("aria-live", "polite");

    const run = screen.getByRole("button", { name: "Run rendering benchmark" });
    run.focus();
    expect(run).toHaveFocus();

    await expectNoSeriousOrCriticalA11yIssues(container);
  });
});
