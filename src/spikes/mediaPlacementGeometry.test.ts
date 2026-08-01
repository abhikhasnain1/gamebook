import { describe, expect, it } from "vitest";
import {
  PlacementHistory,
  assertStablePlacement,
  normalizePlacement,
  orderedCompositionIds,
  updatePlacement,
  type PlacementHarnessSnapshot,
} from "./mediaPlacementGeometry";

const initial: PlacementHarnessSnapshot = {
  activePageId: "page-alpha",
  pages: [
    {
      id: "page-alpha",
      placements: [
        {
          id: "placement-back",
          evidenceId: "evidence-1080p",
          left: 80,
          top: 90,
          scaleX: 0.8,
          scaleY: 0.8,
          angle: 0,
          posterTimestampUs: 1_500_000,
          zIndex: 1,
        },
        {
          id: "placement-front",
          evidenceId: "evidence-1440p",
          left: 520,
          top: 210,
          scaleX: 0.55,
          scaleY: 0.55,
          angle: 8,
          crop: { x: 40, y: 20, width: 560, height: 300 },
          zIndex: 2,
        },
      ],
      annotationIds: ["annotation-note"],
      connectors: [
        {
          id: "connector-one",
          start: { placementId: "placement-front", anchor: "right" },
          end: { annotationId: "annotation-note", anchor: "left" },
        },
      ],
    },
  ],
};

describe("MediaPlacement stable records", () => {
  it("round-trips transforms, crop, poster time, and z-order", () => {
    const normalized = normalizePlacement(initial.pages[0].placements[1]);
    expect(JSON.parse(JSON.stringify(normalized))).toEqual(normalized);
    expect(Object.keys(normalized)).toEqual([
      "id",
      "evidenceId",
      "left",
      "top",
      "scaleX",
      "scaleY",
      "angle",
      "zIndex",
      "crop",
    ]);
  });

  it.each(["path", "objectUrl", "element", "frame", "bytes", "src", "video"])(
    "rejects runtime-only %s state",
    (key) => {
      expect(() => assertStablePlacement({
        ...initial.pages[0].placements[0],
        [key]: key === "bytes" ? new Uint8Array([1, 2, 3]) : "runtime-value",
      })).toThrow(/forbidden key|media bytes/);
    },
  );

  it("preserves connector identities and annotation-over-media order", () => {
    expect(orderedCompositionIds(initial.pages[0])).toEqual([
      "placement-back",
      "placement-front",
      "annotation-note",
      "connector-one",
    ]);
    expect(initial.pages[0].connectors[0].start).toEqual({
      placementId: "placement-front",
      anchor: "right",
    });
  });

  it("restores geometry through history and page snapshots", () => {
    const history = new PlacementHistory(initial);
    const moved = updatePlacement(
      history.current(),
      "page-alpha",
      "placement-front",
      { left: 700, top: 320, angle: 370 },
    );
    history.push(moved);
    expect(history.current().pages[0].placements[1]).toMatchObject({
      left: 700,
      top: 320,
      angle: 10,
    });
    expect(history.undo()).toEqual(initial);
    expect(history.redo()).toEqual(moved);
  });

  it("fails closed on malformed geometry without mutating the snapshot", () => {
    const before = structuredClone(initial);
    expect(() => updatePlacement(initial, "page-alpha", "placement-front", { scaleX: 0 })).toThrow(
      "scaleX must be positive",
    );
    expect(initial).toEqual(before);
  });
});
