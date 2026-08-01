import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { expectNoSeriousOrCriticalA11yIssues } from "../test/a11y";
import { MediaPlacementOutline } from "./MediaPlacementOutline";
import type { MediaPlacementRecord } from "./mediaPlacementGeometry";

const placements: MediaPlacementRecord[] = [
  {
    id: "placement-alpha",
    evidenceId: "evidence-1080p",
    left: 80,
    top: 90,
    scaleX: 0.8,
    scaleY: 0.8,
    angle: 0,
    posterTimestampUs: 1_500_000,
    zIndex: 1,
  },
];

describe("MediaPlacement semantic outline", () => {
  it("exposes selection and every numeric transform", async () => {
    const onChange = vi.fn();
    const { container } = render(
      <MediaPlacementOutline
        placements={placements}
        selectedId="placement-alpha"
        onSelect={vi.fn()}
        onChange={onChange}
      />,
    );

    expect(screen.getByRole("button", { name: /evidence-1080p/i })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    for (const name of [
      "X",
      "Y",
      "Scale X",
      "Scale Y",
      "Rotation",
      "Layer",
      "Poster time (microseconds)",
      "Crop X",
      "Crop Y",
      "Crop width",
      "Crop height",
    ]) {
      expect(screen.getByRole("spinbutton", { name })).toBeVisible();
    }

    fireEvent.change(screen.getByRole("spinbutton", { name: "Rotation" }), {
      target: { value: "35" },
    });
    expect(onChange).toHaveBeenCalledWith("placement-alpha", { angle: 35 });
    await expectNoSeriousOrCriticalA11yIssues(container);
  });
});
