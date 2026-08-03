import { Point } from "fabric";
import { describe, expect, it, vi } from "vitest";
import {
  KEYBOARD_PAN_PIXELS,
  PointerPanSession,
  ViewportController,
  resolveArrowIntent,
  viewportStateLabel,
} from "./viewportController";

describe("production ViewportController", () => {
  it("opens in Fit and supports the complete 25-200 percent range", () => {
    const canvas = fakeCanvas();
    const controller = new ViewportController(canvas, { width: 940, height: 520 });
    const fit = controller.getState();
    expect(fit.mode).toBe("fit");
    expect(fit.zoom).toBeCloseTo(472 / 900);
    expect(fit.sceneCenterX).toBeCloseTo(800);
    expect(fit.sceneCenterY).toBeCloseTo(450);
    for (const percent of [25, 50, 100, 200]) {
      expect(controller.setZoomPercent(percent).zoomPercent).toBeCloseTo(percent);
    }
  });

  it("keeps malformed input from changing prior ephemeral state", () => {
    const controller = new ViewportController(fakeCanvas(), { width: 940, height: 520 });
    const before = controller.getState();
    expect(() => controller.setZoomPercent(24)).toThrow(/between 25 and 200/i);
    expect(() => controller.panViewBy(Number.POSITIVE_INFINITY, 0)).toThrow(/finite/i);
    expect(() => controller.resize({ width: 0, height: 400 })).toThrow(/positive finite/i);
    expect(controller.getState()).toEqual(before);
  });

  it("separates object movement from Space+Arrow and pointer panning", () => {
    expect(resolveArrowIntent("ArrowRight", { spacePressed: false, shiftPressed: false })).toEqual({ kind: "move", dx: 1, dy: 0 });
    expect(resolveArrowIntent("ArrowRight", { spacePressed: false, shiftPressed: true })).toEqual({ kind: "move", dx: 10, dy: 0 });
    expect(resolveArrowIntent("ArrowRight", { spacePressed: true, shiftPressed: true })).toEqual({ kind: "pan", dx: KEYBOARD_PAN_PIXELS, dy: 0 });
    const session = new PointerPanSession();
    expect(session.start(0, false, new Point(10, 10))).toBe(false);
    expect(session.start(0, true, new Point(10, 10))).toBe(true);
    expect(session.move(new Point(25, 4))).toEqual(new Point(15, -6));
    session.end();
    expect(session.active).toBe(false);
  });

  it("announces mode and logical center", () => {
    const controller = new ViewportController(fakeCanvas(), { width: 940, height: 520 });
    expect(viewportStateLabel(controller.getState())).toBe("Fit; viewport center 800, 450");
  });
});

function fakeCanvas() {
  return { setViewportTransform: vi.fn(), requestRenderAll: vi.fn() };
}
