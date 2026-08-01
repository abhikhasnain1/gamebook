import { Point } from "fabric";
import { describe, expect, it, vi } from "vitest";
import {
  KEYBOARD_PAN_PIXELS,
  PointerPanSession,
  ViewportController,
  resolveArrowIntent,
  viewportStateLabel,
} from "./viewportController";

describe("ViewportController", () => {
  it("opens in centered Fit and supports the complete 25-200 percent range", () => {
    const canvas = fakeCanvas();
    const controller = new ViewportController(canvas, { width: 940, height: 520 });
    const fit = controller.getState();
    expect(fit.mode).toBe("fit");
    expect(fit.zoom).toBeCloseTo(472 / 900);
    expect(fit.sceneCenterX).toBeCloseTo(800);
    expect(fit.sceneCenterY).toBeCloseTo(450);

    for (const percent of [25, 50, 100, 200]) {
      const state = controller.setZoomPercent(percent);
      expect(state.mode).toBe("custom");
      expect(state.zoomPercent).toBeCloseTo(percent);
      expect(state.sceneCenterX).toBeCloseTo(800);
      expect(state.sceneCenterY).toBeCloseTo(450);
    }
    expect(canvas.setViewportTransform).toHaveBeenCalled();
    expect(canvas.requestRenderAll).toHaveBeenCalled();
  });

  it("resets to centered 100 percent and preserves custom scene center on resize", () => {
    const controller = new ViewportController(fakeCanvas(), { width: 940, height: 520 });
    controller.reset();
    controller.panViewBy(120, 48);
    const before = controller.getState();
    const after = controller.resize({ width: 700, height: 400 });
    expect(after.zoomPercent).toBe(100);
    expect(after.sceneCenterX).toBeCloseTo(before.sceneCenterX);
    expect(after.sceneCenterY).toBeCloseTo(before.sceneCenterY);
  });

  it("rejects malformed zoom, size, and pan without changing the prior view", () => {
    const controller = new ViewportController(fakeCanvas(), { width: 940, height: 520 });
    const before = controller.getState();
    expect(() => controller.setZoomPercent(24)).toThrow(/between 25 and 200/i);
    expect(() => controller.setZoomPercent(Number.NaN)).toThrow(/between 25 and 200/i);
    expect(() => controller.panViewBy(Number.POSITIVE_INFINITY, 0)).toThrow(/finite/i);
    expect(() => controller.resize({ width: 0, height: 400 })).toThrow(/positive finite/i);
    expect(controller.getState()).toEqual(before);
  });

  it("announces zoom and logical viewport center without persisting state", () => {
    const controller = new ViewportController(fakeCanvas(), { width: 940, height: 520 });
    expect(viewportStateLabel(controller.getState())).toBe("Fit; viewport center 800, 450");
    expect(viewportStateLabel(controller.reset())).toBe("100 percent; viewport center 800, 450");
  });
});

describe("viewport input intent", () => {
  it("keeps object movement distinct from Space+Arrow panning", () => {
    expect(resolveArrowIntent("ArrowRight", { spacePressed: false, shiftPressed: false })).toEqual({
      kind: "move",
      dx: 1,
      dy: 0,
    });
    expect(resolveArrowIntent("ArrowRight", { spacePressed: false, shiftPressed: true })).toEqual({
      kind: "move",
      dx: 10,
      dy: 0,
    });
    expect(resolveArrowIntent("ArrowRight", { spacePressed: true, shiftPressed: true })).toEqual({
      kind: "pan",
      dx: KEYBOARD_PAN_PIXELS,
      dy: 0,
    });
    expect(resolveArrowIntent("Enter", { spacePressed: true, shiftPressed: false })).toBeNull();
  });

  it("accepts Space+primary and middle-button drag but ignores ordinary primary drag", () => {
    const session = new PointerPanSession();
    expect(session.start(0, false, new Point(10, 10))).toBe(false);
    expect(session.start(0, true, new Point(10, 10))).toBe(true);
    expect(session.move(new Point(25, 4))).toEqual(new Point(15, -6));
    session.end();
    expect(session.active).toBe(false);
    expect(session.start(1, false, new Point(5, 5))).toBe(true);
    expect(session.move(new Point(1, 9))).toEqual(new Point(-4, 4));
  });
});

function fakeCanvas() {
  return {
    setViewportTransform: vi.fn(),
    requestRenderAll: vi.fn(),
  };
}
