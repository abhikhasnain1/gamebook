import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const REQUIRED_SCHEMA = "gamebook.viewport-spike.v1";
const REQUIRED_CHECKS = [
  "fit-default",
  "zoom-range",
  "pan-paths",
  "keyboard-intent",
  "stable-page-state",
  "history-unchanged",
  "connector-scene-coordinates",
  "static-export-pixels",
  "thumbnail-pixels",
  "malformed-input",
  "semantic-controls",
];
const REQUIRED_PATHS = [
  "fit-default",
  "zoom-25",
  "zoom-50",
  "zoom-100",
  "zoom-200",
  "reset-100",
  "control-pan-left",
  "control-pan-right",
  "space-arrow-up",
  "space-arrow-down",
  "space-primary-drag",
  "middle-button-drag",
  "compact-resize",
  "large-resize",
];
const PRIVATE_MARKERS = [
  /[a-z]:\\/i,
  /\/users\//i,
  /objecturl/i,
  /blob:/i,
  /data:image/i,
  /assettoken/i,
];

const args = process.argv.slice(2);
if (args.includes("--self-test")) {
  selfTest();
} else {
  const reportPath = valueAfter(args, "--report");
  if (!reportPath) fail("Usage: --self-test or --report PATH");
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  verifyReport(report);
  console.log(`Verified view-only viewport evidence: ${reportPath}`);
}

export function verifyReport(report) {
  assert.equal(report.schema, REQUIRED_SCHEMA, "unexpected report schema");
  assert.equal(report.status, "passed", "harness status must be passed");
  assert.match(report.generatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, "generatedAt must be ISO-8601");
  assert.match(report.buildRevision, /^[0-9a-f]{40}$/i, "buildRevision must be an exact commit");
  assert.equal(report.fixture, "deterministic-viewport-page-v1", "unexpected fixture");
  assert.ok(report.environment?.userAgent?.includes("Chrome/"), "Chromium user agent is required");
  assert.ok(Number.isInteger(report.environment?.hardwareConcurrency), "hardware concurrency is required");
  assert.ok(report.environment.hardwareConcurrency > 0, "hardware concurrency must be positive");
  assert.ok(Number.isFinite(report.environment?.devicePixelRatio), "device pixel ratio is required");
  assert.ok(report.environment.devicePixelRatio > 0, "device pixel ratio must be positive");
  assert.ok([1, 2].includes(report.environment?.uiScale), "UI scale must be 1 or 2");
  assert.ok(report.environment?.viewport?.width >= 900, "viewport width must be at least 900");
  assert.ok(report.environment?.viewport?.height >= 620, "viewport height must be at least 620");

  assert.deepEqual(report.logicalPage, { width: 1600, height: 900 }, "logical page changed");
  assert.deepEqual(report.supportedZoomPercents, [25, 50, 100, 200], "supported zoom range changed");
  assert.deepEqual(report.checks?.map((check) => check.id), REQUIRED_CHECKS, "required checks must be complete and ordered");
  report.checks.forEach((check) => {
    assert.equal(check.passed, true, `${check.id} did not pass`);
    assert.ok(typeof check.detail === "string" && check.detail.length > 0, `${check.id} detail is missing`);
  });

  assert.deepEqual(report.paths?.map((path) => path.id), REQUIRED_PATHS, "viewport paths must be complete and ordered");
  assertArtifact(report.baseline, "baseline");
  report.paths.forEach((path) => {
    assert.equal(path.pageStateStable, true, `${path.id} changed page state`);
    assert.equal(path.historyStable, true, `${path.id} changed history`);
    assert.equal(path.connectorsStable, true, `${path.id} changed connector coordinates`);
    assert.deepEqual(path.transform?.length, 6, `${path.id} transform must contain six values`);
    path.transform.forEach((value) => assert.ok(Number.isFinite(value), `${path.id} transform is not finite`));
    assertArtifact(path, path.id);
    assert.equal(path.exportSha256, report.baseline.exportSha256, `${path.id} changed export pixels`);
    assert.equal(path.exportBytes, report.baseline.exportBytes, `${path.id} changed export bytes`);
    assert.equal(path.thumbnailSha256, report.baseline.thumbnailSha256, `${path.id} changed thumbnail pixels`);
    assert.equal(path.thumbnailBytes, report.baseline.thumbnailBytes, `${path.id} changed thumbnail bytes`);
  });

  assert.deepEqual(report.serializedKeys, ["activePageId", "pages"], "viewport state entered serialization");
  const serialized = JSON.stringify(report);
  for (const marker of PRIVATE_MARKERS) {
    assert.doesNotMatch(serialized, marker, `report contains private or runtime data: ${marker}`);
  }
  return report;
}

function assertArtifact(artifact, label) {
  assert.match(artifact?.exportSha256, /^[0-9a-f]{64}$/i, `${label} export hash is invalid`);
  assert.ok(Number.isInteger(artifact?.exportBytes) && artifact.exportBytes > 10_000, `${label} export is unexpectedly small`);
  assert.match(artifact?.thumbnailSha256, /^[0-9a-f]{64}$/i, `${label} thumbnail hash is invalid`);
  assert.ok(Number.isInteger(artifact?.thumbnailBytes) && artifact.thumbnailBytes > 1_000, `${label} thumbnail is unexpectedly small`);
}

function selfTest() {
  const valid = syntheticReport();
  verifyReport(valid);
  assert.throws(() => verifyReport({ ...valid, status: "failed" }), /harness status must be passed/);
  assert.throws(
    () => verifyReport({ ...valid, serializedKeys: [...valid.serializedKeys, "viewportTransform"] }),
    /viewport state entered serialization/,
  );
  const changedPath = { ...valid.paths[0], exportSha256: "b".repeat(64) };
  assert.throws(
    () => verifyReport({ ...valid, paths: [changedPath, ...valid.paths.slice(1)] }),
    /changed export pixels/,
  );
  assert.throws(() => verifyReport({ ...valid, buildRevision: "working-tree" }), /exact commit/);
  console.log("View-only viewport verifier self-test passed.");
}

function syntheticReport() {
  const artifact = {
    exportSha256: "a".repeat(64),
    exportBytes: 43_601,
    thumbnailSha256: "c".repeat(64),
    thumbnailBytes: 2_577,
  };
  return {
    schema: REQUIRED_SCHEMA,
    status: "passed",
    generatedAt: "2026-08-01T00:00:00.000Z",
    buildRevision: "0123456789abcdef0123456789abcdef01234567",
    fixture: "deterministic-viewport-page-v1",
    environment: {
      userAgent: "Mozilla/5.0 Chrome/150.0.0.0",
      hardwareConcurrency: 8,
      devicePixelRatio: 1,
      uiScale: 1,
      viewport: { width: 1280, height: 720 },
    },
    checks: REQUIRED_CHECKS.map((id) => ({ id, passed: true, detail: `${id} passed` })),
    logicalPage: { width: 1600, height: 900 },
    supportedZoomPercents: [25, 50, 100, 200],
    paths: REQUIRED_PATHS.map((id) => ({
      id,
      zoomPercent: id.startsWith("zoom-") ? Number(id.slice(5)) : 100,
      transform: [1, 0, 0, 1, 0, 0],
      pageStateStable: true,
      historyStable: true,
      connectorsStable: true,
      ...artifact,
    })),
    baseline: artifact,
    serializedKeys: ["activePageId", "pages"],
  };
}

function valueAfter(values, flag) {
  const index = values.indexOf(flag);
  return index >= 0 ? values[index + 1] : undefined;
}

function fail(message) {
  console.error(message);
  process.exitCode = 1;
  throw new Error(message);
}
