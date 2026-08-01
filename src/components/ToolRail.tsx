import {
  Circle,
  Crop,
  MessageSquareQuote,
  Minus,
  MousePointer2,
  MoveUpRight,
  PaintBucket,
  Palette,
  Pencil,
  Plus,
  Slash,
  Square,
  Type,
} from "lucide-react";
import type { ToolId } from "../types/session";

const TOOLS: Array<{
  id: ToolId;
  label: string;
  icon: typeof MousePointer2;
  shortcut: string;
}> = [
  { id: "select", label: "Select", icon: MousePointer2, shortcut: "V" },
  { id: "pen", label: "Pen", icon: Pencil, shortcut: "P" },
  { id: "arrow", label: "Arrow", icon: MoveUpRight, shortcut: "A" },
  { id: "callout", label: "Callout", icon: MessageSquareQuote, shortcut: "K" },
  { id: "line", label: "Line", icon: Slash, shortcut: "L" },
  { id: "box", label: "Box", icon: Square, shortcut: "R" },
  { id: "circle", label: "Circle", icon: Circle, shortcut: "O" },
  { id: "crop", label: "Crop extract", icon: Crop, shortcut: "C" },
  { id: "text", label: "Text box", icon: Type, shortcut: "T" },
];

const COLORS = [
  { value: "#202328", label: "Charcoal" },
  { value: "#ef4444", label: "Red" },
  { value: "#f4b942", label: "Gold" },
  { value: "#32c48d", label: "Green" },
  { value: "#5aa9ff", label: "Blue" },
  { value: "#a855f7", label: "Violet" },
  { value: "#f7f7f4", label: "White" },
];

interface ToolRailProps {
  tool: ToolId;
  color: string;
  strokeWidth: number;
  pageBackgroundColor: string;
  onToolChange: (tool: ToolId) => void;
  onColorChange: (color: string) => void;
  onWidthChange: (width: number) => void;
  onPageBackgroundChange: (color: string) => void;
}

export function ToolRail({
  tool,
  color,
  strokeWidth,
  pageBackgroundColor,
  onToolChange,
  onColorChange,
  onWidthChange,
  onPageBackgroundChange,
}: ToolRailProps) {
  return (
    <aside className="tool-rail" aria-label="Annotation tools">
      <div className="tool-group">
        {TOOLS.map(({ id, label, icon: Icon, shortcut }) => (
          <button
            key={id}
            type="button"
            className={tool === id ? "tool-button is-active" : "tool-button"}
            aria-label={label}
            aria-pressed={tool === id}
            data-tooltip={`${label} (${shortcut})`}
            data-tooltip-side="right"
            onClick={() => onToolChange(id)}
          >
            <Icon />
          </button>
        ))}
      </div>
      <div className="tool-divider" />
      <div className="swatch-group" aria-label="Annotation color">
        {COLORS.map((swatch) => (
          <button
            key={swatch.value}
            type="button"
            className={color === swatch.value ? "color-swatch is-active" : "color-swatch"}
            style={{ backgroundColor: swatch.value }}
            aria-label={`Use ${swatch.label}`}
            aria-pressed={color === swatch.value}
            data-tooltip={swatch.label}
            data-tooltip-side="right"
            onClick={() => onColorChange(swatch.value)}
          />
        ))}
        <label
          className="color-swatch custom-color"
          data-tooltip="Any color"
          data-tooltip-side="right"
          aria-label="Choose any annotation color"
        >
          <Palette />
          <input
            type="color"
            value={color}
            onChange={(event) => onColorChange(event.target.value)}
          />
        </label>
      </div>
      <div className="tool-divider" />
      <div className="width-stepper" aria-label="Stroke width">
        <button
          type="button"
          data-tooltip="Thinner"
          data-tooltip-side="right"
          aria-label="Decrease stroke width"
          onClick={() => onWidthChange(Math.max(2, strokeWidth - 2))}
        >
          <Minus />
        </button>
        <span
          className="stroke-width-preview"
          role="img"
          data-tooltip={`Stroke width: ${strokeWidth} px`}
          data-tooltip-side="right"
          aria-label={`Stroke width ${strokeWidth} pixels`}
        >
          <i style={{ height: Math.min(12, strokeWidth) }} />
        </span>
        <button
          type="button"
          data-tooltip="Thicker"
          data-tooltip-side="right"
          aria-label="Increase stroke width"
          onClick={() => onWidthChange(Math.min(18, strokeWidth + 2))}
        >
          <Plus />
        </button>
      </div>
      <div className="tool-divider" />
      <label
        className="tool-button color-input-button"
        data-tooltip="Page background"
        data-tooltip-side="right"
        aria-label="Choose page background color"
      >
        <PaintBucket />
        <i style={{ backgroundColor: pageBackgroundColor }} />
        <input
          type="color"
          value={pageBackgroundColor}
          onChange={(event) => onPageBackgroundChange(event.target.value)}
        />
      </label>
    </aside>
  );
}
