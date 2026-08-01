import { Point, type Canvas, type StaticCanvas, type TMat2D } from "fabric";

export const VIEWPORT_SPIKE_SCHEMA = "gamebook.viewport-spike.v1";
export const LOGICAL_PAGE_WIDTH = 1600;
export const LOGICAL_PAGE_HEIGHT = 900;
export const MIN_ZOOM_PERCENT = 25;
export const MAX_ZOOM_PERCENT = 200;
export const KEYBOARD_PAN_PIXELS = 24;

export interface ViewportSize {
  width: number;
  height: number;
}

export interface ViewportState {
  mode: "fit" | "custom";
  zoom: number;
  zoomPercent: number;
  transform: TMat2D;
  sceneCenterX: number;
  sceneCenterY: number;
}

export interface ArrowIntent {
  kind: "move" | "pan";
  dx: number;
  dy: number;
}

type ViewportCanvas = Pick<StaticCanvas | Canvas, "setViewportTransform" | "requestRenderAll">;

export class ViewportController {
  private transform: TMat2D = [1, 0, 0, 1, 0, 0];
  private mode: ViewportState["mode"] = "fit";

  constructor(
    private readonly canvas: ViewportCanvas,
    private size: ViewportSize,
    private readonly onChange: (state: ViewportState) => void = () => undefined,
  ) {
    validateSize(size);
    this.fit();
  }

  fit(): ViewportState {
    const inset = Math.min(24, this.size.width / 10, this.size.height / 10);
    const zoom = Math.min(
      (this.size.width - inset * 2) / LOGICAL_PAGE_WIDTH,
      (this.size.height - inset * 2) / LOGICAL_PAGE_HEIGHT,
    );
    this.mode = "fit";
    this.transform = centeredTransform(this.size, zoom);
    return this.apply();
  }

  setZoomPercent(percent: number): ViewportState {
    if (!Number.isFinite(percent) || percent < MIN_ZOOM_PERCENT || percent > MAX_ZOOM_PERCENT) {
      throw new Error(`Zoom must be between ${MIN_ZOOM_PERCENT} and ${MAX_ZOOM_PERCENT} percent`);
    }
    this.mode = "custom";
    return this.zoomAroundCenter(percent / 100);
  }

  reset(): ViewportState {
    this.mode = "custom";
    this.transform = centeredTransform(this.size, 1);
    return this.apply();
  }

  panViewBy(dx: number, dy: number): ViewportState {
    validateDelta(dx, dy);
    this.mode = "custom";
    this.transform = [
      this.transform[0],
      0,
      0,
      this.transform[3],
      this.transform[4] - dx,
      this.transform[5] - dy,
    ];
    return this.apply();
  }

  panContentBy(dx: number, dy: number): ViewportState {
    validateDelta(dx, dy);
    this.mode = "custom";
    this.transform = [
      this.transform[0],
      0,
      0,
      this.transform[3],
      this.transform[4] + dx,
      this.transform[5] + dy,
    ];
    return this.apply();
  }

  resize(size: ViewportSize): ViewportState {
    validateSize(size);
    const previousCenter = this.sceneCenter();
    this.size = { ...size };
    if (this.mode === "fit") return this.fit();
    const zoom = this.transform[0];
    this.transform = [
      zoom,
      0,
      0,
      zoom,
      this.size.width / 2 - previousCenter.x * zoom,
      this.size.height / 2 - previousCenter.y * zoom,
    ];
    return this.apply();
  }

  getState(): ViewportState {
    const center = this.sceneCenter();
    return {
      mode: this.mode,
      zoom: this.transform[0],
      zoomPercent: this.transform[0] * 100,
      transform: [...this.transform] as TMat2D,
      sceneCenterX: center.x,
      sceneCenterY: center.y,
    };
  }

  private zoomAroundCenter(zoom: number): ViewportState {
    const sceneCenter = this.sceneCenter();
    this.transform = [
      zoom,
      0,
      0,
      zoom,
      this.size.width / 2 - sceneCenter.x * zoom,
      this.size.height / 2 - sceneCenter.y * zoom,
    ];
    return this.apply();
  }

  private sceneCenter(): Point {
    const zoom = this.transform[0];
    return new Point(
      (this.size.width / 2 - this.transform[4]) / zoom,
      (this.size.height / 2 - this.transform[5]) / zoom,
    );
  }

  private apply(): ViewportState {
    this.transform = clampTransform(this.transform, this.size);
    this.canvas.setViewportTransform([...this.transform] as TMat2D);
    this.canvas.requestRenderAll();
    const state = this.getState();
    this.onChange(state);
    return state;
  }
}

export class PointerPanSession {
  private previous: Point | null = null;

  start(button: number, spacePressed: boolean, point: Point): boolean {
    if (button !== 1 && !(button === 0 && spacePressed)) return false;
    this.previous = point;
    return true;
  }

  move(point: Point): Point | null {
    if (!this.previous) return null;
    const delta = point.subtract(this.previous);
    this.previous = point;
    return delta;
  }

  end(): void {
    this.previous = null;
  }

  get active(): boolean {
    return this.previous !== null;
  }
}

export function resolveArrowIntent(
  key: string,
  options: { spacePressed: boolean; shiftPressed: boolean },
): ArrowIntent | null {
  const direction = arrowDirection(key);
  if (!direction) return null;
  const amount = options.spacePressed
    ? KEYBOARD_PAN_PIXELS
    : options.shiftPressed
      ? 10
      : 1;
  return {
    kind: options.spacePressed ? "pan" : "move",
    dx: direction.x * amount,
    dy: direction.y * amount,
  };
}

export function viewportStateLabel(state: ViewportState): string {
  const mode = state.mode === "fit" ? "Fit" : `${Math.round(state.zoomPercent)} percent`;
  return `${mode}; viewport center ${Math.round(state.sceneCenterX)}, ${Math.round(state.sceneCenterY)}`;
}

function centeredTransform(size: ViewportSize, zoom: number): TMat2D {
  return [
    zoom,
    0,
    0,
    zoom,
    (size.width - LOGICAL_PAGE_WIDTH * zoom) / 2,
    (size.height - LOGICAL_PAGE_HEIGHT * zoom) / 2,
  ];
}

function clampTransform(transform: TMat2D, size: ViewportSize): TMat2D {
  const zoom = transform[0];
  const visibleEdge = Math.min(80, size.width / 3, size.height / 3);
  const pageWidth = LOGICAL_PAGE_WIDTH * zoom;
  const pageHeight = LOGICAL_PAGE_HEIGHT * zoom;
  const minimumX = visibleEdge - pageWidth;
  const maximumX = size.width - visibleEdge;
  const minimumY = visibleEdge - pageHeight;
  const maximumY = size.height - visibleEdge;
  return [
    zoom,
    0,
    0,
    zoom,
    clamp(transform[4], minimumX, maximumX),
    clamp(transform[5], minimumY, maximumY),
  ];
}

function arrowDirection(key: string): { x: number; y: number } | null {
  if (key === "ArrowLeft") return { x: -1, y: 0 };
  if (key === "ArrowRight") return { x: 1, y: 0 };
  if (key === "ArrowUp") return { x: 0, y: -1 };
  if (key === "ArrowDown") return { x: 0, y: 1 };
  return null;
}

function validateSize(size: ViewportSize): void {
  if (!Number.isFinite(size.width) || !Number.isFinite(size.height) || size.width <= 0 || size.height <= 0) {
    throw new Error("Viewport dimensions must be positive finite values");
  }
}

function validateDelta(dx: number, dy: number): void {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) {
    throw new Error("Pan delta must be finite");
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
