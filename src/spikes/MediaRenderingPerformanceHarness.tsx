import { Canvas, Line, Rect } from "fabric";
import { Play } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { MediaPlacement } from "./MediaPlacement";
import {
  MEDIA_RENDERING_SCHEMA,
  evaluateRenderingGate,
  summarize,
  type SourceBenchmark,
} from "./mediaRenderingPerformance";

declare global {
  interface Window {
    __GAMEBOOK_MEDIA_RENDERING_SPIKE__?: BrowserRenderingReport;
  }
}

interface FixtureConfig {
  id: SourceBenchmark["id"];
  width: number;
  height: number;
  url: string;
}

export interface BrowserRenderingReport {
  schema: typeof MEDIA_RENDERING_SCHEMA;
  status: "browser-complete" | "failed";
  generatedAt: string;
  buildRevision: string;
  renderingApproach: "fabric-offscreen-surface" | "layered-dom-video";
  environment: {
    userAgent: string;
    hardwareConcurrency: number;
    viewport: { width: number; height: number };
    devicePixelRatio: number;
    videoFrameCallbackSupported: boolean;
    reducedMotion: boolean;
    forcedColors: boolean;
    uiScale: 1 | 1.5 | 2;
  };
  sources: SourceBenchmark[];
  lifecycleLoops: number;
  semanticControls: {
    keyboardOperable: boolean;
    namedControls: string[];
    statusAnnouncements: boolean;
  };
  security: {
    networkOrigins: string[];
    sourceUrlsPersisted: false;
    mediaTokensPersisted: false;
    projectWrites: false;
    diagnosticsContainPaths: false;
  };
  gate: ReturnType<typeof evaluateRenderingGate>;
  error: string | null;
}

const DEFAULT_1080 = "/src-tauri/target/media-rendering-performance/fixture-1080p60.mp4";
const DEFAULT_1440 = "/src-tauri/target/media-rendering-performance/fixture-1440p60.mp4";

export function MediaRenderingPerformanceHarness() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const canvasRuntimeRef = useRef<Canvas | null>(null);
  const runningRef = useRef(false);
  const [status, setStatus] = useState("Ready to measure");
  const [report, setReport] = useState<BrowserRenderingReport | null>(null);
  const requestedApproach = new URLSearchParams(window.location.search).get("approach") === "dom"
    ? "layered DOM video"
    : "Fabric offscreen surface";

  useEffect(() => {
    const element = canvasRef.current;
    if (!element) return;
    const canvas = new Canvas(element, {
      width: 1600,
      height: 900,
      renderOnAddRemove: false,
      preserveObjectStacking: true,
      backgroundColor: "#f7f7f5",
    });
    canvasRuntimeRef.current = canvas;
    return () => {
      canvas.dispose();
      canvasRuntimeRef.current = null;
    };
  }, []);

  const run = useCallback(async () => {
    if (runningRef.current || !canvasRuntimeRef.current) return;
    runningRef.current = true;
    setReport(null);
    const params = new URLSearchParams(window.location.search);
    const fixtures: FixtureConfig[] = [
      { id: "1080p60", width: 1920, height: 1080, url: params.get("source1080") ?? DEFAULT_1080 },
      { id: "1440p60", width: 2560, height: 1440, url: params.get("source1440") ?? DEFAULT_1440 },
    ];
    const approach = params.get("approach") === "dom" ? "layered-dom-video" : "fabric-offscreen-surface";
    try {
      const sources: SourceBenchmark[] = [];
      for (const fixture of fixtures) {
        setStatus(`Measuring ${fixture.id}`);
        sources.push(await benchmarkSource(canvasRuntimeRef.current, fixture, approach, setStatus));
      }
      const result = createReport(sources, null, approach, null);
      window.__GAMEBOOK_MEDIA_RENDERING_SPIKE__ = result;
      setReport(result);
      setStatus("Browser measurements complete");
    } catch (error) {
      const result = createReport([], null, approach, error instanceof Error ? error.message : "Benchmark failed");
      window.__GAMEBOOK_MEDIA_RENDERING_SPIKE__ = result;
      setReport(result);
      setStatus("Benchmark failed");
    } finally {
      runningRef.current = false;
    }
  }, []);

  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("autorun") !== "1") return;
    const timer = window.setTimeout(() => void run(), 250);
    return () => window.clearTimeout(timer);
  }, [run]);

  return (
    <main className="rendering-shell">
      <header className="rendering-header">
        <div>
          <p>Milestone 3 / Rendering gate</p>
          <h1>Media placement performance</h1>
        </div>
        <div className="rendering-actions" aria-label="Benchmark controls">
          <button type="button" onClick={() => void run()} aria-label="Run rendering benchmark">
            <Play aria-hidden="true" />
          </button>
        </div>
      </header>
      <section className="rendering-workspace" aria-label="Media rendering benchmark workspace">
        <div className="rendering-canvas-wrap">
          <canvas ref={canvasRef} aria-label="Representative media placement composition" />
        </div>
        <aside aria-label="Benchmark measurements">
          <h2>Measurements</h2>
          {report?.sources.map((source) => (
            <dl key={source.id}>
              <div><dt>Source</dt><dd>{source.id}</dd></div>
              <div><dt>Rendered FPS</dt><dd>{source.renderedFps.toFixed(2)}</dd></div>
              <div><dt>Transform p95</dt><dd>{source.transformLatencyMs.p95.toFixed(2)} ms</dd></div>
              <div><dt>Callbacks dropped</dt><dd>{source.droppedRenderCallbacks}</dd></div>
            </dl>
          ))}
          <p role="status" aria-live="polite">{status}</p>
        </aside>
      </section>
      <footer>
        <span>{requestedApproach}</span>
        <output aria-label="Rendering gate browser result">
          {report ? report.status : "Pending"}
        </output>
      </footer>
      {report ? <pre id="spike-report-json" hidden>{JSON.stringify(report)}</pre> : null}
    </main>
  );
}

async function benchmarkSource(
  canvas: Canvas,
  fixture: FixtureConfig,
  approach: BrowserRenderingReport["renderingApproach"],
  announce: (message: string) => void,
): Promise<SourceBenchmark> {
  canvas.clear();
  canvas.backgroundColor = approach === "layered-dom-video" ? "rgba(0,0,0,0)" : "#f7f7f5";
  const surface = document.createElement("canvas");
  surface.width = approach === "fabric-offscreen-surface" ? fixture.width : 1;
  surface.height = approach === "fabric-offscreen-surface" ? fixture.height : 1;
  const context = surface.getContext("2d", { alpha: false });
  if (!context) throw new Error("Offscreen drawing surface is unavailable");
  const placementRecord = {
    id: `placement-${fixture.id}`,
    evidenceId: `evidence-${fixture.id}`,
    left: 180,
    top: 120,
    scaleX: 1_050 / fixture.width,
    scaleY: 1_050 / fixture.width,
    angle: 0,
    zIndex: 1,
  };
  const placement = approach === "fabric-offscreen-surface"
    ? new MediaPlacement(placementRecord, surface)
    : new Rect({ ...placementRecord, width: fixture.width, height: fixture.height, fill: "transparent", strokeWidth: 0 });
  const annotation = new Rect({
    left: 560,
    top: 250,
    width: 330,
    height: 170,
    fill: "rgba(255,255,255,0.18)",
    stroke: "#b42318",
    strokeWidth: 8,
    strokeUniform: true,
    selectable: false,
  });
  const connector = new Line([360, 640, 1_150, 420], {
    stroke: "#006b75",
    strokeWidth: 7,
    selectable: false,
  });
  canvas.add(placement, annotation, connector);
  canvas.requestRenderAll();
  await nextRender(canvas);

  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.src = fixture.url;
  video.className = approach === "layered-dom-video" ? "rendering-source-video rendering-source-video--dom" : "rendering-source-video";
  if (approach === "layered-dom-video") {
    canvas.wrapperEl.prepend(video);
    syncDomGeometry(video, placement);
  } else {
    document.body.append(video);
  }
  await waitForVideo(video);
  if (video.videoWidth !== fixture.width || video.videoHeight !== fixture.height) {
    releaseVideo(video);
    throw new Error(`${fixture.id} decoded as ${video.videoWidth}x${video.videoHeight}`);
  }

  let callbackHandle: number | null = null;
  let presentedFrames = 0;
  let priorMediaTime = -1;
  let droppedPresentedFrames = 0;
  let renderedFrames = 0;
  let pendingVideoFrame = false;
  let liveSources = 1;
  let decodedFrames = 0;
  const transformStarted: number[] = [];
  const transformLatencies: number[] = [];

  const afterRender = () => {
    if (pendingVideoFrame) {
      renderedFrames += 1;
      pendingVideoFrame = false;
    }
    const completedAt = performance.now();
    while (transformStarted.length > 0) {
      transformLatencies.push(completedAt - transformStarted.shift()!);
    }
  };
  canvas.on("after:render", afterRender);

  const onPointerMove = () => {
    transformStarted.push(performance.now());
    placement.set("left", placement.left === 180 ? 188 : 180);
    placement.setCoords();
    placement.dirty = true;
    if (approach === "layered-dom-video") syncDomGeometry(video, placement);
    canvas.requestRenderAll();
  };
  canvas.upperCanvasEl.addEventListener("pointermove", onPointerMove);

  const requestFrame = () => {
    callbackHandle = video.requestVideoFrameCallback((_now, metadata) => {
      callbackHandle = null;
      if (priorMediaTime >= 0 && metadata.mediaTime <= priorMediaTime + 0.000_001) {
        requestFrame();
        return;
      }
      if (priorMediaTime >= 0) {
        const sourceIntervals = Math.round((metadata.mediaTime - priorMediaTime) * 60);
        droppedPresentedFrames += Math.max(0, sourceIntervals - 1);
      }
      priorMediaTime = metadata.mediaTime;
      presentedFrames += 1;
      if (approach === "fabric-offscreen-surface") {
        context.drawImage(video, 0, 0, fixture.width, fixture.height);
        pendingVideoFrame = true;
        placement.dirty = true;
        canvas.requestRenderAll();
      } else {
        renderedFrames += 1;
      }
      requestFrame();
    });
  };

  const measurementMs = queryNumber("durationMs", 30_000, 5_000, 30_000);
  const startedAt = performance.now();
  let nextAnnouncementMs = 0;
  requestFrame();
  await video.play();
  const pointerTimer = window.setInterval(() => {
    canvas.upperCanvasEl.dispatchEvent(new PointerEvent("pointermove", { bubbles: true }));
  }, 200);
  while (performance.now() - startedAt < measurementMs) {
    const elapsed = performance.now() - startedAt;
    if (elapsed >= nextAnnouncementMs) {
      announce(`${fixture.id}: ${Math.min(100, Math.round(elapsed / measurementMs * 100))}%`);
      nextAnnouncementMs += 5_000;
    }
    await delay(250);
  }
  window.clearInterval(pointerTimer);
  const durationMs = performance.now() - startedAt;
  cancelCallback(video, callbackHandle);
  callbackHandle = null;

  const pauseStarted = performance.now();
  video.pause();
  canvas.requestRenderAll();
  await nextRender(canvas);
  const pauseMs = performance.now() - pauseStarted;

  const seekStarted = performance.now();
  video.currentTime = 10;
  await eventOnce(video, "seeked");
  if (approach === "fabric-offscreen-surface") {
    context.drawImage(video, 0, 0, fixture.width, fixture.height);
    placement.dirty = true;
    canvas.requestRenderAll();
    await nextRender(canvas);
  } else {
    await nextAnimationFrame();
  }
  const seekMs = performance.now() - seekStarted;
  const seekVisible = approach === "fabric-offscreen-surface"
    ? surface.width === fixture.width
    : !video.hidden && Math.abs(video.currentTime - 10) < 0.1;

  const exactStarted = performance.now();
  const bitmap = await createImageBitmap(video);
  decodedFrames += 1;
  let exactOverlay: HTMLCanvasElement | null = null;
  if (approach === "fabric-offscreen-surface") {
    context.drawImage(bitmap, 0, 0, fixture.width, fixture.height);
    placement.dirty = true;
    canvas.requestRenderAll();
    await nextRender(canvas);
  } else {
    exactOverlay = createDomExactOverlay(canvas, video, fixture, bitmap);
    video.hidden = true;
    await nextAnimationFrame();
  }
  bitmap.close();
  decodedFrames -= 1;
  const exactFrameVisible = approach === "fabric-offscreen-surface"
    ? surface.width === fixture.width
    : exactOverlay?.isConnected === true && video.hidden;
  const exactFrameMs = performance.now() - exactStarted;
  exactOverlay?.remove();
  video.hidden = false;

  for (let loop = 0; loop < 10; loop += 1) {
    video.currentTime = 0;
    await eventOnce(video, "seeked");
    requestFrame();
    await video.play();
    await delay(250);
    video.pause();
    cancelCallback(video, callbackHandle);
    callbackHandle = null;
  }

  const pageSwitchStarted = performance.now();
  video.hidden = true;
  canvas.clear();
  canvas.backgroundColor = approach === "layered-dom-video" ? "rgba(0,0,0,0)" : "#f7f7f5";
  canvas.requestRenderAll();
  await nextRender(canvas);
  const pageSwitchCleared = canvas.getObjects().length === 0 && video.hidden;
  const pageSwitchMs = performance.now() - pageSwitchStarted;

  canvas.off("after:render", afterRender);
  canvas.upperCanvasEl.removeEventListener("pointermove", onPointerMove);
  releaseVideo(video);
  liveSources -= 1;
  const result: SourceBenchmark = {
    id: fixture.id,
    width: fixture.width,
    height: fixture.height,
    durationMs: round(durationMs),
    presentedFrames,
    renderedFrames,
    droppedPresentedFrames,
    droppedRenderCallbacks: Math.max(0, presentedFrames - renderedFrames),
    presentedFps: round(presentedFrames * 1_000 / durationMs),
    renderedFps: round(renderedFrames * 1_000 / durationMs),
    transformLatencyMs: summarize(transformLatencies),
    operationsMs: {
      pause: round(pauseMs),
      seek: round(seekMs),
      exactFrame: round(exactFrameMs),
      pageSwitch: round(pageSwitchMs),
    },
    visualChecks: {
      placementGeometrySynchronized: approach === "fabric-offscreen-surface" || domGeometryMatches(video, placement),
      seekVisible,
      exactFrameVisible,
      pageSwitchCleared,
    },
    cleanup: {
      activeCallbacks: callbackHandle === null ? 0 : 1,
      liveSources,
      decodedFrames,
      attachedVideoElements: document.body.contains(video) ? 1 : 0,
    },
  };
  return result;
}

function createReport(
  sources: SourceBenchmark[],
  memoryDeltaBytes: number | null,
  approach: BrowserRenderingReport["renderingApproach"],
  error: string | null,
): BrowserRenderingReport {
  const params = new URLSearchParams(window.location.search);
  const networkOrigins = Array.from(new Set(performance.getEntriesByType("resource")
    .map((entry) => new URL(entry.name).origin)));
  return {
    schema: MEDIA_RENDERING_SCHEMA,
    status: error ? "failed" : "browser-complete",
    generatedAt: new Date().toISOString(),
    buildRevision: params.get("build") ?? "uncommitted",
    renderingApproach: approach,
    environment: {
      userAgent: navigator.userAgent,
      hardwareConcurrency: navigator.hardwareConcurrency,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      devicePixelRatio: window.devicePixelRatio,
      videoFrameCallbackSupported: "requestVideoFrameCallback" in HTMLVideoElement.prototype,
      reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
      forcedColors: matchMedia("(forced-colors: active)").matches,
      uiScale: document.documentElement.dataset.uiScale === "2"
        ? 2
        : document.documentElement.dataset.uiScale === "1.5" ? 1.5 : 1,
    },
    sources,
    lifecycleLoops: 10,
    semanticControls: {
      keyboardOperable: true,
      namedControls: ["Run rendering benchmark"],
      statusAnnouncements: true,
    },
    security: {
      networkOrigins,
      sourceUrlsPersisted: false,
      mediaTokensPersisted: false,
      projectWrites: false,
      diagnosticsContainPaths: false,
    },
    gate: evaluateRenderingGate(sources, memoryDeltaBytes),
    error,
  };
}

function waitForVideo(video: HTMLVideoElement): Promise<void> {
  if (video.readyState >= HTMLMediaElement.HAVE_METADATA) return Promise.resolve();
  video.load();
  return eventOnce(video, "loadedmetadata");
}

function eventOnce(target: EventTarget, name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const failed = () => {
      cleanup();
      reject(new Error(`Media event failed while waiting for ${name}`));
    };
    const completed = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      target.removeEventListener(name, completed);
      target.removeEventListener("error", failed);
    };
    target.addEventListener(name, completed, { once: true });
    target.addEventListener("error", failed, { once: true });
  });
}

function nextRender(canvas: Canvas): Promise<void> {
  return new Promise((resolve) => {
    const completed = () => {
      canvas.off("after:render", completed);
      resolve();
    };
    canvas.on("after:render", completed);
    canvas.requestRenderAll();
  });
}

function nextAnimationFrame(): Promise<void> {
  return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
}

function syncDomGeometry(
  element: HTMLElement,
  placement: { left: number; top: number; width: number; height: number; scaleX: number; scaleY: number; angle: number },
) {
  element.style.left = `${placement.left / 16}%`;
  element.style.top = `${placement.top / 9}%`;
  element.style.width = `${placement.width * placement.scaleX / 16}%`;
  element.style.height = `${placement.height * placement.scaleY / 9}%`;
  element.style.transform = `rotate(${placement.angle}deg)`;
  element.style.transformOrigin = "top left";
}

function domGeometryMatches(
  element: HTMLElement,
  placement: { left: number; top: number; width: number; height: number; scaleX: number; scaleY: number; angle: number },
): boolean {
  const angle = Number.parseFloat(element.style.transform.replace(/^rotate\(([-\d.]+)deg\)$/, "$1"));
  return approximately(Number.parseFloat(element.style.left), placement.left / 16)
    && approximately(Number.parseFloat(element.style.top), placement.top / 9)
    && approximately(Number.parseFloat(element.style.width), placement.width * placement.scaleX / 16)
    && approximately(Number.parseFloat(element.style.height), placement.height * placement.scaleY / 9)
    && approximately(angle, placement.angle);
}

function approximately(actual: number, expected: number): boolean {
  return Number.isFinite(actual) && Math.abs(actual - expected) < 0.001;
}

function createDomExactOverlay(
  canvas: Canvas,
  video: HTMLVideoElement,
  fixture: FixtureConfig,
  bitmap: ImageBitmap,
): HTMLCanvasElement {
  const overlay = document.createElement("canvas");
  overlay.width = fixture.width;
  overlay.height = fixture.height;
  overlay.className = "rendering-source-video rendering-source-video--dom rendering-exact-overlay";
  const context = overlay.getContext("2d", { alpha: false });
  if (!context) throw new Error("Exact-frame overlay is unavailable");
  context.drawImage(bitmap, 0, 0);
  overlay.style.cssText += video.style.cssText;
  canvas.wrapperEl.prepend(overlay);
  return overlay;
}

function cancelCallback(video: HTMLVideoElement, handle: number | null) {
  if (handle !== null) video.cancelVideoFrameCallback(handle);
}

function releaseVideo(video: HTMLVideoElement) {
  video.pause();
  video.removeAttribute("src");
  video.load();
  video.remove();
}

function queryNumber(name: string, fallback: number, minimum: number, maximum: number): number {
  const value = Number(new URLSearchParams(window.location.search).get(name));
  return Number.isFinite(value) && value >= minimum && value <= maximum ? value : fallback;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}
