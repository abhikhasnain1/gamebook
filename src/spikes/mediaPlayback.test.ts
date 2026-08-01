import { describe, expect, it, vi } from "vitest";
import {
  MediaPlaybackController,
  ScopedAssetRegistry,
  isTimedAnnotationVisible,
  shouldAutoplay,
  type DecodedFrameRef,
  type ExactFrameLoader,
  type PlaybackFrame,
  type PlaybackSource,
  type PlaybackSourceFactory,
  type PlaybackSurface,
} from "./mediaPlayback";

const TOKEN = "a".repeat(64);

describe("MediaPlaybackController", () => {
  it("keeps one source active and restores the previous placement poster", async () => {
    const factory = new FakeSourceFactory();
    const exact = new FakeExactFrameLoader();
    const alphaSurface = new FakeSurface();
    const betaSurface = new FakeSurface();
    const controller = new MediaPlaybackController("page-alpha", factory, exact);
    controller.register(placement("alpha", alphaSurface));
    controller.register(placement("beta", betaSurface));

    await controller.play("alpha");
    expect(controller.activeCallbackCount).toBe(1);
    expect(controller.liveSourceCount).toBe(1);
    factory.sources[0].present(500_000, 30);
    expect(alphaSurface.kind).toBe("video");
    expect(controller.getState("alpha")).toMatchObject({
      mode: "playing",
      timestampUs: 500_000,
      sampleIndex: 30,
    });

    await controller.play("beta");
    expect(factory.sources[0].released).toBe(true);
    expect(alphaSurface.kind).toBe("poster");
    expect(controller.getState("alpha").mode).toBe("poster");
    expect(controller.getState("beta").mode).toBe("playing");
    expect(controller.activeCallbackCount).toBe(1);
    expect(controller.liveSourceCount).toBe(1);
  });

  it("draws an exact PNG into the same surface and releases playback", async () => {
    const factory = new FakeSourceFactory();
    const exact = new FakeExactFrameLoader();
    const surface = new FakeSurface();
    const controller = new MediaPlaybackController("page-alpha", factory, exact);
    controller.register(placement("alpha", surface));
    await controller.play("alpha");

    await controller.showExactFrame("alpha", frameRef(30, 500_000));

    expect(factory.sources[0].released).toBe(true);
    expect(surface.kind).toBe("exact");
    expect(exact.released).toBe(1);
    expect(controller.getState("alpha")).toMatchObject({
      mode: "exact",
      timestampUs: 500_000,
      sampleIndex: 30,
      callbackActive: false,
      sourceActive: false,
    });
    expect(controller.activeCallbackCount).toBe(0);
    expect(controller.liveSourceCount).toBe(0);
  });

  it("cleans callbacks and sources for every lifecycle boundary", async () => {
    const factory = new FakeSourceFactory();
    const controller = new MediaPlaybackController(
      "page-alpha",
      factory,
      new FakeExactFrameLoader(),
    );
    controller.register(placement("alpha", new FakeSurface()));
    controller.register({ ...placement("secondary", new FakeSurface()), pageId: "page-beta" });

    await controller.play("alpha");
    controller.pause("alpha");
    expectClean(controller);

    await controller.play("alpha");
    controller.switchPage("page-beta");
    expectClean(controller);

    await controller.play("secondary");
    controller.suspendAll("export");
    expectClean(controller);

    await controller.play("secondary");
    controller.suspendAll("minimize");
    expectClean(controller);

    await controller.play("secondary");
    controller.deletePlacement("secondary");
    expectClean(controller);

    controller.switchPage("page-alpha");
    await controller.play("alpha");
    controller.dispose();
    expect(controller.activeCallbackCount).toBe(0);
    expect(controller.liveSourceCount).toBe(0);
    expect(() => controller.getState("alpha")).toThrow(/disposed/i);
    expect(factory.sources.every((source) => source.released)).toBe(true);
  });

  it("restores a usable poster and a generic error when exact loading fails", async () => {
    const surface = new FakeSurface();
    const exact = new FakeExactFrameLoader();
    exact.fail = true;
    const controller = new MediaPlaybackController(
      "page-alpha",
      new FakeSourceFactory(),
      exact,
    );
    controller.register(placement("alpha", surface));

    await controller.showExactFrame("alpha", frameRef(30, 500_000));

    expect(surface.kind).toBe("poster");
    expect(controller.getState("alpha")).toMatchObject({
      mode: "error",
      error: "Exact frame is unavailable",
      callbackActive: false,
      sourceActive: false,
    });
  });

  it("rejects playback for a placement outside the active page", async () => {
    const controller = new MediaPlaybackController(
      "page-alpha",
      new FakeSourceFactory(),
      new FakeExactFrameLoader(),
    );
    controller.register({ ...placement("beta", new FakeSurface()), pageId: "page-beta" });

    await expect(controller.play("beta")).rejects.toThrow(/active page/i);
  });
});

describe("media playback boundaries", () => {
  it("expires scoped tokens and does not reveal why resolution failed", () => {
    let now = 1_000;
    const registry = new ScopedAssetRegistry(() => now);
    const videoToken = registry.issue("video", "/synthetic/video.mp4", 100);
    expect(videoToken).toMatch(/^[a-f0-9]{64}$/);
    expect(registry.resolve(videoToken, "video")).toBe("/synthetic/video.mp4");
    now = 1_099;
    expect(registry.resolve(videoToken, "video")).toBe("/synthetic/video.mp4");
    now = 1_150;
    expect(registry.resolve(videoToken, "video")).toBe("/synthetic/video.mp4");
    expect(() => registry.resolve(videoToken, "decoded-frame")).toThrow(
      "Asset reference is unavailable",
    );

    const expiringToken = registry.issue("decoded-frame", "/synthetic/frame.png", 100);
    now = 1_251;
    expect(() => registry.resolve(expiringToken, "decoded-frame")).toThrow(
      "Asset reference is unavailable",
    );
    expect(() => registry.resolve("missing", "video")).toThrow(
      "Asset reference is unavailable",
    );
  });

  it("uses source time for timed visibility and disables autoplay for reduced motion", () => {
    const scope = { evidenceId: "evidence-alpha", startUs: 400_000, endUs: 600_000 };
    expect(isTimedAnnotationVisible(scope, "evidence-alpha", 500_000)).toBe(true);
    expect(isTimedAnnotationVisible(scope, "evidence-alpha", 700_000)).toBe(false);
    expect(isTimedAnnotationVisible(scope, "evidence-beta", 500_000)).toBe(false);
    expect(shouldAutoplay(true, false)).toBe(true);
    expect(shouldAutoplay(true, true)).toBe(false);
    expect(shouldAutoplay(false, false)).toBe(false);
  });
});

class FakeSourceFactory implements PlaybackSourceFactory {
  readonly sources: FakeSource[] = [];

  open = vi.fn(async () => {
    const source = new FakeSource();
    this.sources.push(source);
    return source;
  });
}

class FakeSource implements PlaybackSource {
  released = false;
  private nextHandle = 1;
  private callbacks = new Map<number, (frame: PlaybackFrame) => void>();

  play = vi.fn(async () => undefined);
  pause = vi.fn();
  seek = vi.fn();

  requestFrame(callback: (frame: PlaybackFrame) => void): number {
    const handle = this.nextHandle++;
    this.callbacks.set(handle, callback);
    return handle;
  }

  cancelFrame(handle: number): void {
    this.callbacks.delete(handle);
  }

  release(): void {
    this.callbacks.clear();
    this.released = true;
  }

  present(timestampUs: number, sampleIndex: number): void {
    const entry = this.callbacks.entries().next().value;
    if (!entry) throw new Error("No frame callback is pending");
    const [handle, callback] = entry;
    this.callbacks.delete(handle);
    callback({ source: document.createElement("canvas"), timestampUs, sampleIndex });
  }
}

class FakeExactFrameLoader implements ExactFrameLoader {
  released = 0;
  fail = false;

  async load(): Promise<CanvasImageSource> {
    if (this.fail) throw new Error("fixture failure");
    return document.createElement("canvas");
  }

  release(): void {
    this.released += 1;
  }
}

class FakeSurface implements PlaybackSurface {
  kind: "poster" | "video" | "exact" = "poster";
  renderCount = 0;

  draw(_source: CanvasImageSource, kind: "video" | "exact"): void {
    this.kind = kind;
  }

  restorePoster(): void {
    this.kind = "poster";
  }

  requestRender(): void {
    this.renderCount += 1;
  }
}

function placement(id: string, surface: PlaybackSurface) {
  return {
    id,
    pageId: "page-alpha",
    evidenceId: `evidence-${id}`,
    sourceToken: `token-${id}`,
    surface,
  };
}

function frameRef(sampleIndex: number, timestampUs: number): DecodedFrameRef {
  return {
    assetToken: TOKEN,
    width: 160,
    height: 90,
    timestampUs,
    sampleIndex,
    mimeType: "image/png",
  };
}

function expectClean(controller: MediaPlaybackController): void {
  expect(controller.activeCallbackCount).toBe(0);
  expect(controller.liveSourceCount).toBe(0);
}
