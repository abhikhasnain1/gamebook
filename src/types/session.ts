export type ToolId =
  | "select"
  | "pen"
  | "arrow"
  | "callout"
  | "line"
  | "box"
  | "circle"
  | "crop"
  | "text";

export interface CapturePayload {
  dataUrl: string;
  thumbnailDataUrl?: string;
  capturedAt: string;
  monitorName: string;
  width: number;
  height: number;
  monitorX?: number;
  monitorY?: number;
}

export interface AnnotationSnapshot {
  objects: Record<string, unknown>[];
}

export interface ScreenshotLayout {
  left: number;
  top: number;
  scaleX: number;
  scaleY: number;
  angle: number;
}

export type PageContentPatch = Pick<
  GamebookPage,
  | "annotations"
  | "screenshotLayout"
  | "thumbnailDataUrl"
  | "extractedText"
  | "backgroundColor"
>;

export interface GamebookPage {
  id: string;
  title: string;
  createdAt: string;
  monitorName: string;
  sourceWidth: number;
  sourceHeight: number;
  screenshotDataUrl: string;
  screenshotLayout: ScreenshotLayout;
  annotations: AnnotationSnapshot;
  thumbnailDataUrl: string;
  extractedText: string;
  backgroundColor: string;
}

export interface GamebookSession {
  formatVersion: 1;
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  activePageId: string | null;
  pages: GamebookPage[];
}

export function createEmptySession(): GamebookSession {
  const now = new Date().toISOString();
  return {
    formatVersion: 1,
    id: crypto.randomUUID(),
    title: "Untitled gamebook",
    createdAt: now,
    updatedAt: now,
    activePageId: null,
    pages: [],
  };
}

export function pageFromCapture(
  capture: CapturePayload,
  pageNumber: number,
): GamebookPage {
  return {
    id: crypto.randomUUID(),
    title: String(pageNumber),
    createdAt: capture.capturedAt,
    monitorName: capture.monitorName,
    sourceWidth: capture.width,
    sourceHeight: capture.height,
    screenshotDataUrl: capture.dataUrl,
    screenshotLayout: defaultScreenshotLayout(capture.width, capture.height),
    annotations: { objects: [] },
    thumbnailDataUrl: capture.thumbnailDataUrl ?? capture.dataUrl,
    extractedText: "",
    backgroundColor: "#f7f7f5",
  };
}

export function pageFromExistingScreenshot(
  source: GamebookPage,
  pageNumber: number,
): GamebookPage {
  return {
    ...source,
    id: crypto.randomUUID(),
    title: String(pageNumber),
    createdAt: new Date().toISOString(),
    annotations: { objects: [] },
    extractedText: "",
    thumbnailDataUrl: source.screenshotDataUrl,
  };
}

export function numberPages(pages: GamebookPage[]): GamebookPage[] {
  return pages.map((page, index) => ({ ...page, title: String(index + 1) }));
}

export function parseSession(content: string): GamebookSession {
  const parsed = JSON.parse(content) as GamebookSession;
  if (parsed.formatVersion !== 1 || !Array.isArray(parsed.pages)) {
    throw new Error("This project format is not supported.");
  }
  return {
    ...parsed,
    pages: numberPages(
      parsed.pages.map((page) => ({
        ...page,
        screenshotLayout:
          page.screenshotLayout ??
          defaultScreenshotLayout(page.sourceWidth, page.sourceHeight),
        backgroundColor: page.backgroundColor ?? "#f7f7f5",
      })),
    ),
  };
}

export function defaultScreenshotLayout(
  sourceWidth: number,
  sourceHeight: number,
): ScreenshotLayout {
  const safeWidth = Math.max(1, sourceWidth);
  const safeHeight = Math.max(1, sourceHeight);
  const scale = Math.min(820 / safeWidth, 650 / safeHeight);
  return {
    left: 68,
    top: 112,
    scaleX: scale,
    scaleY: scale,
    angle: 0,
  };
}
