import { Canvas, Pattern, Rect, StaticCanvas } from "fabric";
import { describe, expect, it } from "vitest";
import {
  applyPageBackground,
  isSystemObject,
  PAGE_HEIGHT,
  PAGE_WIDTH,
  snapshotAnnotations,
  type TaggedObject,
} from "./canvasPage";

describe("finite page background", () => {
  it("uses a noninteractive 1600 by 900 page surface in a viewport-sized canvas", () => {
    const canvas = new Canvas(document.createElement("canvas"), {
      width: 800,
      height: 600,
      renderOnAddRemove: false,
    });

    applyPageBackground(canvas, "#f7f7f5");

    const page = canvas.getObjects().find(isSystemObject);
    expect(page).toBeInstanceOf(Rect);
    expect(page).toMatchObject({
      left: 0,
      top: 0,
      width: PAGE_WIDTH,
      height: PAGE_HEIGHT,
      selectable: false,
      evented: false,
    });
    expect((page as TaggedObject).data).toMatchObject({
      role: "system",
      kind: "page-background",
    });
    expect(page?.fill).toBeInstanceOf(Pattern);
    expect(canvas.backgroundColor).toBe("#16181b");
    expect(snapshotAnnotations(canvas)).toEqual({ objects: [] });
    canvas.dispose();
  });

  it("retains the original pattern-only static export background", () => {
    const canvas = new StaticCanvas(document.createElement("canvas"), {
      width: PAGE_WIDTH,
      height: PAGE_HEIGHT,
      renderOnAddRemove: false,
    });

    applyPageBackground(canvas, "#f7f7f5");

    expect(canvas.getObjects()).toHaveLength(0);
    expect(canvas.backgroundColor).toBeInstanceOf(Pattern);
    canvas.dispose();
  });
});
