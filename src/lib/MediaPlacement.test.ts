import { describe, expect, it } from "vitest";
import { MediaPlacement } from "./MediaPlacement";

describe("production MediaPlacement", () => {
  it("round-trips only the frozen stable placement fields", () => {
    const source = document.createElement("canvas");
    source.width = 1920;
    source.height = 1080;
    const placement = new MediaPlacement(
      {
        type: "MediaPlacement",
        placementVersion: 1,
        id: "placement-alpha",
        evidenceId: "evidence-alpha",
        left: 68,
        top: 112,
        scaleX: 0.5,
        scaleY: 0.5,
        angle: 0,
        crop: { x: 10, y: 20, width: 800, height: 450 },
        zIndex: 0,
      },
      source,
    );

    const serialized = placement.toPlacementRecord();
    expect(serialized).toEqual({
      type: "MediaPlacement",
      placementVersion: 1,
      id: "placement-alpha",
      evidenceId: "evidence-alpha",
      left: 68,
      top: 112,
      scaleX: 0.5,
      scaleY: 0.5,
      angle: 0,
      crop: { x: 10, y: 20, width: 800, height: 450 },
      zIndex: 0,
    });
    expect(JSON.stringify(serialized)).not.toMatch(/src|token|url|path|viewport|bytes/i);
  });

  it("applies geometry while protecting placement identity", () => {
    const source = document.createElement("canvas");
    source.width = 100;
    source.height = 50;
    const placement = new MediaPlacement(
      {
        type: "MediaPlacement",
        placementVersion: 1,
        id: "placement-alpha",
        evidenceId: "evidence-alpha",
        left: 0,
        top: 0,
        scaleX: 1,
        scaleY: 1,
        angle: 0,
        zIndex: 0,
      },
      source,
    );
    placement.applyPlacementRecord({
      ...placement.toPlacementRecord(),
      left: 44,
      angle: 35,
    });
    expect(placement.toPlacementRecord()).toMatchObject({ left: 44, angle: 35 });
    expect(() =>
      placement.applyPlacementRecord({
        ...placement.toPlacementRecord(),
        id: "placement-other",
      }),
    ).toThrow("Placement identity cannot change");
  });
});
