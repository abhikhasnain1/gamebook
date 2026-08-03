import {
  Canvas,
  FabricImage,
  FabricObject,
  Group,
  Line,
  Pattern,
  Point,
  Rect,
  Shadow,
  StaticCanvas,
  Textbox,
  util,
} from "fabric";
import type {
  AnnotationSnapshot,
  GamebookPage,
  ScreenshotLayout,
} from "../types/session";
import type { EditorPage, MediaPlacementRecord } from "../types/projectV2";
import { NoteTextbox } from "./NoteTextbox";
import {
  Connector,
  syncConnectorBindings,
  type ConnectorBindings,
} from "./Connector";
import { loadMediaPlacement, MediaPlacement } from "./MediaPlacement";

export const PAGE_WIDTH = 1600;
export const PAGE_HEIGHT = 900;

export interface ObjectTag {
  role?: "system" | "screenshot" | "annotation";
  kind?: string;
  id?: string;
  connector?: ConnectorBindings;
  cropSource?: {
    objectId: string;
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

export type TaggedObject = FabricObject & { data?: ObjectTag };
export type RenderablePage = GamebookPage | EditorPage;

export function tagObject<T extends FabricObject>(object: T, data: ObjectTag): T {
  const existing = (object as T & { data?: ObjectTag }).data ?? {};
  const needsId = data.role === "annotation" || data.role === "screenshot";
  (object as T & { data: ObjectTag }).data = {
    ...existing,
    ...data,
    id: data.id ?? existing.id ?? (needsId ? crypto.randomUUID() : undefined),
  };
  return object;
}

export function isSystemObject(object: FabricObject): boolean {
  return (object as TaggedObject).data?.role === "system";
}

export function isScreenshotObject(object: FabricObject): boolean {
  return (object as TaggedObject).data?.role === "screenshot";
}

export function isAnnotationObject(object: FabricObject): boolean {
  return (object as TaggedObject).data?.role === "annotation";
}

export function getScreenshotObject(
  canvas: StaticCanvas | Canvas,
): FabricImage | null {
  const screenshot = canvas.getObjects().find(isScreenshotObject);
  return screenshot instanceof FabricImage ? screenshot : null;
}

export function snapshotScreenshotLayout(
  canvas: StaticCanvas | Canvas,
): ScreenshotLayout | null {
  const screenshot = getScreenshotObject(canvas);
  if (!screenshot) return null;
  return {
    left: screenshot.left,
    top: screenshot.top,
    scaleX: screenshot.scaleX,
    scaleY: screenshot.scaleY,
    angle: screenshot.angle,
  };
}

export function snapshotMediaPlacement(
  canvas: StaticCanvas | Canvas,
  fallback: MediaPlacementRecord,
): MediaPlacementRecord {
  const screenshot = getScreenshotObject(canvas);
  if (screenshot instanceof MediaPlacement) return screenshot.toPlacementRecord();
  if (!screenshot) return fallback;
  return {
    ...fallback,
    left: screenshot.left,
    top: screenshot.top,
    scaleX: screenshot.scaleX,
    scaleY: screenshot.scaleY,
    angle: ((screenshot.angle % 360) + 360) % 360,
  };
}

export async function composePage(
  canvas: StaticCanvas | Canvas,
  page: RenderablePage,
  signal?: AbortSignal,
): Promise<void> {
  applyPageBackground(canvas, page.backgroundColor);

  const sourceUrl = pageSourceUrl(page);
  if (!sourceUrl) throw new Error("The screenshot asset is not materialized.");
  const placementRecord = pagePlacement(page);
  const screenshot = await loadMediaPlacement(placementRecord, sourceUrl, signal);
  tagObject(screenshot, {
    role: "screenshot",
    kind: "screenshot",
    id: placementRecord.id,
  });
  canvas.add(screenshot);

  const annotations = await enlivenPageAnnotations(page.annotations, sourceUrl, signal);
  annotations.forEach((enlivenedObject) => {
    const object = normalizeAnnotationObject(enlivenedObject);
    const data = (object as TaggedObject).data;
    tagObject(object, {
      ...data,
      role: "annotation",
      kind: data?.kind ?? object.type.toLowerCase(),
    });
    attachTextInputContainer(canvas, object);
    canvas.add(object);
  });
  syncConnectorBindings(canvas);
  canvas.requestRenderAll();
}

export async function enlivenPageAnnotations(
  snapshot: AnnotationSnapshot,
  sourceUrl: string,
  signal?: AbortSignal,
): Promise<FabricObject[]> {
  return util.enlivenObjects<FabricObject>(
    snapshot.objects.map((object) =>
      withRuntimeCropSource(upgradeSerializedAnnotation(object), sourceUrl),
    ),
    { signal },
  );
}

export function normalizeAnnotationObject(object: FabricObject): FabricObject {
  const data = (object as TaggedObject).data;
  if (
    object instanceof Group &&
    (data?.kind === "arrow" || data?.kind === "callout")
  ) {
    const line = object.getObjects().find(
      (child): child is Line => child instanceof Line,
    );
    if (line) {
      const points = line.calcLinePoints();
      const matrix = line.calcTransformMatrix();
      const start = new Point(points.x1, points.y1).transform(matrix);
      const end = new Point(points.x2, points.y2).transform(matrix);
      return tagObject(
        new Connector([start.x, start.y, end.x, end.y], {
          stroke: typeof line.stroke === "string" ? line.stroke : "#ef4444",
          strokeWidth: line.strokeWidth,
          strokeUniform: true,
          opacity: object.opacity,
        }),
        { ...data, role: "annotation", connector: {} },
      );
    }
  }
  if (object instanceof FabricImage && data?.kind === "crop") {
    styleExtractedImage(object);
  }
  return object;
}

export function createCropExtraction(
  screenshot: FabricImage,
  bounds: { x: number; y: number; width: number; height: number },
): FabricImage {
  const cropX = Math.round(clamp(bounds.x, 0, screenshot.width - 1));
  const cropY = Math.round(clamp(bounds.y, 0, screenshot.height - 1));
  const width = Math.max(
    1,
    Math.round(Math.min(bounds.width, screenshot.width - cropX)),
  );
  const height = Math.max(
    1,
    Math.round(Math.min(bounds.height, screenshot.height - cropY)),
  );
  const crop = new FabricImage(screenshot.getElement(), {
    cropX,
    cropY,
    width,
    height,
    originX: "center",
    originY: "center",
  });
  styleExtractedImage(crop);
  const screenshotId = (screenshot as TaggedObject).data?.id ?? "screenshot";
  return tagObject(crop, {
    role: "annotation",
    kind: "crop",
    cropSource: {
      objectId: screenshotId,
      x: cropX,
      y: cropY,
      width,
      height,
    },
  });
}

export function applyPageBackground(
  canvas: StaticCanvas | Canvas,
  color: string,
): void {
  const pattern = pageBackgroundPattern(color);
  if (canvas instanceof Canvas) {
    canvas.backgroundColor = "#16181b";
    let pageSurface = canvas
      .getObjects()
      .find(
        (object) =>
          isSystemObject(object) &&
          (object as TaggedObject).data?.kind === "page-background",
      );
    if (!(pageSurface instanceof Rect)) {
      pageSurface = tagObject(
        new Rect({
          left: 0,
          top: 0,
          width: PAGE_WIDTH,
          height: PAGE_HEIGHT,
          originX: "left",
          originY: "top",
          selectable: false,
          evented: false,
          objectCaching: false,
        }),
        { role: "system", kind: "page-background" },
      );
      canvas.add(pageSurface);
    }
    pageSurface.set({ fill: pattern, dirty: true });
    canvas.sendObjectToBack(pageSurface);
    canvas.requestRenderAll();
    return;
  }
  canvas.backgroundColor = pattern;
  canvas.requestRenderAll();
}

function pageBackgroundPattern(color: string): Pattern | string {
  const tile = document.createElement("canvas");
  tile.width = 40;
  tile.height = 40;
  const context = tile.getContext("2d");
  if (!context) return color;
  context.fillStyle = color;
  context.fillRect(0, 0, tile.width, tile.height);
  context.fillStyle = contrastingDotColor(color);
  context.beginPath();
  context.arc(20, 20, 1.2, 0, Math.PI * 2);
  context.fill();
  return new Pattern({ source: tile, repeat: "repeat" });
}

export function attachTextInputContainer(
  canvas: StaticCanvas | Canvas,
  object: FabricObject,
): void {
  if (canvas instanceof Canvas && object instanceof Textbox) {
    object.hiddenTextareaContainer = canvas.upperCanvasEl.parentElement;
  }
}

export function snapshotAnnotations(canvas: StaticCanvas | Canvas): AnnotationSnapshot {
  return {
    objects: canvas
      .getObjects()
      .filter(isAnnotationObject)
      .map((object) => {
        const serialized = object.toObject([
          "data",
          "boxHeight",
          "boxBorderColor",
          "boxBorderWidth",
          "boxCornerRadius",
          "contentPadding",
        ] as never[]) as Record<string, unknown>;
        if ((serialized.data as ObjectTag | undefined)?.kind === "crop") {
          delete serialized.src;
        }
        return serialized;
      }),
  };
}

export function extractText(canvas: StaticCanvas | Canvas): string {
  return canvas
    .getObjects()
    .filter(
      (object): object is Textbox =>
        isAnnotationObject(object) && object instanceof Textbox,
    )
    .map((object) => object.text.trim())
    .filter(Boolean)
    .join("\n\n");
}

export async function renderPageToDataUrl(
  page: RenderablePage,
  multiplier = 2,
): Promise<string> {
  const canvasElement = document.createElement("canvas");
  const canvas = new StaticCanvas(canvasElement, {
    width: PAGE_WIDTH,
    height: PAGE_HEIGHT,
    renderOnAddRemove: false,
  });
  try {
    await composePage(canvas, page);
    return canvas.toDataURL({ format: "png", multiplier });
  } finally {
    canvas.dispose();
  }
}

function pageSourceUrl(page: RenderablePage): string | null {
  return "sourceUrl" in page ? page.sourceUrl : page.screenshotDataUrl;
}

function pagePlacement(page: RenderablePage): MediaPlacementRecord {
  if ("placement" in page) return page.placement;
  return {
    type: "MediaPlacement",
    placementVersion: 1,
    id: `screenshot-${page.id}`,
    evidenceId: `screenshot-${page.id}`,
    ...page.screenshotLayout,
    angle: ((page.screenshotLayout.angle % 360) + 360) % 360,
    zIndex: 0,
  };
}

function withRuntimeCropSource(
  object: Record<string, unknown>,
  sourceUrl: string,
): Record<string, unknown> {
  const data = object.data as ObjectTag | undefined;
  if (data?.kind !== "crop" || typeof object.src === "string") return object;
  return { ...object, src: sourceUrl };
}

function upgradeSerializedAnnotation(
  object: Record<string, unknown>,
): Record<string, unknown> {
  const data = object.data as ObjectTag | undefined;
  if (
    data?.kind === "note" &&
    (object.type === "Textbox" || object.type === "textbox")
  ) {
    return {
      ...object,
      type: NoteTextbox.type,
      boxHeight: Number(object.height) || 120,
    };
  }
  return object;
}

function contrastingDotColor(color: string): string {
  const hex = color.match(/^#([0-9a-f]{6})$/i)?.[1];
  if (!hex) return "rgba(110, 116, 122, .28)";
  const red = Number.parseInt(hex.slice(0, 2), 16);
  const green = Number.parseInt(hex.slice(2, 4), 16);
  const blue = Number.parseInt(hex.slice(4, 6), 16);
  const luminance = (red * 299 + green * 587 + blue * 114) / 255000;
  return luminance > 0.52
    ? "rgba(74, 80, 87, .24)"
    : "rgba(238, 241, 243, .32)";
}

function styleExtractedImage(image: FabricImage): void {
  image.set({
    stroke: "#ffffff",
    strokeWidth: 2,
    strokeUniform: true,
    lockScalingFlip: true,
    cornerColor: "#ffffff",
    cornerStrokeColor: "#1e7a6c",
    borderColor: "#1e7a6c",
    transparentCorners: false,
    cornerSize: 13,
    hoverCursor: "move",
    objectCaching: false,
    imageSmoothing: true,
    shadow: new Shadow({
      color: "rgba(24, 28, 32, .2)",
      blur: 14,
      offsetY: 5,
    }),
  });
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
