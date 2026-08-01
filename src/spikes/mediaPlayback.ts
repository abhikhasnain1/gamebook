export const MEDIA_PLAYBACK_SCHEMA = "gamebook.media-playback.v1";

export type AssetKind = "video" | "decoded-frame";
export type PlaybackMode = "poster" | "playing" | "exact" | "error";
export type SuspensionReason = "pause" | "page-switch" | "export" | "minimize" | "deletion" | "disposal";

export interface DecodedFrameRef {
  assetToken: string;
  width: number;
  height: number;
  timestampUs: number;
  sampleIndex: number;
  mimeType: "image/png";
}

export interface FrameTimelineEntry {
  timestampUs: number;
  sampleIndex: number;
}

export interface PlaybackFrame {
  source: CanvasImageSource;
  timestampUs: number;
  sampleIndex: number;
}

export interface PlaybackSource {
  play(): Promise<void>;
  pause(): void;
  seek(timestampUs: number): void;
  requestFrame(callback: (frame: PlaybackFrame) => void): number;
  cancelFrame(handle: number): void;
  release(): void;
}

export interface PlaybackSourceFactory {
  open(assetToken: string): Promise<PlaybackSource>;
}

export interface ExactFrameLoader {
  load(frame: DecodedFrameRef): Promise<CanvasImageSource>;
  release(source: CanvasImageSource): void;
}

export interface PlaybackSurface {
  draw(source: CanvasImageSource, kind: "video" | "exact"): void;
  restorePoster(): void;
  requestRender(): void;
}

export interface PlaybackPlacement {
  id: string;
  pageId: string;
  evidenceId: string;
  sourceToken: string;
  surface: PlaybackSurface;
}

export interface PlaybackState {
  id: string;
  evidenceId: string;
  mode: PlaybackMode;
  timestampUs: number;
  sampleIndex: number | null;
  callbackActive: boolean;
  sourceActive: boolean;
  error: string | null;
}

interface PlacementRuntime {
  placement: PlaybackPlacement;
  state: PlaybackState;
  generation: number;
  source?: PlaybackSource;
  callbackHandle?: number;
}

export class MediaPlaybackController {
  private readonly placements = new Map<string, PlacementRuntime>();
  private disposed = false;

  constructor(
    private activePageId: string,
    private readonly sourceFactory: PlaybackSourceFactory,
    private readonly exactFrameLoader: ExactFrameLoader,
    private readonly onStateChange: (state: PlaybackState) => void = () => undefined,
  ) {}

  register(placement: PlaybackPlacement): void {
    this.assertAvailable();
    if (this.placements.has(placement.id)) throw new Error("Placement is already registered");
    const runtime: PlacementRuntime = {
      placement,
      generation: 0,
      state: {
        id: placement.id,
        evidenceId: placement.evidenceId,
        mode: "poster",
        timestampUs: 0,
        sampleIndex: null,
        callbackActive: false,
        sourceActive: false,
        error: null,
      },
    };
    this.placements.set(placement.id, runtime);
    placement.surface.restorePoster();
    placement.surface.requestRender();
    this.emit(runtime);
  }

  async play(id: string): Promise<void> {
    const runtime = this.requireOnActivePage(id);
    this.stopOthers(id, "pause");
    this.stopRuntime(runtime, "pause", false);
    const generation = runtime.generation;
    try {
      const source = await this.sourceFactory.open(runtime.placement.sourceToken);
      if (!this.isCurrent(runtime, generation)) {
        source.release();
        return;
      }
      runtime.source = source;
      runtime.state = {
        ...runtime.state,
        mode: "playing",
        sourceActive: true,
        error: null,
      };
      await source.play();
      if (!this.isCurrent(runtime, generation) || runtime.source !== source) {
        source.release();
        return;
      }
      this.scheduleFrame(runtime, source, generation);
      this.emit(runtime);
    } catch {
      if (this.isCurrent(runtime, generation)) {
        this.stopRuntime(runtime, "pause", true, "Playback source is unavailable");
      }
    }
  }

  pause(id: string): void {
    this.stopRuntime(this.requireRuntime(id), "pause", true);
  }

  seek(id: string, timestampUs: number): void {
    const runtime = this.requireRuntime(id);
    if (!Number.isInteger(timestampUs) || timestampUs < 0) {
      throw new Error("Seek time must be a non-negative integer");
    }
    runtime.source?.seek(timestampUs);
    runtime.state = { ...runtime.state, timestampUs, error: null };
    this.emit(runtime);
  }

  async showExactFrame(id: string, frame: DecodedFrameRef): Promise<void> {
    const runtime = this.requireOnActivePage(id);
    validateDecodedFrame(frame);
    this.stopOthers(id, "pause");
    this.stopRuntime(runtime, "pause", false);
    const generation = runtime.generation;
    let source: CanvasImageSource | undefined;
    try {
      source = await this.exactFrameLoader.load(frame);
      if (!this.isCurrent(runtime, generation)) {
        return;
      }
      runtime.placement.surface.draw(source, "exact");
      runtime.placement.surface.requestRender();
      runtime.state = {
        ...runtime.state,
        mode: "exact",
        timestampUs: frame.timestampUs,
        sampleIndex: frame.sampleIndex,
        callbackActive: false,
        sourceActive: false,
        error: null,
      };
      this.emit(runtime);
    } catch {
      if (this.isCurrent(runtime, generation)) {
        this.stopRuntime(runtime, "pause", true, "Exact frame is unavailable");
      }
    } finally {
      if (source) this.exactFrameLoader.release(source);
    }
  }

  showPoster(id: string): void {
    this.stopRuntime(this.requireRuntime(id), "pause", true);
  }

  switchPage(pageId: string): void {
    this.suspendAll("page-switch");
    this.activePageId = pageId;
  }

  suspendAll(reason: Exclude<SuspensionReason, "deletion" | "disposal">): void {
    for (const runtime of this.placements.values()) {
      this.stopRuntime(runtime, reason, true);
    }
  }

  deletePlacement(id: string): void {
    const runtime = this.requireRuntime(id);
    this.stopRuntime(runtime, "deletion", true);
    this.placements.delete(id);
  }

  dispose(): void {
    if (this.disposed) return;
    for (const runtime of this.placements.values()) {
      this.stopRuntime(runtime, "disposal", true);
    }
    this.placements.clear();
    this.disposed = true;
  }

  getState(id: string): PlaybackState {
    return { ...this.requireRuntime(id).state };
  }

  get activeCallbackCount(): number {
    return Array.from(this.placements.values()).filter(
      (runtime) => runtime.callbackHandle !== undefined,
    ).length;
  }

  get liveSourceCount(): number {
    return Array.from(this.placements.values()).filter((runtime) => runtime.source).length;
  }

  private scheduleFrame(runtime: PlacementRuntime, source: PlaybackSource, generation: number): void {
    const handle = source.requestFrame((frame) => {
      if (runtime.callbackHandle === handle) runtime.callbackHandle = undefined;
      if (!this.isCurrent(runtime, generation) || runtime.source !== source || runtime.state.mode !== "playing") {
        return;
      }
      runtime.placement.surface.draw(frame.source, "video");
      runtime.placement.surface.requestRender();
      runtime.state = {
        ...runtime.state,
        timestampUs: frame.timestampUs,
        sampleIndex: frame.sampleIndex,
        callbackActive: false,
      };
      this.emit(runtime);
      this.scheduleFrame(runtime, source, generation);
    });
    runtime.callbackHandle = handle;
    runtime.state = { ...runtime.state, callbackActive: true };
  }

  private stopOthers(id: string, reason: SuspensionReason): void {
    for (const [candidateId, runtime] of this.placements) {
      if (candidateId !== id && (runtime.source || runtime.state.mode !== "poster")) {
        this.stopRuntime(runtime, reason, true);
      }
    }
  }

  private stopRuntime(
    runtime: PlacementRuntime,
    _reason: SuspensionReason,
    restorePoster: boolean,
    error: string | null = null,
  ): void {
    runtime.generation += 1;
    if (runtime.callbackHandle !== undefined && runtime.source) {
      runtime.source.cancelFrame(runtime.callbackHandle);
    }
    runtime.callbackHandle = undefined;
    if (runtime.source) {
      runtime.source.pause();
      runtime.source.release();
      runtime.source = undefined;
    }
    if (restorePoster) {
      runtime.placement.surface.restorePoster();
      runtime.placement.surface.requestRender();
    }
    runtime.state = {
      ...runtime.state,
      mode: error ? "error" : "poster",
      callbackActive: false,
      sourceActive: false,
      error,
    };
    this.emit(runtime);
  }

  private requireRuntime(id: string): PlacementRuntime {
    this.assertAvailable();
    const runtime = this.placements.get(id);
    if (!runtime) throw new Error("Unknown media placement");
    return runtime;
  }

  private requireOnActivePage(id: string): PlacementRuntime {
    const runtime = this.requireRuntime(id);
    if (runtime.placement.pageId !== this.activePageId) {
      throw new Error("Placement is not on the active page");
    }
    return runtime;
  }

  private isCurrent(runtime: PlacementRuntime, generation: number): boolean {
    return !this.disposed && runtime.generation === generation && this.placements.has(runtime.placement.id);
  }

  private emit(runtime: PlacementRuntime): void {
    this.onStateChange({ ...runtime.state });
  }

  private assertAvailable(): void {
    if (this.disposed) throw new Error("Playback controller is disposed");
  }
}

interface AssetEntry {
  kind: AssetKind;
  url: string;
  ttlMs: number;
  expiresAtMs: number;
}

export class ScopedAssetRegistry {
  private readonly assets = new Map<string, AssetEntry>();

  constructor(private readonly now: () => number = Date.now) {}

  issue(kind: AssetKind, url: string, ttlMs = 10 * 60 * 1000): string {
    if (ttlMs <= 0) throw new Error("Asset token lifetime must be positive");
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const token = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
    this.assets.set(token, { kind, url, ttlMs, expiresAtMs: this.now() + ttlMs });
    return token;
  }

  resolve(token: string, expectedKind: AssetKind): string {
    const asset = this.assets.get(token);
    if (!asset || asset.kind !== expectedKind || asset.expiresAtMs <= this.now()) {
      this.assets.delete(token);
      throw new Error("Asset reference is unavailable");
    }
    asset.expiresAtMs = this.now() + asset.ttlMs;
    return asset.url;
  }

  expire(token: string): void {
    this.assets.delete(token);
  }
}

export class HtmlVideoSourceFactory implements PlaybackSourceFactory {
  constructor(
    private readonly assets: ScopedAssetRegistry,
    private readonly timeline: FrameTimelineEntry[],
  ) {}

  async open(assetToken: string): Promise<PlaybackSource> {
    if (!("requestVideoFrameCallback" in HTMLVideoElement.prototype)) {
      throw new Error("Video frame callbacks are unavailable");
    }
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.loop = true;
    video.src = this.assets.resolve(assetToken, "video");
    try {
      await waitForMedia(video);
      return new HtmlVideoSource(video, this.timeline);
    } catch (error) {
      video.removeAttribute("src");
      video.load();
      throw error;
    }
  }
}

class HtmlVideoSource implements PlaybackSource {
  private released = false;

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly timeline: FrameTimelineEntry[],
  ) {}

  play(): Promise<void> {
    this.assertAvailable();
    return this.video.play();
  }

  pause(): void {
    if (!this.released) this.video.pause();
  }

  seek(timestampUs: number): void {
    this.assertAvailable();
    this.video.currentTime = timestampUs / 1_000_000;
  }

  requestFrame(callback: (frame: PlaybackFrame) => void): number {
    this.assertAvailable();
    return this.video.requestVideoFrameCallback((_now, metadata) => {
      const timestampUs = Math.round(metadata.mediaTime * 1_000_000);
      callback({
        source: this.video,
        timestampUs,
        sampleIndex: sampleAtOrBefore(this.timeline, timestampUs),
      });
    });
  }

  cancelFrame(handle: number): void {
    if (!this.released) this.video.cancelVideoFrameCallback(handle);
  }

  release(): void {
    if (this.released) return;
    this.video.pause();
    this.video.removeAttribute("src");
    this.video.load();
    this.released = true;
  }

  private assertAvailable(): void {
    if (this.released) throw new Error("Video source is released");
  }
}

export class BrowserExactFrameLoader implements ExactFrameLoader {
  constructor(private readonly assets: ScopedAssetRegistry) {}

  async load(frame: DecodedFrameRef): Promise<HTMLImageElement> {
    validateDecodedFrame(frame);
    const image = new Image();
    image.decoding = "async";
    image.src = this.assets.resolve(frame.assetToken, "decoded-frame");
    await image.decode();
    if (image.naturalWidth !== frame.width || image.naturalHeight !== frame.height) {
      image.removeAttribute("src");
      throw new Error("Decoded frame dimensions do not match the reference");
    }
    return image;
  }

  release(source: CanvasImageSource): void {
    if (source instanceof HTMLImageElement) source.removeAttribute("src");
  }
}

export interface TimedAnnotationScope {
  evidenceId: string;
  startUs: number;
  endUs: number;
}

export function isTimedAnnotationVisible(
  scope: TimedAnnotationScope,
  evidenceId: string,
  timestampUs: number,
): boolean {
  return scope.evidenceId === evidenceId && timestampUs >= scope.startUs && timestampUs <= scope.endUs;
}

export function shouldAutoplay(enabled: boolean, reducedMotion: boolean): boolean {
  return enabled && !reducedMotion;
}

function validateDecodedFrame(frame: DecodedFrameRef): void {
  if (frame.mimeType !== "image/png") throw new Error("Exact frames must be PNG images");
  if (!Number.isInteger(frame.width) || frame.width <= 0) throw new Error("Frame width is invalid");
  if (!Number.isInteger(frame.height) || frame.height <= 0) throw new Error("Frame height is invalid");
  if (!Number.isInteger(frame.timestampUs) || frame.timestampUs < 0) throw new Error("Frame time is invalid");
  if (!Number.isInteger(frame.sampleIndex) || frame.sampleIndex < 0) throw new Error("Frame index is invalid");
  if (!/^[a-f0-9]{64}$/i.test(frame.assetToken)) throw new Error("Frame token is invalid");
}

function sampleAtOrBefore(timeline: FrameTimelineEntry[], timestampUs: number): number {
  let sampleIndex = timeline[0]?.sampleIndex ?? 0;
  for (const entry of timeline) {
    if (entry.timestampUs > timestampUs) break;
    sampleIndex = entry.sampleIndex;
  }
  return sampleIndex;
}

function waitForMedia(video: HTMLVideoElement): Promise<void> {
  if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      video.removeEventListener("loadeddata", loaded);
      video.removeEventListener("error", failed);
    };
    const loaded = () => {
      cleanup();
      resolve();
    };
    const failed = () => {
      cleanup();
      reject(new Error("Video fixture could not be decoded"));
    };
    video.addEventListener("loadeddata", loaded, { once: true });
    video.addEventListener("error", failed, { once: true });
    video.load();
  });
}
