import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const REQUIRED_SCHEMA = "gamebook.media-placement-geometry.v1";
const REQUIRED_CHECKS = [
  "stable-record",
  "runtime-state-excluded",
  "fabric-round-trip",
  "hit-testing",
  "composition-order",
  "connector-anchor",
  "history",
  "page-switch",
  "static-export",
  "semantic-outline",
];
const ALLOWED_SERIALIZED_KEYS = new Set([
  "angle",
  "crop",
  "evidenceId",
  "id",
  "left",
  "placementVersion",
  "posterTimestampUs",
  "scaleX",
  "scaleY",
  "top",
  "type",
  "zIndex",
]);
const PRIVATE_MARKERS = [
  /[a-z]:\\/i,
  /\/users\//i,
  /objecturl/i,
  /blob:/i,
  /data:image/i,
  /assetToken/i,
];

const args = process.argv.slice(2);
if (args.includes("--self-test")) {
  selfTest();
} else {
  const reportPath = valueAfter(args, "--report");
  if (!reportPath) fail("Usage: --self-test or --report PATH");
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  verifyReport(report);
  console.log(`Verified MediaPlacement geometry evidence: ${reportPath}`);
}

export function verifyReport(report) {
  assert.equal(report.schema, REQUIRED_SCHEMA, "unexpected report schema");
  assert.equal(report.status, "passed", "harness status must be passed");
  assert.match(report.generatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, "generatedAt must be ISO-8601");
  assert.match(report.buildRevision, /^[0-9a-f]{40}$/i, "buildRevision must be an exact commit");
  assert.equal(report.fixture, "deterministic-poster-pages-v1", "unexpected fixture");
  assert.ok(report.environment?.userAgent?.includes("Chrome/"), "Chromium user agent is required");
  assert.ok(Number.isInteger(report.environment?.hardwareConcurrency), "hardware concurrency is required");
  assert.ok(report.environment.hardwareConcurrency > 0, "hardware concurrency must be positive");
  assert.ok(report.environment?.viewport?.width >= 900, "viewport width must be at least 900");
  assert.ok(report.environment?.viewport?.height >= 620, "viewport height must be at least 620");

  const checkIds = report.checks?.map((check) => check.id) ?? [];
  assert.deepEqual(checkIds, REQUIRED_CHECKS, "required checks must be complete and ordered");
  report.checks.forEach((check) => {
    assert.equal(check.passed, true, `${check.id} did not pass`);
    assert.equal(typeof check.detail, "string", `${check.id} detail is missing`);
    assert.ok(check.detail.length > 0, `${check.id} detail is empty`);
  });

  assert.ok(Array.isArray(report.serializedKeys), "serializedKeys must be an array");
  report.serializedKeys.forEach((key) => {
    assert.ok(ALLOWED_SERIALIZED_KEYS.has(key), `serialized runtime key is not allowed: ${key}`);
  });
  assert.ok(report.serializedKeys.includes("id"), "serialized placement id is required");
  assert.ok(report.serializedKeys.includes("evidenceId"), "serialized evidence id is required");
  assert.ok(!report.serializedKeys.includes("src"), "image source must not be serialized");
  assert.deepEqual(report.compositionOrder, [
    "placement-1080p",
    "placement-1440p",
    "annotation-finding",
    "connector-evidence-finding",
  ], "composition order changed");
  assert.ok(report.exportDataUrlLength > 10_000, "static export is unexpectedly small");

  const serialized = JSON.stringify(report);
  PRIVATE_MARKERS.forEach((pattern) => {
    assert.doesNotMatch(serialized, pattern, `report contains private or runtime data: ${pattern}`);
  });
  return report;
}

function selfTest() {
  const valid = syntheticReport();
  verifyReport(valid);
  assert.throws(
    () => verifyReport({ ...valid, status: "failed" }),
    /harness status must be passed/,
  );
  assert.throws(
    () => verifyReport({ ...valid, serializedKeys: [...valid.serializedKeys, "src"] }),
    /serialized runtime key is not allowed/,
  );
  assert.throws(
    () => verifyReport({ ...valid, buildRevision: "working-tree" }),
    /exact commit/,
  );
  console.log("MediaPlacement geometry verifier self-test passed.");
}

function syntheticReport() {
  return {
    schema: REQUIRED_SCHEMA,
    status: "passed",
    generatedAt: "2026-08-01T00:00:00.000Z",
    buildRevision: "0123456789abcdef0123456789abcdef01234567",
    fixture: "deterministic-poster-pages-v1",
    environment: {
      userAgent: "Mozilla/5.0 Chrome/140.0.0.0",
      hardwareConcurrency: 8,
      viewport: { width: 1280, height: 720 },
    },
    checks: REQUIRED_CHECKS.map((id) => ({ id, passed: true, detail: `${id} passed` })),
    serializedKeys: [
      "angle",
      "evidenceId",
      "id",
      "left",
      "placementVersion",
      "posterTimestampUs",
      "scaleX",
      "scaleY",
      "top",
      "type",
      "zIndex",
    ],
    compositionOrder: [
      "placement-1080p",
      "placement-1440p",
      "annotation-finding",
      "connector-evidence-finding",
    ],
    exportDataUrlLength: 45_000,
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
