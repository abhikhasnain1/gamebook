import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ToolRail } from "./ToolRail";
import { expectNoSeriousOrCriticalA11yIssues } from "../test/a11y";

const defaultProps = {
  tool: "select" as const,
  color: "#202328",
  strokeWidth: 6,
  pageBackgroundColor: "#ffffff",
  onToolChange: vi.fn(),
  onColorChange: vi.fn(),
  onWidthChange: vi.fn(),
  onPageBackgroundChange: vi.fn(),
};

describe("ToolRail", () => {
  it("exposes annotation tools with accessible state and keyboard activation", async () => {
    const user = userEvent.setup();
    const onToolChange = vi.fn();

    render(<ToolRail {...defaultProps} onToolChange={onToolChange} />);

    const rail = screen.getByRole("complementary", {
      name: "Annotation tools",
    });
    const selectTool = screen.getByRole("button", { name: "Select" });
    const textTool = screen.getByRole("button", { name: "Text box" });

    expect(rail).toBeInTheDocument();
    expect(selectTool).toHaveAttribute("aria-pressed", "true");
    expect(textTool).toHaveAttribute("aria-pressed", "false");

    textTool.focus();
    expect(textTool).toHaveFocus();

    await user.keyboard("[Enter]");

    expect(onToolChange).toHaveBeenCalledWith("text");
    await expectNoSeriousOrCriticalA11yIssues(rail);
  });

  it("announces style controls and sends deterministic updates", async () => {
    const user = userEvent.setup();
    const onColorChange = vi.fn();
    const onWidthChange = vi.fn();
    const onPageBackgroundChange = vi.fn();

    render(
      <ToolRail
        {...defaultProps}
        onColorChange={onColorChange}
        onWidthChange={onWidthChange}
        onPageBackgroundChange={onPageBackgroundChange}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Use Gold" }));
    await user.click(screen.getByRole("button", { name: "Increase stroke width" }));
    await user.click(screen.getByLabelText("Choose page background color"));

    expect(onColorChange).toHaveBeenCalledWith("#f4b942");
    expect(onWidthChange).toHaveBeenCalledWith(8);
    expect(onPageBackgroundChange).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Stroke width 6 pixels")).toBeInTheDocument();
  });
});
