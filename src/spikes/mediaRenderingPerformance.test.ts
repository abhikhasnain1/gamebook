import { describe, expect, it } from "vitest";
import {
  evaluateRenderingGate,
  summarize,
  type SourceBenchmark,
} from "./mediaRenderingPerformance";

function source(id: SourceBenchmark["id"], overrides: Partial<SourceBenchmark> = {}): SourceBenchmark {
  return {
    id,
    width: id === "1080p60" ? 1920 : 2560,
    height: id === "1080p60" ? 1080 : 1440,
    durationMs: 30_000,
    presentedFrames: 1_800,
    renderedFrames: 1_780,
    droppedPresentedFrames: 0,
    droppedRenderCallbacks: 20,
    presentedFps: 60,
    renderedFps: 59.333,
    transformLatencyMs: { count: 60, minimum: 2, median: 8, p95: 18, maximum: 23 },
    operationsMs: { pause: 5, seek: 15, exactFrame: 20, pageSwitch: 8 },
    visualChecks: { placementGeometrySynchronized: true, seekVisible: true, exactFrameVisible: true, pageSwitchCleared: true },
    cleanup: { activeCallbacks: 0, liveSources: 0, decodedFrames: 0, attachedVideoElements: 0 },
    ...overrides,
  };
}

describe("media rendering performance gate", () => {
  it("uses an inclusive 55 FPS gate and a strict sub-50 ms p95 latency gate", () => {
    const result = evaluateRenderingGate([
      source("1080p60", { renderedFps: 55 }),
      source("1440p60", {
        transformLatencyMs: { count: 60, minimum: 2, median: 8, p95: 49.999, maximum: 55 },
      }),
    ], 100 * 1024 * 1024);

    expect(result).toEqual({
      approachPassed: true,
      frameRatePassed: true,
      transformLatencyPassed: true,
      cleanupPassed: true,
      visualPassed: true,
      memoryPassed: true,
      fallbackEvaluationRequired: false,
    });
  });

  it("requires fallback evaluation when any measured gate fails or memory is absent", () => {
    expect(evaluateRenderingGate([
      source("1080p60"),
      source("1440p60", { renderedFps: 54.999 }),
    ], null)).toMatchObject({
      approachPassed: false,
      frameRatePassed: false,
      memoryPassed: null,
      fallbackEvaluationRequired: true,
    });
  });

  it("summarizes deterministic nearest-rank distributions", () => {
    expect(summarize([10, 1, 5, 7, 3])).toEqual({
      count: 5,
      minimum: 1,
      median: 5,
      p95: 10,
      maximum: 10,
    });
  });
});
