import { Ban, Minus, PaintBucket, Palette, Radius } from "lucide-react";
import { NumberStepper } from "./NumberStepper";

export interface SelectionStyle {
  kind: string;
  strokeColor: string;
  fillColor: string;
  borderWidth: number;
  cornerRadius: number;
  canFill: boolean;
  canRound: boolean;
  transparent: boolean;
}

interface ObjectStyleBarProps {
  style: SelectionStyle;
  onStrokeColorChange: (color: string) => void;
  onFillColorChange: (color: string) => void;
  onTransparent: () => void;
  onBorderWidthChange: (width: number) => void;
  onCornerRadiusChange: (radius: number) => void;
}

const PRESETS = [
  "#202328",
  "#ef4444",
  "#f4b942",
  "#32c48d",
  "#5aa9ff",
  "#a855f7",
  "#f7f7f4",
];

export function ObjectStyleBar({
  style,
  onStrokeColorChange,
  onFillColorChange,
  onTransparent,
  onBorderWidthChange,
  onCornerRadiusChange,
}: ObjectStyleBarProps) {
  return (
    <div
      className="object-style-bar"
      aria-label={`${style.kind} appearance`}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="style-swatches" aria-label="Border color">
        {PRESETS.map((color) => (
          <button
            key={color}
            type="button"
            className={style.strokeColor === color ? "is-active" : ""}
            style={{ backgroundColor: color }}
            data-tooltip={`Border ${color}`}
            data-tooltip-side="bottom"
            aria-label={`Use ${color} for the border`}
            onClick={() => onStrokeColorChange(color)}
          />
        ))}
        <label data-tooltip="Any border color" data-tooltip-side="bottom" aria-label="Choose any border color">
          <Palette />
          <input
            type="color"
            value={safeColor(style.strokeColor)}
            onChange={(event) => onStrokeColorChange(event.target.value)}
          />
        </label>
      </div>

      {style.canFill && (
        <div className="style-fill-control">
          <label data-tooltip="Fill color" data-tooltip-side="bottom" aria-label="Choose fill color">
            <PaintBucket />
            <i style={{ backgroundColor: style.fillColor }} />
            <input
              type="color"
              value={safeColor(style.fillColor)}
              onChange={(event) => onFillColorChange(event.target.value)}
            />
          </label>
          <button
            type="button"
            className={style.transparent ? "is-active" : ""}
            data-tooltip="Transparent fill"
            data-tooltip-side="bottom"
            aria-label="Make fill transparent"
            aria-pressed={style.transparent}
            onClick={onTransparent}
          >
            <Ban />
          </button>
        </div>
      )}

      <NumberStepper
        className="style-number-stepper"
        value={style.borderWidth}
        min={0}
        max={48}
        label="Border width in pixels"
        suffix="px"
        icon={<Minus />}
        onChange={onBorderWidthChange}
      />
      {style.canRound && (
        <NumberStepper
          className="style-number-stepper"
          value={style.cornerRadius}
          min={0}
          max={200}
          label="Corner radius in pixels"
          suffix="px"
          icon={<Radius />}
          onChange={onCornerRadiusChange}
        />
      )}
    </div>
  );
}

function safeColor(value: string): string {
  return /^#[0-9a-f]{6}$/i.test(value) ? value : "#ffffff";
}
