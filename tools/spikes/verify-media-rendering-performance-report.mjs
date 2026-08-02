import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const SCHEMA = "gamebook.media-rendering-performance.v1";
const SOURCE_IDS = ["1080p60", "1440p60"];
const PRIVATE_MARKERS = [/[a-z]:\\/i, /\/users\//i, /blob:/i, /data:video/i, /assettoken/i, /objecturl/i];
const args = process.argv.slice(2);

if (args.includes("--self-test")) {
  selfTest();
} else {
  const fabricPath = valueAfter(args, "--fabric");
  const domPath = valueAfter(args, "--dom");
  if (!fabricPath || !domPath) throw new Error("Usage: --self-test or --fabric PATH --dom PATH");
  verifyComparison(
    JSON.parse(await readFile(fabricPath, "utf8")),
    JSON.parse(await readFile(domPath, "utf8")),
  );
  console.log(`Verified media rendering comparison: ${fabricPath} and ${domPath}`);
}

export function verifyComparison(fabric, dom) {
  verifyCommon(fabric, "fabric-offscreen-surface");
  verifyCommon(dom, "layered-dom-video");
  assert.equal(fabric.status, "failed", "Fabric result must retain its failed memory gate");
  assert.deepEqual(fabric.gate, {
    approachPassed: false,
    frameRatePassed: true,
    transformLatencyPassed: true,
    cleanupPassed: true,
    visualPassed: true,
    memoryPassed: false,
    fallbackEvaluationRequired: true,
  });
  assert.equal(fabric.system.privateMemoryDeltaBytes > 100 * 1024 * 1024, true);

  assert.equal(dom.status, "passed", "layered DOM result must pass every gate");
  assert.deepEqual(dom.gate, {
    approachPassed: true,
    frameRatePassed: true,
    transformLatencyPassed: true,
    cleanupPassed: true,
    visualPassed: true,
    memoryPassed: true,
    fallbackEvaluationRequired: false,
  });
  assert.equal(dom.system.privateMemoryDeltaBytes <= 100 * 1024 * 1024, true);
  assert.equal(dom.system.privateMemoryDeltaBytes < fabric.system.privateMemoryDeltaBytes, true);

  assert.equal(dom.buildRevision, fabric.buildRevision, "comparison must use one exact revision");
  assert.equal(dom.collection.fixtureGeneratorSha256, fabric.collection.fixtureGeneratorSha256);
  assert.deepEqual(
    dom.fixtureEvidence.map(({ id, sha256 }) => ({ id, sha256 })),
    fabric.fixtureEvidence.map(({ id, sha256 }) => ({ id, sha256 })),
    "comparison fixtures changed between approaches",
  );
  return { fabric, dom };
}

function verifyCommon(report, approach) {
  assert.equal(report.schema, SCHEMA, "unexpected report schema");
  assert.match(report.generatedAt, /^\d{4}-\d{2}-\d{2}T/, "generatedAt must be ISO-8601");
  assert.match(report.buildRevision, /^[a-f0-9]{40}$/i, "build must be an exact commit");
  assert.equal(report.renderingApproach, approach);
  assert.ok(report.environment?.userAgent?.includes("Chrome/"), "Chromium evidence is required");
  assert.equal(report.environment?.videoFrameCallbackSupported, true);
  assert.ok(report.environment?.viewport?.width >= 900 && report.environment?.viewport?.height >= 620);
  assert.equal(typeof report.environment?.reducedMotion, "boolean");
  assert.equal(typeof report.environment?.forcedColors, "boolean");
  assert.equal(report.environment?.uiScale, 1, "decision run must use 100% UI scale");

  assert.deepEqual(report.sources?.map((source) => source.id), SOURCE_IDS);
  report.sources.forEach((source) => {
    assert.equal(source.durationMs >= 30_000, true, `${source.id} duration was too short`);
    assert.equal(source.renderedFps >= 55, true, `${source.id} rendered below 55 FPS`);
    assert.equal(source.transformLatencyMs?.count >= 30, true, `${source.id} lacks transform samples`);
    assert.equal(source.transformLatencyMs?.p95 < 50, true, `${source.id} transform p95 reached 50 ms`);
    ["pause", "seek", "exactFrame", "pageSwitch"].forEach((operation) => {
      assert.ok(Number.isFinite(source.operationsMs?.[operation]), `${source.id} ${operation} timing is missing`);
    });
    assert.deepEqual(Object.values(source.visualChecks), [true, true, true, true], `${source.id} visual mode check failed`);
    assert.deepEqual(Object.values(source.cleanup), [0, 0, 0, 0], `${source.id} leaked runtime state`);
  });

  assert.deepEqual(report.fixtureEvidence?.map((fixture) => fixture.id), SOURCE_IDS);
  report.fixtureEvidence.forEach((fixture, index) => {
    assert.equal(fixture.width, index === 0 ? 1920 : 2560);
    assert.equal(fixture.height, index === 0 ? 1080 : 1440);
    assert.equal(fixture.frameRate, 60);
    assert.equal(fixture.durationSeconds, 30);
    assert.equal(fixture.submittedFrames, 1_800);
    assert.equal(fixture.applicationBuild, report.buildRevision);
    assert.match(fixture.sha256, /^[a-f0-9]{64}$/i);
  });
  assert.equal(report.lifecycleLoops, 10);
  assert.deepEqual(report.semanticControls?.namedControls, ["Run rendering benchmark"]);
  assert.equal(report.semanticControls?.keyboardOperable, true);
  assert.equal(report.semanticControls?.statusAnnouncements, true);

  assert.ok(report.referenceEnvironment?.windows?.version);
  assert.ok(report.referenceEnvironment?.cpu?.Name);
  assert.ok(Array.isArray(report.referenceEnvironment?.gpu) && report.referenceEnvironment.gpu.length > 0);
  assert.ok(report.referenceEnvironment?.ramBytes > 0);
  assert.ok(Array.isArray(report.referenceEnvironment?.displayModes));
  assert.ok(report.referenceEnvironment?.edgeVersion);
  assert.ok(report.referenceEnvironment?.powerScheme);
  assert.ok(report.system?.sampleCount >= 4, "system sampling is incomplete");
  assert.ok(Number.isFinite(report.system?.cpuPercent?.mean));
  assert.ok(Number.isFinite(report.system?.gpuPercent?.mean));

  assert.deepEqual(report.security?.networkOrigins, ["http://127.0.0.1:1420"]);
  assert.equal(report.security?.sourceUrlsPersisted, false);
  assert.equal(report.security?.mediaTokensPersisted, false);
  assert.equal(report.security?.projectWrites, false);
  assert.equal(report.security?.diagnosticsContainPaths, false);
  assert.equal(report.collection?.isolatedProfile, true);
  assert.equal(report.collection?.hardwareAccelerationRequested, true);
  assert.equal(report.collection?.wallClockSampling, true);
  assert.deepEqual(report.collection?.requestedViewport, { width: 1280, height: 720 });
  assert.equal(report.collection?.requestedUiScale, 1);
  assert.equal(report.collection?.requestedReducedMotion, false);
  assert.equal(report.collection?.requestedForcedColors, false);
  assert.match(report.collection?.fixtureGeneratorSha256, /^[a-f0-9]{64}$/i);
  const serialized = JSON.stringify(report);
  PRIVATE_MARKERS.forEach((marker) => assert.doesNotMatch(serialized, marker));
}

function selfTest() {
  const fabric = syntheticReport("fabric-offscreen-surface", 112 * 1024 * 1024);
  const dom = syntheticReport("layered-dom-video", 8 * 1024 * 1024);
  verifyComparison(fabric, dom);
  assert.throws(() => verifyComparison({ ...fabric, buildRevision: "working-tree" }, dom), /exact commit/);
  assert.throws(() => verifyComparison(fabric, {
    ...dom,
    sources: [dom.sources[0], { ...dom.sources[1], renderedFps: 54.999 }],
  }), /rendered below 55 FPS/);
  assert.throws(() => verifyComparison(fabric, {
    ...dom,
    fixtureEvidence: [{ ...dom.fixtureEvidence[0], sha256: "b".repeat(64) }, dom.fixtureEvidence[1]],
  }), /fixtures changed/);
  console.log("Media rendering comparison verifier self-test passed.");
}

function syntheticReport(approach, memoryDeltaBytes) {
  const source = (id, width, height) => ({
    id, width, height, durationMs: 30_001, presentedFrames: 1_780, renderedFrames: 1_770,
    droppedPresentedFrames: 20, droppedRenderCallbacks: 10, presentedFps: 59.3, renderedFps: 59,
    transformLatencyMs: { count: 150, minimum: 1, median: 8, p95: 20, maximum: 30 },
    operationsMs: { pause: 3, seek: 12, exactFrame: 15, pageSwitch: 5 },
    visualChecks: { placementGeometrySynchronized: true, seekVisible: true, exactFrameVisible: true, pageSwitchCleared: true },
    cleanup: { activeCallbacks: 0, liveSources: 0, decodedFrames: 0, attachedVideoElements: 0 },
  });
  const approachPassed = memoryDeltaBytes <= 100 * 1024 * 1024;
  const build = "0123456789abcdef0123456789abcdef01234567";
  return {
    schema: SCHEMA, status: approachPassed ? "passed" : "failed", generatedAt: "2026-08-01T00:00:00.000Z",
    buildRevision: build, renderingApproach: approach,
    environment: { userAgent: "Chrome/150", viewport: { width: 1280, height: 720 }, videoFrameCallbackSupported: true, reducedMotion: false, forcedColors: false, uiScale: 1 },
    sources: [source("1080p60", 1920, 1080), source("1440p60", 2560, 1440)],
    fixtureEvidence: SOURCE_IDS.map((id, index) => ({ id, width: index === 0 ? 1920 : 2560, height: index === 0 ? 1080 : 1440, frameRate: 60, durationSeconds: 30, submittedFrames: 1_800, applicationBuild: build, sha256: "a".repeat(64) })),
    lifecycleLoops: 10,
    semanticControls: { namedControls: ["Run rendering benchmark"], keyboardOperable: true, statusAnnouncements: true },
    referenceEnvironment: { windows: { version: "10" }, cpu: { Name: "Reference CPU" }, gpu: [{ Name: "Reference GPU" }], ramBytes: 16, displayModes: [], edgeVersion: "150", powerScheme: "Balanced" },
    system: { privateMemoryDeltaBytes: memoryDeltaBytes, sampleCount: 8, cpuPercent: { mean: 5 }, gpuPercent: { mean: 10 } },
    security: { networkOrigins: ["http://127.0.0.1:1420"], sourceUrlsPersisted: false, mediaTokensPersisted: false, projectWrites: false, diagnosticsContainPaths: false },
    collection: { isolatedProfile: true, hardwareAccelerationRequested: true, wallClockSampling: true, requestedViewport: { width: 1280, height: 720 }, requestedUiScale: 1, requestedReducedMotion: false, requestedForcedColors: false, fixtureGeneratorSha256: "c".repeat(64) },
    gate: { approachPassed, frameRatePassed: true, transformLatencyPassed: true, cleanupPassed: true, visualPassed: true, memoryPassed: approachPassed, fallbackEvaluationRequired: !approachPassed },
  };
}

function valueAfter(values, flag) {
  const index = values.indexOf(flag);
  return index >= 0 ? values[index + 1] : undefined;
}
