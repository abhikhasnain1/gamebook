import { Canvas, Rect, StaticCanvas } from "fabric";
import { Download, Minimize2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MediaPlacement, createPosterSurface } from "./MediaPlacement";
import { MediaPlaybackControls } from "./MediaPlaybackControls";
import exactFrame0Url from "./fixtures/native-decode-cfr60-sample-0.png?url";
import exactFrame30Url from "./fixtures/native-decode-cfr60-sample-30.png?url";
import exactFrame59Url from "./fixtures/native-decode-cfr60-sample-59.png?url";
import videoUrl from "./fixtures/native-decode-cfr60.mp4?url";
import {
  BrowserExactFrameLoader,
  HtmlVideoSourceFactory,
  MEDIA_PLAYBACK_SCHEMA,
  MediaPlaybackController,
  ScopedAssetRegistry,
  isTimedAnnotationVisible,
  type DecodedFrameRef,
  type PlaybackState,
  type PlaybackSurface,
  type SuspensionReason,
  type TimedAnnotationScope,
} from "./mediaPlayback";
import type { MediaPlacementRecord } from "./mediaPlacementGeometry";

declare global {
  interface Window {
    __GAMEBOOK_MEDIA_PLAYBACK_SPIKE__?: MediaPlaybackReport;
  }
}

interface HarnessCheck {
  id: string;
  passed: boolean;
  detail: string;
}

interface CleanupResult {
  reason: SuspensionReason;
  activeCallbacks: number;
  liveSources: number;
}

interface MediaPlaybackReport {
  schema: typeof MEDIA_PLAYBACK_SCHEMA;
  status: "passed" | "failed";
  generatedAt: string;
  buildRevision: string;
  fixture: {
    id: string;
    videoSha256: string;
    exactFrameSha256: string;
  };
  environment: {
    userAgent: string;
    hardwareConcurrency: number;
    viewport: { width: number; height: number };
    videoFrameCallbackSupported: boolean;
  };
  checks: HarnessCheck[];
  renderedVideoFrames: number;
  exactFrame: { timestampUs: number; sampleIndex: number };
  cleanup: CleanupResult[];
  geometryFingerprint: string;
  sourceUrlsExposed: false;
  persistedRuntimeKeys: string[];
}

interface InteractiveRuntime {
  controller: MediaPlaybackController;
  exactFrames: DecodedFrameRef[];
  canvas: Canvas;
}

const VIDEO_SHA256 = "b1b33aa040553a781420fcc2d56a0e5f2089c430f85b20deac657d1c9d935795";
const EXACT_FRAME_30_SHA256 = "639aba824b4406b29ccfdd5d72f5aa14ab9e11776dccef3a40cc3fc33249ccfd";
const DURATION_US = 983_333;
const TIMELINE = Array.from({ length: 60 }, (_, sampleIndex) => ({
  sampleIndex,
  timestampUs: Math.floor(sampleIndex * 1_000_000 / 60),
}));
const TIMED_SCOPE: TimedAnnotationScope = {
  evidenceId: "evidence-alpha",
  startUs: 400_000,
  endUs: 600_000,
};
const RECORDS: MediaPlacementRecord[] = [
  {
    id: "placement-alpha",
    evidenceId: "evidence-alpha",
    left: 120,
    top: 150,
    scaleX: 0.82,
    scaleY: 0.82,
    angle: 0,
    posterTimestampUs: 500_000,
    zIndex: 1,
  },
  {
    id: "placement-beta",
    evidenceId: "evidence-beta",
    left: 770,
    top: 250,
    scaleX: 0.72,
    scaleY: 0.72,
    angle: 5,
    posterTimestampUs: 0,
    zIndex: 2,
  },
];

export function MediaPlaybackHarness() {
  const canvasElementRef = useRef<HTMLCanvasElement>(null);
  const runtimeRef = useRef<InteractiveRuntime | null>(null);
  const [selectedId, setSelectedId] = useState(RECORDS[0].id);
  const [activePage, setActivePage] = useState("page-alpha");
  const [states, setStates] = useState<Record<string, PlaybackState>>(() => initialStates());
  const [status, setStatus] = useState("Posters ready");
  const [report, setReport] = useState<MediaPlaybackReport | null>(null);

  const updateState = useCallback((state: PlaybackState) => {
    setStates((current) => ({ ...current, [state.id]: state }));
  }, []);

  useEffect(() => {
    const element = canvasElementRef.current;
    if (!element) return;
    const canvas = new Canvas(element, {
      width: 1600,
      height: 900,
      renderOnAddRemove: false,
      preserveObjectStacking: true,
      backgroundColor: "#f7f7f5",
    });
    const registry = new ScopedAssetRegistry();
    const assets = issueHarnessAssets(registry);
    const surfaces = RECORDS.map((record) => new FabricPlaybackSurface(record, canvas));
    surfaces.forEach((surface) => canvas.add(surface.placement));
    const timedAnnotation = createTimedAnnotation();
    canvas.add(timedAnnotation);
    canvas.requestRenderAll();

    const controller = new MediaPlaybackController(
      "page-alpha",
      new HtmlVideoSourceFactory(registry, TIMELINE),
      new BrowserExactFrameLoader(registry),
      (state) => {
        timedAnnotation.visible = isTimedAnnotationVisible(
          TIMED_SCOPE,
          state.evidenceId,
          state.timestampUs,
        ) && state.mode !== "poster" && state.mode !== "error";
        canvas.requestRenderAll();
        updateState(state);
      },
    );
    RECORDS.forEach((record, index) => {
      controller.register({
        id: record.id,
        pageId: "page-alpha",
        evidenceId: record.evidenceId,
        sourceToken: assets.videoTokens[index],
        surface: surfaces[index],
      });
    });
    runtimeRef.current = { controller, exactFrames: assets.exactFrames, canvas };

    return () => {
      controller.dispose();
      canvas.dispose();
      runtimeRef.current = null;
    };
  }, [updateState]);

  useEffect(() => {
    if (report) return;
    let cancelled = false;
    const timeout = window.setTimeout(() => {
      void runBrowserScenario().then((result) => {
        if (cancelled) return;
        window.__GAMEBOOK_MEDIA_PLAYBACK_SPIKE__ = result;
        setReport(result);
        setStatus(result.status === "passed" ? "Playback checks passed" : "Playback check failed");
      });
    }, 100);
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [report]);

  const controlPlacements = useMemo(
    () => RECORDS.map((record) => ({
      id: record.id,
      sourceName: record.id === "placement-alpha" ? "Synthetic CFR 60 alpha" : "Synthetic CFR 60 beta",
      state: states[record.id],
    })),
    [states],
  );

  function runAction(label: string, action: (runtime: InteractiveRuntime) => void | Promise<void>) {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    setStatus(label);
    void Promise.resolve(action(runtime)).catch(() => setStatus("Playback action failed"));
  }

  function switchPage(pageId: string) {
    runAction(`${pageId} selected`, ({ controller }) => controller.switchPage(pageId));
    setActivePage(pageId);
  }

  return (
    <main className="playback-shell">
      <header className="playback-header">
        <div>
          <p>Milestone 3 / Playback</p>
          <h1>Offscreen media harness</h1>
        </div>
        <nav aria-label="Harness pages">
          {[
            ["page-alpha", "Media page"],
            ["page-empty", "Empty page"],
          ].map(([pageId, label]) => (
            <button
              key={pageId}
              type="button"
              aria-current={activePage === pageId ? "page" : undefined}
              onClick={() => switchPage(pageId)}
            >
              {label}
            </button>
          ))}
        </nav>
        <div className="playback-header-actions">
          <button
            type="button"
            title="Suspend for export"
            aria-label="Suspend playback for export"
            onClick={() => runAction("Playback suspended for export", ({ controller }) => controller.suspendAll("export"))}
          >
            <Download aria-hidden="true" />
          </button>
          <button
            type="button"
            title="Suspend for minimize"
            aria-label="Suspend playback for minimize"
            onClick={() => runAction("Playback suspended for minimize", ({ controller }) => controller.suspendAll("minimize"))}
          >
            <Minimize2 aria-hidden="true" />
          </button>
        </div>
      </header>

      <section className="playback-workspace" aria-label="Offscreen media playback workspace">
        <div className="playback-canvas-wrap" hidden={activePage !== "page-alpha"}>
          <canvas ref={canvasElementRef} aria-label="Media page visual canvas" />
        </div>
        {activePage === "page-empty" ? (
          <div className="playback-empty" role="status">No media on this page</div>
        ) : null}
        <MediaPlaybackControls
          placements={controlPlacements}
          selectedId={selectedId}
          durationUs={DURATION_US}
          exactFrames={runtimeRef.current?.exactFrames ?? []}
          status={status}
          onSelect={setSelectedId}
          onPlay={(id) => runAction(`${id} playing`, ({ controller }) => controller.play(id))}
          onPause={(id) => runAction(`${id} paused; poster restored`, ({ controller }) => controller.pause(id))}
          onSeek={(id, timestampUs) => runAction(`${id} source time changed`, ({ controller }) => controller.seek(id, timestampUs))}
          onExactFrame={(id, frame) => runAction(`Exact sample ${frame.sampleIndex} selected`, ({ controller }) => controller.showExactFrame(id, frame))}
          onPoster={(id) => runAction(`${id} poster restored`, ({ controller }) => controller.showPoster(id))}
        />
      </section>

      <footer className="playback-footer">
        <span>Timed finding {isTimedAnnotationVisible(TIMED_SCOPE, states[selectedId].evidenceId, states[selectedId].timestampUs) && states[selectedId].mode !== "poster" ? "visible" : "hidden"}</span>
        <output aria-label="Automated check result" data-status={report?.status ?? "pending"}>
          {report ? `${report.checks.filter((check) => check.passed).length}/${report.checks.length} checks` : "Running checks"}
        </output>
      </footer>
      {report ? <pre id="spike-report-json" hidden>{JSON.stringify(report)}</pre> : null}
    </main>
  );
}

class FabricPlaybackSurface implements PlaybackSurface {
  readonly placement: MediaPlacement;
  currentKind: "poster" | "video" | "exact" = "poster";
  videoFrameCount = 0;
  private readonly poster: HTMLCanvasElement;
  private readonly surface: HTMLCanvasElement;

  constructor(record: MediaPlacementRecord, private readonly canvas: Canvas | StaticCanvas) {
    this.poster = createPosterSurface(record.evidenceId);
    this.surface = document.createElement("canvas");
    this.surface.width = this.poster.width;
    this.surface.height = this.poster.height;
    this.placement = new MediaPlacement(record, this.surface);
    this.restorePoster();
  }

  draw(source: CanvasImageSource, kind: "video" | "exact"): void {
    const context = this.context();
    context.clearRect(0, 0, this.surface.width, this.surface.height);
    context.drawImage(source, 0, 0, this.surface.width, this.surface.height);
    this.currentKind = kind;
    if (kind === "video") this.videoFrameCount += 1;
    this.placement.dirty = true;
  }

  restorePoster(): void {
    const context = this.context();
    context.clearRect(0, 0, this.surface.width, this.surface.height);
    context.drawImage(this.poster, 0, 0);
    this.currentKind = "poster";
    this.placement.dirty = true;
  }

  requestRender(): void {
    this.canvas.requestRenderAll();
  }

  private context(): CanvasRenderingContext2D {
    const context = this.surface.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("Playback surface is unavailable");
    return context;
  }
}

async function runBrowserScenario(): Promise<MediaPlaybackReport> {
  const canvas = new StaticCanvas(document.createElement("canvas"), {
    width: 1600,
    height: 900,
    renderOnAddRemove: false,
    backgroundColor: "#f7f7f5",
  });
  const registry = new ScopedAssetRegistry();
  const assets = issueHarnessAssets(registry);
  const surfaces = RECORDS.map((record) => new FabricPlaybackSurface(record, canvas));
  surfaces.forEach((surface) => canvas.add(surface.placement));
  const timedAnnotation = createTimedAnnotation();
  canvas.add(timedAnnotation);
  const checks: HarnessCheck[] = [];
  const cleanup: CleanupResult[] = [];
  const geometryFingerprint = JSON.stringify(
    surfaces.map((surface) => surface.placement.toPlacementRecord()),
  );
  let latestState = initialStates();
  const controller = new MediaPlaybackController(
    "page-alpha",
    new HtmlVideoSourceFactory(registry, TIMELINE),
    new BrowserExactFrameLoader(registry),
    (state) => {
      latestState = { ...latestState, [state.id]: state };
      timedAnnotation.visible = isTimedAnnotationVisible(
        TIMED_SCOPE,
        state.evidenceId,
        state.timestampUs,
      ) && state.mode !== "poster" && state.mode !== "error";
    },
  );
  RECORDS.forEach((record, index) => controller.register({
    id: record.id,
    pageId: "page-alpha",
    evidenceId: record.evidenceId,
    sourceToken: assets.videoTokens[index],
    surface: surfaces[index],
  }));
  const check = (id: string, passed: boolean, detail: string) => checks.push({ id, passed, detail });

  try {
    await controller.play("placement-alpha");
    await waitUntil(() => surfaces[0].videoFrameCount > 0, "video frame callback");
    check(
      "video-frame-callback",
      surfaces[0].videoFrameCount > 0 && latestState["placement-alpha"].sampleIndex !== null,
      `Rendered ${surfaces[0].videoFrameCount} browser video frame callback before the first transition.`,
    );

    const framesBeforeSeek = surfaces[0].videoFrameCount;
    controller.seek("placement-alpha", 500_000);
    await waitUntil(() => surfaces[0].videoFrameCount > framesBeforeSeek, "seeked video frame");
    check(
      "seek",
      surfaces[0].videoFrameCount > framesBeforeSeek,
      "A source-time seek produced a subsequent compositor frame without changing placement geometry.",
    );

    await controller.play("placement-beta");
    await waitUntil(() => surfaces[1].videoFrameCount > 0, "second placement frame");
    check(
      "one-active-placement",
      latestState["placement-alpha"].mode === "poster" &&
        latestState["placement-beta"].mode === "playing" &&
        surfaces[0].currentKind === "poster" &&
        controller.liveSourceCount === 1,
      "Starting beta released alpha and restored alpha's poster before beta rendered.",
    );

    await controller.showExactFrame("placement-alpha", assets.exactFrames[1]);
    const exactState = latestState["placement-alpha"];
    check(
      "exact-frame-substitution",
      surfaces[0].currentKind === "exact" &&
        exactState.sampleIndex === 30 &&
        exactState.timestampUs === 500_000 &&
        controller.activeCallbackCount === 0 &&
        controller.liveSourceCount === 0,
      "Native-decoded PNG sample 30 replaced playback on the same offscreen surface at 500000 microseconds.",
    );
    check(
      "timed-annotation-layering",
      timedAnnotation.visible && canvas.getObjects().indexOf(timedAnnotation) > canvas.getObjects().indexOf(surfaces[0].placement),
      "The source-time finding became visible above its target placement only inside its inclusive time range.",
    );
    check(
      "shared-geometry",
      JSON.stringify(surfaces.map((surface) => surface.placement.toPlacementRecord())) === geometryFingerprint,
      "Playback, seek, and exact substitution retained the original stable placement records.",
    );

    controller.showPoster("placement-alpha");
    check(
      "poster-restoration",
      surfaces[0].currentKind === "poster" && latestState["placement-alpha"].mode === "poster" && !timedAnnotation.visible,
      "Leaving exact mode restored the deterministic poster and hid the out-of-mode timed finding.",
    );

    const expired = registry.issue("decoded-frame", exactFrame30Url, 60_000);
    registry.expire(expired);
    await controller.showExactFrame("placement-alpha", { ...assets.exactFrames[1], assetToken: expired });
    check(
      "failure-preserves-poster",
      latestState["placement-alpha"].mode === "error" &&
        latestState["placement-alpha"].error === "Exact frame is unavailable" &&
        surfaces[0].currentKind === "poster" &&
        controller.activeCallbackCount === 0 &&
        controller.liveSourceCount === 0,
      "An expired exact-frame token failed generically, restored the poster, and retained no callback or source.",
    );

    await playAndWait(controller, surfaces[0], "placement-alpha");
    controller.pause("placement-alpha");
    cleanup.push(cleanupResult("pause", controller));
    await playAndWait(controller, surfaces[0], "placement-alpha");
    controller.switchPage("page-empty");
    cleanup.push(cleanupResult("page-switch", controller));
    controller.switchPage("page-alpha");
    await playAndWait(controller, surfaces[0], "placement-alpha");
    controller.suspendAll("export");
    cleanup.push(cleanupResult("export", controller));
    await playAndWait(controller, surfaces[0], "placement-alpha");
    controller.suspendAll("minimize");
    cleanup.push(cleanupResult("minimize", controller));
    await playAndWait(controller, surfaces[1], "placement-beta");
    controller.deletePlacement("placement-beta");
    cleanup.push(cleanupResult("deletion", controller));
    await playAndWait(controller, surfaces[0], "placement-alpha");
    controller.dispose();
    cleanup.push({ reason: "disposal", activeCallbacks: controller.activeCallbackCount, liveSources: controller.liveSourceCount });
    check(
      "lifecycle-cleanup",
      cleanup.every((entry) => entry.activeCallbacks === 0 && entry.liveSources === 0),
      cleanup.map((entry) => `${entry.reason}=0 callbacks/0 sources`).join("; "),
    );

    const serialized = surfaces.map((surface) => surface.placement.toObject()) as Array<Record<string, unknown>>;
    const persistedRuntimeKeys = Array.from(new Set(serialized.flatMap((record) => Object.keys(record)))).sort();
    const serializedText = JSON.stringify(serialized);
    check(
      "opaque-token-boundary",
      !/(assetToken|sourceToken|src|path|objectUrl|blob:|data:)/i.test(serializedText),
      "Stable placement serialization excluded media tokens, source URLs, paths, elements, and frame bytes.",
    );
    const requiredControls = [
      "Media playback controls",
      "Play Synthetic CFR 60 alpha",
      "Previous exact frame for Synthetic CFR 60 alpha",
      "Next exact frame for Synthetic CFR 60 alpha",
    ];
    const seekControl = document.querySelector<HTMLInputElement>('input[type="range"]');
    check(
      "semantic-controls",
      requiredControls.every((name) => document.querySelector(`[aria-label="${name}"]`)) &&
        seekControl?.labels?.[0]?.textContent?.trim() === "Source time",
      "Labeled placement, playback, seek, frame, poster, state, status, and error controls are present outside the canvas.",
    );

    const report: MediaPlaybackReport = {
      schema: MEDIA_PLAYBACK_SCHEMA,
      status: checks.every((candidate) => candidate.passed) ? "passed" : "failed",
      generatedAt: new Date().toISOString(),
      buildRevision: new URLSearchParams(window.location.search).get("build") ?? "working-tree",
      fixture: {
        id: "native-decode-cfr60-issue-8",
        videoSha256: VIDEO_SHA256,
        exactFrameSha256: EXACT_FRAME_30_SHA256,
      },
      environment: {
        userAgent: navigator.userAgent,
        hardwareConcurrency: navigator.hardwareConcurrency,
        viewport: {
          width: document.documentElement.clientWidth,
          height: document.documentElement.clientHeight,
        },
        videoFrameCallbackSupported: "requestVideoFrameCallback" in HTMLVideoElement.prototype,
      },
      checks,
      renderedVideoFrames: surfaces.reduce((total, surface) => total + surface.videoFrameCount, 0),
      exactFrame: { timestampUs: 500_000, sampleIndex: 30 },
      cleanup,
      geometryFingerprint,
      sourceUrlsExposed: false,
      persistedRuntimeKeys,
    };
    return report;
  } catch (error) {
    controller.dispose();
    check("scenario-error", false, error instanceof Error ? error.message : "Browser scenario failed");
    return {
      schema: MEDIA_PLAYBACK_SCHEMA,
      status: "failed",
      generatedAt: new Date().toISOString(),
      buildRevision: new URLSearchParams(window.location.search).get("build") ?? "working-tree",
      fixture: { id: "native-decode-cfr60-issue-8", videoSha256: VIDEO_SHA256, exactFrameSha256: EXACT_FRAME_30_SHA256 },
      environment: {
        userAgent: navigator.userAgent,
        hardwareConcurrency: navigator.hardwareConcurrency,
        viewport: { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight },
        videoFrameCallbackSupported: "requestVideoFrameCallback" in HTMLVideoElement.prototype,
      },
      checks,
      renderedVideoFrames: surfaces.reduce((total, surface) => total + surface.videoFrameCount, 0),
      exactFrame: { timestampUs: 500_000, sampleIndex: 30 },
      cleanup,
      geometryFingerprint,
      sourceUrlsExposed: false,
      persistedRuntimeKeys: [],
    };
  } finally {
    canvas.dispose();
  }
}

function issueHarnessAssets(registry: ScopedAssetRegistry) {
  const exactUrls = [exactFrame0Url, exactFrame30Url, exactFrame59Url];
  const sampleIndices = [0, 30, 59];
  const timestampsUs = [0, 500_000, 983_333];
  return {
    videoTokens: [
      registry.issue("video", videoUrl),
      registry.issue("video", videoUrl),
    ],
    exactFrames: exactUrls.map((url, index): DecodedFrameRef => ({
      assetToken: registry.issue("decoded-frame", url),
      width: 160,
      height: 90,
      timestampUs: timestampsUs[index],
      sampleIndex: sampleIndices[index],
      mimeType: "image/png",
    })),
  };
}

function createTimedAnnotation(): Rect {
  const annotation = new Rect({
    left: 490,
    top: 105,
    width: 250,
    height: 110,
    fill: "rgba(255, 255, 255, 0.92)",
    stroke: "#b42318",
    strokeWidth: 7,
    strokeUniform: true,
    visible: false,
    selectable: false,
  });
  annotation.set("data", { id: "timed-finding", role: "annotation", scope: TIMED_SCOPE });
  return annotation;
}

function initialStates(): Record<string, PlaybackState> {
  return Object.fromEntries(RECORDS.map((record) => [record.id, {
    id: record.id,
    evidenceId: record.evidenceId,
    mode: "poster" as const,
    timestampUs: 0,
    sampleIndex: null,
    callbackActive: false,
    sourceActive: false,
    error: null,
  }]));
}

async function playAndWait(
  controller: MediaPlaybackController,
  surface: FabricPlaybackSurface,
  id: string,
): Promise<void> {
  const count = surface.videoFrameCount;
  await controller.play(id);
  await waitUntil(() => surface.videoFrameCount > count, `${id} playback frame`);
}

function cleanupResult(reason: SuspensionReason, controller: MediaPlaybackController): CleanupResult {
  return {
    reason,
    activeCallbacks: controller.activeCallbackCount,
    liveSources: controller.liveSourceCount,
  };
}

async function waitUntil(predicate: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const started = performance.now();
  while (!predicate()) {
    if (performance.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => window.setTimeout(resolve, 16));
  }
}
