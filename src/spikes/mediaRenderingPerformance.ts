export const MEDIA_RENDERING_SCHEMA = "gamebook.media-rendering-performance.v1";

export interface DistributionSummary {
  count: number;
  minimum: number;
  median: number;
  p95: number;
  maximum: number;
}

export interface SourceBenchmark {
  id: "1080p60" | "1440p60";
  width: number;
  height: number;
  durationMs: number;
  presentedFrames: number;
  renderedFrames: number;
  droppedPresentedFrames: number;
  droppedRenderCallbacks: number;
  presentedFps: number;
  renderedFps: number;
  transformLatencyMs: DistributionSummary;
  operationsMs: {
    pause: number;
    seek: number;
    exactFrame: number;
    pageSwitch: number;
  };
  visualChecks: {
    placementGeometrySynchronized: boolean;
    seekVisible: boolean;
    exactFrameVisible: boolean;
    pageSwitchCleared: boolean;
  };
  cleanup: {
    activeCallbacks: number;
    liveSources: number;
    decodedFrames: number;
    attachedVideoElements: number;
  };
}

export interface RenderingGateResult {
  approachPassed: boolean;
  frameRatePassed: boolean;
  transformLatencyPassed: boolean;
  cleanupPassed: boolean;
  visualPassed: boolean;
  memoryPassed: boolean | null;
  fallbackEvaluationRequired: boolean;
}

export function summarize(values: number[]): DistributionSummary {
  if (values.length === 0) {
    return { count: 0, minimum: 0, median: 0, p95: 0, maximum: 0 };
  }
  const sorted = [...values].sort((left, right) => left - right);
  return {
    count: sorted.length,
    minimum: round(sorted[0]),
    median: round(percentile(sorted, 0.5)),
    p95: round(percentile(sorted, 0.95)),
    maximum: round(sorted[sorted.length - 1]),
  };
}

export function evaluateRenderingGate(
  sources: SourceBenchmark[],
  memoryDeltaBytes: number | null,
): RenderingGateResult {
  const frameRatePassed = sources.length === 2
    && sources.every((source) => source.renderedFps >= 55);
  const transformLatencyPassed = sources.length === 2
    && sources.every((source) => source.transformLatencyMs.count >= 30
      && source.transformLatencyMs.p95 < 50);
  const cleanupPassed = sources.length === 2
    && sources.every((source) => Object.values(source.cleanup).every((value) => value === 0));
  const visualPassed = sources.length === 2
    && sources.every((source) => Object.values(source.visualChecks).every((value) => value));
  const memoryPassed = memoryDeltaBytes === null ? null : memoryDeltaBytes <= 100 * 1024 * 1024;
  const approachPassed = frameRatePassed
    && transformLatencyPassed
    && cleanupPassed
    && visualPassed
    && memoryPassed === true;
  return {
    approachPassed,
    frameRatePassed,
    transformLatencyPassed,
    cleanupPassed,
    visualPassed,
    memoryPassed,
    fallbackEvaluationRequired: !approachPassed,
  };
}

function percentile(sorted: number[], fraction: number): number {
  const index = Math.max(0, Math.ceil(sorted.length * fraction) - 1);
  return sorted[index];
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
