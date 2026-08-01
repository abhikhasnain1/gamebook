import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { expectNoSeriousOrCriticalA11yIssues } from "../test/a11y";
import { ViewportControls } from "./ViewportControls";
import type { ViewportState } from "./viewportController";

const state: ViewportState = {
  mode: "fit",
  zoom: 0.5,
  zoomPercent: 50,
  transform: [0.5, 0, 0, 0.5, 40, 35],
  sceneCenterX: 800,
  sceneCenterY: 450,
};

describe("ViewportControls", () => {
  it("exposes semantic zoom, reset, fit, and four-way pan controls", async () => {
    const onFit = vi.fn();
    const onReset = vi.fn();
    const onZoom = vi.fn();
    const onPan = vi.fn();
    const { container } = render(
      <ViewportControls
        state={state}
        onFit={onFit}
        onReset={onReset}
        onZoom={onZoom}
        onPan={onPan}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Fit page" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset zoom to 100 percent" }));
    fireEvent.change(screen.getByRole("slider", { name: "Set zoom percentage" }), {
      target: { value: "125" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Pan viewport right" }));

    expect(onFit).toHaveBeenCalledOnce();
    expect(onReset).toHaveBeenCalledOnce();
    expect(onZoom).toHaveBeenCalledWith(125);
    expect(onPan).toHaveBeenCalledWith(1, 0);
    expect(screen.getByRole("status", { name: "Viewport state" })).toHaveTextContent(
      "Fit; viewport center 800, 450",
    );
    await expectNoSeriousOrCriticalA11yIssues(container);
  });
});
