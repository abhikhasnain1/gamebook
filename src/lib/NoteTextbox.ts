import {
  Textbox,
  classRegistry,
  controlsUtils,
  type Control,
  type TextboxProps,
} from "fabric";

type NoteTextboxOptions = Partial<TextboxProps> & {
  boxHeight?: number;
  boxBorderColor?: string;
  boxBorderWidth?: number;
  boxCornerRadius?: number;
  contentPadding?: number;
  editingBorderColor?: string;
  hiddenTextareaContainer?: HTMLElement | null;
};

export class NoteTextbox extends Textbox {
  static override type = "NoteTextbox";

  boxHeight: number;
  boxBorderColor: string;
  boxBorderWidth: number;
  boxCornerRadius: number;
  contentPadding: number;

  constructor(text: string, options: NoteTextboxOptions = {}) {
    const {
      boxHeight,
      boxBorderColor = "#a9adb2",
      boxBorderWidth = 1,
      boxCornerRadius = 0,
      contentPadding = 16,
      ...textboxOptions
    } = options;
    super(text, { ...textboxOptions, objectCaching: false });
    this.contentPadding = Math.max(0, contentPadding);
    this.boxHeight = Math.max(
      64,
      boxHeight ?? this.height + this.contentPadding * 2,
    );
    this.boxBorderColor = boxBorderColor;
    this.boxBorderWidth = Math.max(0, boxBorderWidth);
    this.boxCornerRadius = Math.max(0, boxCornerRadius);
    this.initDimensions();
  }

  static override createControls(): { controls: Record<string, Control> } {
    const { controls } = super.createControls();
    controls.mt.actionHandler = controlsUtils.changeHeight;
    controls.mt.actionName = "resizing";
    controls.mb.actionHandler = controlsUtils.changeHeight;
    controls.mb.actionName = "resizing";
    return { controls };
  }

  override initDimensions(): void {
    super.initDimensions();
    if (Number.isFinite(this.boxHeight)) {
      this.height = Math.max(
        this.height + (this.contentPadding || 0) * 2,
        this.boxHeight,
      );
    }
  }

  override _wrapText(lines: string[], desiredWidth: number): string[][] {
    return super._wrapText(
      lines,
      Math.max(2, desiredWidth - (this.contentPadding || 0) * 2),
    );
  }

  override _getLeftOffset(): number {
    const padding = this.contentPadding || 0;
    return super._getLeftOffset() + (this.direction === "rtl" ? -padding : padding);
  }

  override _getTopOffset(): number {
    return super._getTopOffset() + (this.contentPadding || 0);
  }

  override _getLineLeftOffset(lineIndex: number): number {
    const originalWidth = this.width;
    this.width = Math.max(2, originalWidth - (this.contentPadding || 0) * 2);
    const offset = super._getLineLeftOffset(lineIndex);
    this.width = originalWidth;
    return offset;
  }

  override _renderBackground(ctx: CanvasRenderingContext2D): void {
    const dimensions = this._getNonTransformedDimensions();
    const radius = Math.min(
      this.boxCornerRadius || 0,
      dimensions.x / 2,
      dimensions.y / 2,
    );
    ctx.save();
    roundedRectPath(
      ctx,
      -dimensions.x / 2,
      -dimensions.y / 2,
      dimensions.x,
      dimensions.y,
      radius,
    );
    if (this.backgroundColor) {
      ctx.fillStyle = this.backgroundColor;
      ctx.fill();
      this._removeShadow(ctx);
    }
    if (this.boxBorderWidth && this.boxBorderColor) {
      const inset = this.boxBorderWidth / 2;
      roundedRectPath(
        ctx,
        -dimensions.x / 2 + inset,
        -dimensions.y / 2 + inset,
        Math.max(0, dimensions.x - this.boxBorderWidth),
        Math.max(0, dimensions.y - this.boxBorderWidth),
        Math.max(0, radius - inset),
      );
      ctx.strokeStyle = this.boxBorderColor;
      ctx.lineWidth = this.boxBorderWidth;
      ctx.stroke();
    }
    ctx.restore();
  }
}

function roundedRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  requestedRadius: number,
): void {
  const radius = Math.min(
    Math.max(0, requestedRadius),
    width / 2,
    height / 2,
  );
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + width - radius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
  ctx.lineTo(x + width, y + height - radius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  ctx.lineTo(x + radius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

classRegistry.setClass(NoteTextbox);
