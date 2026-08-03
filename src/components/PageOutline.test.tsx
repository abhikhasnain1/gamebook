import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { expectNoSeriousOrCriticalA11yIssues } from "../test/a11y";
import { PageOutline } from "./PageOutline";

const placement = {
  type: "MediaPlacement" as const,
  placementVersion: 1 as const,
  id: "placement-alpha",
  evidenceId: "evidence-alpha",
  left: 68,
  top: 112,
  scaleX: 0.5,
  scaleY: 0.5,
  angle: 0,
  zIndex: 0,
};

describe("PageOutline", () => {
  it("synchronizes selection and exposes named numeric placement controls", async () => {
    const onSelect = vi.fn();
    const onPlacementChange = vi.fn();
    const { container } = render(
      <PageOutline
        placement={placement}
        placementLabel="Screenshot on page 1"
        annotations={[{ id: "note-alpha", kind: "note", label: "Boss pattern" }]}
        selectedId="placement-alpha"
        onSelect={onSelect}
        onPlacementChange={onPlacementChange}
      />,
    );
    expect(screen.getByRole("button", { name: /screenshot on page 1/i })).toHaveAttribute("aria-pressed", "true");
    for (const name of ["X position", "Y position", "Horizontal scale", "Vertical scale", "Rotation in degrees", "Layer"]) {
      expect(screen.getByRole("spinbutton", { name })).toBeVisible();
    }
    fireEvent.change(screen.getByRole("spinbutton", { name: "Rotation in degrees" }), { target: { value: "35" } });
    expect(onPlacementChange).toHaveBeenCalledWith({ angle: 35 });
    fireEvent.click(screen.getByRole("button", { name: /boss pattern/i }));
    expect(onSelect).toHaveBeenCalledWith("note-alpha");
    await expectNoSeriousOrCriticalA11yIssues(container);
  });

  it("collapses and expands with a named keyboard control", () => {
    render(
      <PageOutline placement={placement} placementLabel="Screenshot" annotations={[]} selectedId={null} onSelect={vi.fn()} onPlacementChange={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Collapse page outline" }));
    expect(screen.queryByRole("list", { name: "Page objects" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Expand page outline" }));
    expect(screen.getByRole("list", { name: "Page objects" })).toBeVisible();
  });
});
