import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const SCHEMA = "gamebook.media-rendering-performance.v1";
const SOURCE_IDS = ["1080p60", "1440p60"];
const PRIVATE_MARKERS = [/[a-z]:\\/i, /\/users\//i, /blob:/i, /data:video/i, /assettoken/i];
const args = process.argv.slice(2);

if (args.includes("--self-test")) {
  selfTest();
} else {
  const path = valueAfter(args, "--report");
  if (!path) throw new Error("Usage: --self-test or --report PATH");
  verifyReport(JSON.parse(await readFile(path, "utf8")));
  console.log(`Verified media rendering performance evidence: ${path}`);
}

export function verifyReport(report) {
  assert.equal(report.schema, SCHEMA, "unexpected report schema");
  assert.equal(report.status, "passed", "rendering gate did not pass");
  assert.match(report.buildRevision, /^[a-f0-9]{40}$/i, "build must be an exact commit");
  assert.equal(report.renderingApproach, "fabric-offscreen-surface");
  assert.ok(report.environment?.userAgent?.includes("Chrome/"), "Chromium evidence is required");
  assert.equal(report.environment?.videoFrameCallbackSupported, true);
  assert.ok(report.environment?.viewport?.width >= 900 && report.environment?.viewport?.height >= 620);
  assert.deepEqual(report.sources?.map((source) => source.id), SOURCE_IDS);
  report.sources.forEach((source) => {
    assert.equal(source.durationMs >= 30_000, true, `${source.id} duration was too short`);
    assert.equal(source.renderedFps >= 55, true, `${source.id} rendered below 55 FPS`);
    assert.equal(source.transformLatencyMs?.count >= 30, true, `${source.id} lacks transform samples`);
    assert.equal(source.transformLatencyMs?.p95 < 50, true, `${source.id} transform p95 reached 50 ms`);
    assert.ok(Number.isFinite(source.operationsMs?.pause));
    assert.ok(Number.isFinite(source.operationsMs?.seek));
    assert.ok(Number.isFinite(source.operationsMs?.exactFrame));
    assert.ok(Number.isFinite(source.operationsMs?.pageSwitch));
    assert.deepEqual(Object.values(source.cleanup), [0, 0, 0, 0], `${source.id} leaked runtime state`);
  });
  assert.deepEqual(report.fixtureEvidence?.map((fixture) => fixture.id), SOURCE_IDS);
  report.fixtureEvidence.forEach((fixture) => {
    assert.equal(fixture.frameRate, 60);
    assert.equal(fixture.durationSeconds, 30);
    assert.equal(fixture.submittedFrames, 1_800);
    assert.match(fixture.sha256, /^[a-f0-9]{64}$/i);
  });
  assert.equal(report.lifecycleLoops, 10);
  assert.equal(report.system?.privateMemoryDeltaBytes <= 100 * 1024 * 1024, true, "private memory did not return within 100 MB");
  assert.ok(report.system?.sampleCount >= 4, "system sampling is incomplete");
  assert.ok(Number.isFinite(report.system?.cpuPercent?.mean));
  assert.ok(Number.isFinite(report.system?.gpuPercent?.mean));
  assert.deepEqual(report.gate, {
    fabricPassed: true,
    frameRatePassed: true,
    transformLatencyPassed: true,
    cleanupPassed: true,
    memoryPassed: true,
    fallbackEvaluationRequired: false,
  });
  assert.deepEqual(report.security?.networkOrigins, ["http://127.0.0.1:1420"]);
  assert.equal(report.security?.sourceUrlsPersisted, false);
  assert.equal(report.security?.mediaTokensPersisted, false);
  assert.equal(report.security?.projectWrites, false);
  assert.equal(report.collection?.isolatedProfile, true);
  assert.equal(report.collection?.wallClockSampling, true);
  const serialized = JSON.stringify(report);
  PRIVATE_MARKERS.forEach((marker) => assert.doesNotMatch(serialized, marker));
  return report;
}

function selfTest() {
  const valid = syntheticReport();
  verifyReport(valid);
  assert.throws(() => verifyReport({ ...valid, status: "failed" }), /did not pass/);
  assert.throws(() => verifyReport({
    ...valid,
    sources: [valid.sources[0], { ...valid.sources[1], renderedFps: 54.999 }],
  }), /rendered below 55 FPS/);
  assert.throws(() => verifyReport({
    ...valid,
    system: { ...valid.system, privateMemoryDeltaBytes: 100 * 1024 * 1024 + 1 },
  }), /private memory/);
  console.log("Media rendering performance verifier self-test passed.");
}

function syntheticReport() {
  const source = (id, width, height) => ({
    id, width, height, durationMs: 30_001, presentedFrames: 1_780, renderedFrames: 1_770,
    droppedPresentedFrames: 20, droppedRenderCallbacks: 10, presentedFps: 59.3, renderedFps: 59,
    transformLatencyMs: { count: 150, minimum: 1, median: 8, p95: 20, maximum: 30 },
    operationsMs: { pause: 3, seek: 12, exactFrame: 15, pageSwitch: 5 },
    cleanup: { activeCallbacks: 0, liveSources: 0, decodedFrames: 0, attachedVideoElements: 0 },
  });
  return {
    schema: SCHEMA, status: "passed", generatedAt: "2026-08-01T00:00:00.000Z",
    buildRevision: "0123456789abcdef0123456789abcdef01234567",
    renderingApproach: "fabric-offscreen-surface",
    environment: { userAgent: "Chrome/150", viewport: { width: 1280, height: 720 }, videoFrameCallbackSupported: true },
    sources: [source("1080p60", 1920, 1080), source("1440p60", 2560, 1440)],
    fixtureEvidence: SOURCE_IDS.map((id) => ({ id, frameRate: 60, durationSeconds: 30, submittedFrames: 1_800, sha256: "a".repeat(64) })),
    lifecycleLoops: 10,
    system: { privateMemoryDeltaBytes: 64 * 1024 * 1024, sampleCount: 8, cpuPercent: { mean: 5 }, gpuPercent: { mean: 10 } },
    security: { networkOrigins: ["http://127.0.0.1:1420"], sourceUrlsPersisted: false, mediaTokensPersisted: false, projectWrites: false },
    collection: { isolatedProfile: true, wallClockSampling: true },
    gate: { fabricPassed: true, frameRatePassed: true, transformLatencyPassed: true, cleanupPassed: true, memoryPassed: true, fallbackEvaluationRequired: false },
  };
}

function valueAfter(values, flag) {
  const index = values.indexOf(flag);
  return index >= 0 ? values[index + 1] : undefined;
}
