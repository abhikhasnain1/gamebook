import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  Italic,
  List,
  Underline,
} from "lucide-react";
import { NumberStepper } from "./NumberStepper";

export type TextFormatAction =
  | "bold"
  | "italic"
  | "underline"
  | "bullet"
  | "align-left"
  | "align-center"
  | "align-right";

interface TextFormatBarProps {
  left: number;
  top: number;
  placement: "above" | "below";
  fontSize: number;
  onFormat: (action: TextFormatAction) => void;
  onFontSizeChange: (fontSize: number) => void;
}

export function TextFormatBar({
  left,
  top,
  placement,
  fontSize,
  onFormat,
  onFontSizeChange,
}: TextFormatBarProps) {
  return (
    <div
      className={`text-format-bar is-${placement}`}
      style={{ left, top }}
      role="toolbar"
      aria-label="Text formatting"
      onPointerDown={(event) => event.stopPropagation()}
    >
      <NumberStepper
        className="font-size-stepper"
        value={fontSize}
        min={8}
        max={144}
        label="Font size"
        tooltipSide="top"
        suffix="px"
        onChange={onFontSizeChange}
      />
      <div className="format-segment">
        <IconButton label="Bold" onClick={() => onFormat("bold")}><Bold /></IconButton>
        <IconButton label="Italic" onClick={() => onFormat("italic")}><Italic /></IconButton>
        <IconButton label="Underline" onClick={() => onFormat("underline")}><Underline /></IconButton>
        <IconButton label="Bulleted list" onClick={() => onFormat("bullet")}><List /></IconButton>
      </div>
      <div className="format-segment">
        <IconButton label="Align left" onClick={() => onFormat("align-left")}><AlignLeft /></IconButton>
        <IconButton label="Align center" onClick={() => onFormat("align-center")}><AlignCenter /></IconButton>
        <IconButton label="Align right" onClick={() => onFormat("align-right")}><AlignRight /></IconButton>
      </div>
    </div>
  );
}

function IconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      data-tooltip={label}
      data-tooltip-side="top"
      aria-label={label}
      onPointerDown={(event) => event.preventDefault()}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
