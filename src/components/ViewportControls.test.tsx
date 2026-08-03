import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { expectNoSeriousOrCriticalA11yIssues } from "../test/a11y";
import { ViewportControls } from "./ViewportControls";

describe("ViewportControls", () => {
  it("exposes Fit, reset, zoom, and every directional pan path", async () => {
    const onZoom = vi.fn();
    const onPan = vi.fn();
    const { container } = render(
      <ViewportControls
        state={{ mode: "fit", zoom: 0.5, zoomPercent: 50, transform: [0.5, 0, 0, 0.5, 0, 0], sceneCenterX: 800, sceneCenterY: 450 }}
        onFit={vi.fn()}
        onReset={vi.fn()}
        onZoom={onZoom}
        onPan={onPan}
      />,
    );
    expect(screen.getByRole("button", { name: "Fit page" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.change(screen.getByRole("spinbutton", { name: "Zoom percentage" }), { target: { value: "125" } });
    expect(onZoom).toHaveBeenCalledWith(125);
    fireEvent.click(screen.getByRole("button", { name: "Pan right" }));
    expect(onPan).toHaveBeenCalledWith(1, 0);
    await expectNoSeriousOrCriticalA11yIssues(container);
  });
});
