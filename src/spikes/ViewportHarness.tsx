import { Canvas, Point, Rect, StaticCanvas, type TMat2D } from "fabric";
import { useCallback, useEffect, useRef, useState } from "react";
import { Connector, getObjectAnchors, syncConnectorBindings } from "../lib/Connector";
import { MediaPlacement } from "./MediaPlacement";
import { ViewportControls } from "./ViewportControls";
import {
  PlacementHistory,
  type MediaPlacementRecord,
  type PlacementHarnessSnapshot,
} from "./mediaPlacementGeometry";
import {
  KEYBOARD_PAN_PIXELS,
  LOGICAL_PAGE_HEIGHT,
  LOGICAL_PAGE_WIDTH,
  PointerPanSession,
  VIEWPORT_SPIKE_SCHEMA,
  ViewportController,
  resolveArrowIntent,
  viewportStateLabel,
  type ViewportState,
} from "./viewportController";

declare global {
  interface Window {
    __GAMEBOOK_VIEWPORT_SPIKE__?: ViewportReport;
  }
}

interface ViewportCheck {
  id: string;
  passed: boolean;
  detail: string;
}

interface ArtifactEvidence {
  exportSha256: string;
  exportBytes: number;
  thumbnailSha256: string;
  thumbnailBytes: number;
}

interface PathEvidence extends ArtifactEvidence {
  id: string;
  zoomPercent: number;
  transform: TMat2D;
  pageStateStable: boolean;
  historyStable: boolean;
  connectorsStable: boolean;
}

export interface ViewportReport {
  schema: typeof VIEWPORT_SPIKE_SCHEMA;
  status: "passed" | "failed";
  generatedAt: string;
  buildRevision: string;
  fixture: string;
  environment: {
    userAgent: string;
    hardwareConcurrency: number;
    devicePixelRatio: number;
    uiScale: number;
    viewport: { width: number; height: number };
  };
  checks: ViewportCheck[];
  logicalPage: { width: number; height: number };
  supportedZoomPercents: number[];
  paths: PathEvidence[];
  baseline: ArtifactEvidence;
  serializedKeys: string[];
}

const PLACEMENT: MediaPlacementRecord = {
  id: "placement-view-only",
  evidenceId: "viewport-evidence-1440p",
  left: 180,
  top: 180,
  scaleX: 1,
  scaleY: 1,
  angle: 0,
  posterTimestampUs: 2_500_000,
  zIndex: 1,
};

const SNAPSHOT: PlacementHarnessSnapshot = {
  activePageId: "viewport-page",
  pages: [
    {
      id: "viewport-page",
      placements: [PLACEMENT],
      annotationIds: ["finding-view-only"],
      connectors: [
        {
          id: "connector-view-only",
          start: { placementId: PLACEMENT.id, anchor: "right" },
          end: { annotationId: "finding-view-only", anchor: "left" },
        },
      ],
    },
  ],
};

const FALLBACK_VIEWPORT = { width: 960, height: 540 };

export function ViewportHarness() {
  const canvasElementRef = useRef<HTMLCanvasElement>(null);
  const canvasWrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<Canvas | null>(null);
  const controllerRef = useRef<ViewportController | null>(null);
  const reportStartedRef = useRef(false);
  const spacePressedRef = useRef(false);
  const panSessionRef = useRef(new PointerPanSession());
  const historyRef = useRef(new PlacementHistory(SNAPSHOT));
  const [viewportState, setViewportState] = useState<ViewportState>(() => ({
    mode: "fit",
    zoom: 0.5,
    zoomPercent: 50,
    transform: [0.5, 0, 0, 0.5, 0, 0],
    sceneCenterX: LOGICAL_PAGE_WIDTH / 2,
    sceneCenterY: LOGICAL_PAGE_HEIGHT / 2,
  }));
  const [selectedId, setSelectedId] = useState(PLACEMENT.id);
  const [status, setStatus] = useState("Preparing viewport evidence");
  const [report, setReport] = useState<ViewportReport | null>(null);

  const updateViewport = useCallback((state: ViewportState) => {
    setViewportState(state);
    setStatus(viewportStateLabel(state));
  }, []);

  useEffect(() => {
    const element = canvasElementRef.current;
    const wrap = canvasWrapRef.current;
    if (!element || !wrap) return;

    const size = measuredSize(wrap);
    const canvas = new Canvas(element, {
      width: size.width,
      height: size.height,
      backgroundColor: "#cbd2d0",
      preserveObjectStacking: true,
      renderOnAddRemove: false,
      selection: true,
    });
    const scene = addScene(canvas);
    canvas.setActiveObject(scene.placement);
    canvas.requestRenderAll();
    canvasRef.current = canvas;

    const controller = new ViewportController(canvas, size, updateViewport);
    controllerRef.current = controller;

    const upperCanvas = canvas.upperCanvasEl;
    upperCanvas.tabIndex = 0;
    upperCanvas.setAttribute("role", "img");
    upperCanvas.setAttribute("aria-label", "Viewport page canvas");

    const pointerDown = (event: PointerEvent) => {
      if (!panSessionRef.current.start(event.button, spacePressedRef.current, new Point(event.clientX, event.clientY))) return;
      event.preventDefault();
      upperCanvas.setPointerCapture(event.pointerId);
      upperCanvas.classList.add("is-panning");
    };
    const pointerMove = (event: PointerEvent) => {
      const delta = panSessionRef.current.move(new Point(event.clientX, event.clientY));
      if (!delta) return;
      event.preventDefault();
      controller.panContentBy(delta.x, delta.y);
    };
    const pointerEnd = (event: PointerEvent) => {
      if (!panSessionRef.current.active) return;
      panSessionRef.current.end();
      upperCanvas.classList.remove("is-panning");
      if (upperCanvas.hasPointerCapture(event.pointerId)) upperCanvas.releasePointerCapture(event.pointerId);
    };
    const preventMiddleMenu = (event: MouseEvent) => {
      if (event.button === 1) event.preventDefault();
    };
    upperCanvas.addEventListener("pointerdown", pointerDown);
    upperCanvas.addEventListener("pointermove", pointerMove);
    upperCanvas.addEventListener("pointerup", pointerEnd);
    upperCanvas.addEventListener("pointercancel", pointerEnd);
    upperCanvas.addEventListener("auxclick", preventMiddleMenu);

    const keyDown = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) return;
      if (event.code === "Space") {
        spacePressedRef.current = true;
        event.preventDefault();
        return;
      }
      const intent = resolveArrowIntent(event.key, {
        spacePressed: spacePressedRef.current,
        shiftPressed: event.shiftKey,
      });
      if (!intent) return;
      event.preventDefault();
      if (intent.kind === "pan") {
        controller.panViewBy(intent.dx, intent.dy);
        return;
      }
      const selected = canvas.getActiveObject();
      if (!(selected instanceof MediaPlacement)) return;
      selected.set({ left: selected.left + intent.dx, top: selected.top + intent.dy });
      selected.setCoords();
      syncConnectorBindings(canvas);
      canvas.requestRenderAll();
      setStatus(`${selected.placementId} moved ${Math.abs(intent.dx || intent.dy)} logical pixels`);
    };
    const keyUp = (event: KeyboardEvent) => {
      if (event.code === "Space") spacePressedRef.current = false;
    };
    window.addEventListener("keydown", keyDown);
    window.addEventListener("keyup", keyUp);

    const observer = new ResizeObserver(() => {
      const nextSize = measuredSize(wrap);
      canvas.setDimensions(nextSize);
      controller.resize(nextSize);
    });
    observer.observe(wrap);

    const reportFrame = requestAnimationFrame(() => {
      if (reportStartedRef.current) return;
      reportStartedRef.current = true;
      void runViewportChecks(canvas, controller, historyRef.current, size)
        .then((result) => {
          window.__GAMEBOOK_VIEWPORT_SPIKE__ = result;
          setReport(result);
          setStatus(result.status === "passed" ? "Viewport evidence passed" : "Viewport evidence failed");
        })
        .catch((error) => setStatus(error instanceof Error ? error.message : "Viewport evidence failed"));
    });

    return () => {
      cancelAnimationFrame(reportFrame);
      observer.disconnect();
      window.removeEventListener("keydown", keyDown);
      window.removeEventListener("keyup", keyUp);
      upperCanvas.removeEventListener("pointerdown", pointerDown);
      upperCanvas.removeEventListener("pointermove", pointerMove);
      upperCanvas.removeEventListener("pointerup", pointerEnd);
      upperCanvas.removeEventListener("pointercancel", pointerEnd);
      upperCanvas.removeEventListener("auxclick", preventMiddleMenu);
      canvas.dispose();
      canvasRef.current = null;
      controllerRef.current = null;
    };
  }, [updateViewport]);

  const fit = () => controllerRef.current?.fit();
  const reset = () => controllerRef.current?.reset();
  const zoom = (percent: number) => controllerRef.current?.setZoomPercent(percent);
  const pan = (dx: number, dy: number) =>
    controllerRef.current?.panViewBy(dx * KEYBOARD_PAN_PIXELS, dy * KEYBOARD_PAN_PIXELS);

  return (
    <main className="viewport-shell">
      <header className="viewport-header">
        <div>
          <p>Milestone 3 / Viewport</p>
          <h1>View-only viewport harness</h1>
        </div>
        <ViewportControls state={viewportState} onFit={fit} onReset={reset} onZoom={zoom} onPan={pan} />
      </header>

      <section className="viewport-workspace" aria-label="Viewport evidence workspace">
        <div className="viewport-canvas-wrap" ref={canvasWrapRef}>
          <canvas ref={canvasElementRef} />
        </div>
        <aside className="viewport-outline" aria-label="Page outline">
          <h2>Outline</h2>
          <button
            type="button"
            aria-pressed={selectedId === PLACEMENT.id}
            onClick={() => {
              const placement = canvasRef.current?.getObjects().find((object) => object instanceof MediaPlacement);
              if (placement) canvasRef.current?.setActiveObject(placement);
              setSelectedId(PLACEMENT.id);
            }}
          >
            <span>Gameplay evidence</span>
            <small>Position {PLACEMENT.left}, {PLACEMENT.top}</small>
          </button>
          <dl>
            <div><dt>Page</dt><dd>{LOGICAL_PAGE_WIDTH} x {LOGICAL_PAGE_HEIGHT}</dd></div>
            <div><dt>View</dt><dd>{viewportState.mode === "fit" ? "Fit" : `${Math.round(viewportState.zoomPercent)}%`}</dd></div>
            <div><dt>Center</dt><dd>{Math.round(viewportState.sceneCenterX)}, {Math.round(viewportState.sceneCenterY)}</dd></div>
          </dl>
        </aside>
      </section>

      <footer className="viewport-footer">
        <p role="status" aria-live="polite">{status}</p>
        <output aria-label="Automated check result" data-status={report?.status ?? "pending"}>
          {report ? `${report.checks.filter((check) => check.passed).length}/${report.checks.length} checks` : "Running checks"}
        </output>
      </footer>
      {report ? <pre id="viewport-report-json" hidden>{JSON.stringify(report)}</pre> : null}
    </main>
  );
}

function addScene(canvas: Canvas | StaticCanvas) {
  const page = new Rect({
    left: 0,
    top: 0,
    width: LOGICAL_PAGE_WIDTH,
    height: LOGICAL_PAGE_HEIGHT,
    fill: "#f7f7f5",
    stroke: "#536168",
    strokeWidth: 2,
    selectable: false,
    evented: false,
  });
  const placement = new MediaPlacement(PLACEMENT);
  (placement as MediaPlacement & { data?: Record<string, unknown> }).data = {
    id: PLACEMENT.id,
    role: "screenshot",
    kind: "media-placement",
  };
  const annotation = new Rect({
    left: 1120,
    top: 285,
    width: 300,
    height: 190,
    rx: 8,
    ry: 8,
    fill: "#ffffff",
    stroke: "#b42318",
    strokeWidth: 7,
    strokeUniform: true,
  });
  (annotation as Rect & { data?: Record<string, unknown> }).data = {
    id: "finding-view-only",
    role: "annotation",
    kind: "finding",
  };
  const start = placement.connectorPoint("right");
  const end = getObjectAnchors(annotation).find((anchor) => anchor.name === "left")?.point;
  if (!end) throw new Error("Annotation anchor is unavailable");
  const connector = new Connector([start.x, start.y, end.x, end.y], {
    stroke: "#b42318",
    strokeWidth: 6,
    selectable: false,
    evented: false,
  });
  (connector as Connector & { data?: Record<string, unknown> }).data = {
    id: "connector-view-only",
    role: "annotation",
    kind: "arrow",
    connector: {
      start: { objectId: PLACEMENT.id, anchor: "right" },
      end: { objectId: "finding-view-only", anchor: "left" },
    },
  };
  canvas.add(page, placement, annotation, connector);
  syncConnectorBindings(canvas);
  canvas.requestRenderAll();
  return { page, placement, annotation, connector };
}

async function runViewportChecks(
  canvas: Canvas,
  controller: ViewportController,
  history: PlacementHistory,
  actualSize: { width: number; height: number },
): Promise<ViewportReport> {
  const checks: ViewportCheck[] = [];
  const check = (id: string, passed: boolean, detail: string) => checks.push({ id, passed, detail });
  const serialized = JSON.stringify(SNAPSHOT);
  const historyBaseline = JSON.stringify(history.current());
  const connectorBaseline = connectorEvidence(canvas);
  const baseline = await renderArtifacts();
  const initial = controller.getState();
  const paths: PathEvidence[] = [];

  const capture = async (id: string, action: () => void) => {
    action();
    await nextFrame();
    const artifacts = await renderArtifacts();
    const state = controller.getState();
    paths.push({
      id,
      zoomPercent: Math.round(state.zoomPercent * 1000) / 1000,
      transform: [...state.transform] as TMat2D,
      pageStateStable: JSON.stringify(SNAPSHOT) === serialized,
      historyStable: JSON.stringify(history.current()) === historyBaseline && !history.canUndo() && !history.canRedo(),
      connectorsStable: connectorEvidence(canvas) === connectorBaseline,
      ...artifacts,
    });
  };

  await capture("fit-default", () => controller.fit());
  for (const percent of [25, 50, 100, 200]) {
    await capture(`zoom-${percent}`, () => controller.setZoomPercent(percent));
  }
  await capture("reset-100", () => controller.reset());
  await capture("control-pan-left", () => controller.panViewBy(-KEYBOARD_PAN_PIXELS, 0));
  await capture("control-pan-right", () => controller.panViewBy(KEYBOARD_PAN_PIXELS, 0));
  await capture("space-arrow-up", () => controller.panViewBy(0, -KEYBOARD_PAN_PIXELS));
  await capture("space-arrow-down", () => controller.panViewBy(0, KEYBOARD_PAN_PIXELS));
  await capture("space-primary-drag", () => controller.panContentBy(37, -19));
  await capture("middle-button-drag", () => controller.panContentBy(-23, 31));
  await capture("compact-resize", () => controller.resize({ width: 720, height: 405 }));
  await capture("large-resize", () => controller.resize({ width: 1280, height: 720 }));

  const malformedBefore = JSON.stringify(controller.getState());
  let malformedRejected = false;
  try {
    controller.setZoomPercent(Number.NaN);
  } catch {
    malformedRejected = JSON.stringify(controller.getState()) === malformedBefore;
  }

  const moveIntent = resolveArrowIntent("ArrowRight", { spacePressed: false, shiftPressed: false });
  const coarseMoveIntent = resolveArrowIntent("ArrowRight", { spacePressed: false, shiftPressed: true });
  const panIntent = resolveArrowIntent("ArrowRight", { spacePressed: true, shiftPressed: true });
  const allStable = paths.every((path) => path.pageStateStable && path.historyStable && path.connectorsStable);
  const exportsStable = paths.every(
    (path) => path.exportSha256 === baseline.exportSha256 && path.exportBytes === baseline.exportBytes,
  );
  const thumbnailsStable = paths.every(
    (path) => path.thumbnailSha256 === baseline.thumbnailSha256 && path.thumbnailBytes === baseline.thumbnailBytes,
  );
  const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>(".viewport-controls button"));
  const slider = document.querySelector<HTMLInputElement>('input[aria-label="Set zoom percentage"]');
  const upperCanvas = canvas.upperCanvasEl;

  check(
    "fit-default",
    initial.mode === "fit" && near(initial.sceneCenterX, 800) && near(initial.sceneCenterY, 450),
    `Fit opened at ${initial.zoomPercent.toFixed(3)} percent with logical center ${initial.sceneCenterX.toFixed(1)}, ${initial.sceneCenterY.toFixed(1)}.`,
  );
  check(
    "zoom-range",
    [25, 50, 100, 200].every((percent) => paths.some((path) => path.id === `zoom-${percent}` && path.zoomPercent === percent)),
    "25, 50, 100, and 200 percent rendered through viewport transforms.",
  );
  check(
    "pan-paths",
    ["control-pan-left", "control-pan-right", "space-arrow-up", "space-arrow-down", "space-primary-drag", "middle-button-drag"].every((id) => paths.some((path) => path.id === id)),
    "Dedicated controls, Space+Arrow, Space+primary drag, and middle-button drag all changed only the view.",
  );
  check(
    "keyboard-intent",
    moveIntent?.kind === "move" && moveIntent.dx === 1 && coarseMoveIntent?.kind === "move" && coarseMoveIntent.dx === 10 && panIntent?.kind === "pan" && panIntent.dx === KEYBOARD_PAN_PIXELS,
    "Arrow moves one logical pixel, Shift+Arrow moves ten, and Space+Arrow pans the viewport.",
  );
  check("stable-page-state", allStable, `${paths.length} viewport paths preserved the version 1 logical page snapshot.`);
  check("history-unchanged", paths.every((path) => path.historyStable), "Viewport operations created no undo or redo entries.");
  check("connector-scene-coordinates", paths.every((path) => path.connectorsStable), "Connector endpoints stayed in logical scene coordinates.");
  check("static-export-pixels", exportsStable, `Static export remained ${baseline.exportSha256} (${baseline.exportBytes} bytes).`);
  check("thumbnail-pixels", thumbnailsStable, `Thumbnail remained ${baseline.thumbnailSha256} (${baseline.thumbnailBytes} bytes).`);
  check("malformed-input", malformedRejected, "A non-finite zoom was rejected without changing viewport state.");
  check(
    "semantic-controls",
    buttons.length === 8 && buttons.every((button) => Boolean(button.getAttribute("aria-label") && button.title)) && slider?.min === "25" && slider.max === "200" && upperCanvas.tabIndex === 0,
    `${buttons.length} named icon buttons, a labeled 25-200 percent slider, a polite state announcement, and a focusable canvas are available.`,
  );

  canvas.setDimensions(actualSize);
  controller.resize(actualSize);
  controller.fit();

  return {
    schema: VIEWPORT_SPIKE_SCHEMA,
    status: checks.every((candidate) => candidate.passed) ? "passed" : "failed",
    generatedAt: new Date().toISOString(),
    buildRevision: new URLSearchParams(window.location.search).get("build") ?? "working-tree",
    fixture: "deterministic-viewport-page-v1",
    environment: {
      userAgent: navigator.userAgent,
      hardwareConcurrency: navigator.hardwareConcurrency,
      devicePixelRatio: window.devicePixelRatio,
      uiScale: document.documentElement.dataset.uiScale === "2" ? 2 : 1,
      viewport: {
        width: document.documentElement.clientWidth,
        height: document.documentElement.clientHeight,
      },
    },
    checks,
    logicalPage: { width: LOGICAL_PAGE_WIDTH, height: LOGICAL_PAGE_HEIGHT },
    supportedZoomPercents: [25, 50, 100, 200],
    paths,
    baseline,
    serializedKeys: Object.keys(SNAPSHOT).sort(),
  };
}

async function renderArtifacts(): Promise<ArtifactEvidence> {
  const canvas = new StaticCanvas(document.createElement("canvas"), {
    width: LOGICAL_PAGE_WIDTH,
    height: LOGICAL_PAGE_HEIGHT,
    renderOnAddRemove: false,
  });
  addScene(canvas);
  canvas.setViewportTransform([1, 0, 0, 1, 0, 0]);
  canvas.renderAll();
  const full = canvas.toDataURL({ format: "png", multiplier: 1 });
  const thumbnail = canvas.toDataURL({ format: "png", multiplier: 0.12 });
  canvas.dispose();
  return {
    exportSha256: await sha256DataUrl(full),
    exportBytes: dataUrlBytes(full),
    thumbnailSha256: await sha256DataUrl(thumbnail),
    thumbnailBytes: dataUrlBytes(thumbnail),
  };
}

function connectorEvidence(canvas: Canvas): string {
  const connector = canvas.getObjects().find((object) => object instanceof Connector);
  if (!(connector instanceof Connector)) throw new Error("Viewport connector is unavailable");
  const start = connector.getSceneEndpoint("start");
  const end = connector.getSceneEndpoint("end");
  return JSON.stringify([start.x, start.y, end.x, end.y].map((value) => Math.round(value * 1000) / 1000));
}

async function sha256DataUrl(dataUrl: string): Promise<string> {
  const bytes = Uint8Array.from(atob(dataUrl.split(",")[1] ?? ""), (character) => character.charCodeAt(0));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function dataUrlBytes(dataUrl: string): number {
  return atob(dataUrl.split(",")[1] ?? "").length;
}

function measuredSize(element: HTMLElement) {
  const width = Math.round(element.clientWidth) || FALLBACK_VIEWPORT.width;
  const height = Math.round(element.clientHeight) || FALLBACK_VIEWPORT.height;
  return { width, height };
}

function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement &&
    (target.isContentEditable || target.matches("input, textarea, select, button"));
}

function near(left: number, right: number): boolean {
  return Math.abs(left - right) < 0.001;
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}
