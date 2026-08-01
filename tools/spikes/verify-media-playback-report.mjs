import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const REQUIRED_SCHEMA = "gamebook.media-playback.v1";
const REQUIRED_CHECKS = [
  "video-frame-callback",
  "seek",
  "one-active-placement",
  "exact-frame-substitution",
  "timed-annotation-layering",
  "shared-geometry",
  "poster-restoration",
  "failure-preserves-poster",
  "lifecycle-cleanup",
  "opaque-token-boundary",
  "semantic-controls",
];
const REQUIRED_CLEANUP = ["pause", "page-switch", "export", "minimize", "deletion", "disposal"];
const ALLOWED_PERSISTED_KEYS = new Set([
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
  /assetToken/i,
  /sourceToken/i,
  /blob:/i,
  /data:image/i,
  /https?:\/\//i,
];

const args = process.argv.slice(2);
if (args.includes("--self-test")) {
  selfTest();
} else {
  const reportPath = valueAfter(args, "--report");
  if (!reportPath) fail("Usage: --self-test or --report PATH");
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  verifyReport(report);
  console.log(`Verified offscreen media playback evidence: ${reportPath}`);
}

export function verifyReport(report) {
  assert.equal(report.schema, REQUIRED_SCHEMA, "unexpected report schema");
  assert.equal(report.status, "passed", "harness status must be passed");
  assert.match(report.generatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, "generatedAt must be ISO-8601");
  assert.match(report.buildRevision, /^[0-9a-f]{40}$/i, "buildRevision must be an exact commit");
  assert.equal(report.fixture?.id, "native-decode-cfr60-issue-8", "unexpected fixture");
  assert.equal(
    report.fixture.videoSha256,
    "b1b33aa040553a781420fcc2d56a0e5f2089c430f85b20deac657d1c9d935795",
    "video fixture hash changed",
  );
  assert.equal(
    report.fixture.exactFrameSha256,
    "639aba824b4406b29ccfdd5d72f5aa14ab9e11776dccef3a40cc3fc33249ccfd",
    "exact-frame fixture hash changed",
  );
  assert.ok(report.environment?.userAgent?.includes("Chrome/"), "Chromium user agent is required");
  assert.ok(Number.isInteger(report.environment?.hardwareConcurrency), "hardware concurrency is required");
  assert.ok(report.environment.hardwareConcurrency > 0, "hardware concurrency must be positive");
  assert.ok(report.environment?.viewport?.width >= 900, "viewport width must be at least 900");
  assert.ok(report.environment?.viewport?.height >= 620, "viewport height must be at least 620");
  assert.equal(report.environment?.videoFrameCallbackSupported, true, "video frame callbacks are required");

  const checkIds = report.checks?.map((check) => check.id) ?? [];
  assert.deepEqual(checkIds, REQUIRED_CHECKS, "required checks must be complete and ordered");
  report.checks.forEach((check) => {
    assert.equal(check.passed, true, `${check.id} did not pass`);
    assert.equal(typeof check.detail, "string", `${check.id} detail is missing`);
    assert.ok(check.detail.length > 0, `${check.id} detail is empty`);
  });

  assert.ok(report.renderedVideoFrames > 0, "no browser video frame was rendered");
  assert.deepEqual(report.exactFrame, { timestampUs: 500_000, sampleIndex: 30 }, "exact frame changed");
  assert.deepEqual(report.cleanup?.map((entry) => entry.reason), REQUIRED_CLEANUP, "cleanup scenarios changed");
  report.cleanup.forEach((entry) => {
    assert.equal(entry.activeCallbacks, 0, `${entry.reason} retained a callback`);
    assert.equal(entry.liveSources, 0, `${entry.reason} retained a source`);
  });
  assert.equal(report.sourceUrlsExposed, false, "source URLs must not be exposed");
  assert.ok(Array.isArray(report.persistedRuntimeKeys), "persistedRuntimeKeys must be an array");
  report.persistedRuntimeKeys.forEach((key) => {
    assert.ok(ALLOWED_PERSISTED_KEYS.has(key), `runtime state entered persistence: ${key}`);
  });
  assert.ok(report.persistedRuntimeKeys.includes("id"), "placement id must persist");
  assert.ok(report.persistedRuntimeKeys.includes("evidenceId"), "evidence id must persist");
  const geometry = JSON.parse(report.geometryFingerprint);
  assert.equal(geometry.length, 2, "geometry fingerprint must include both placements");

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
    () => verifyReport({ ...valid, cleanup: valid.cleanup.map((entry, index) => index === 0 ? { ...entry, activeCallbacks: 1 } : entry) }),
    /retained a callback/,
  );
  assert.throws(
    () => verifyReport({ ...valid, persistedRuntimeKeys: [...valid.persistedRuntimeKeys, "assetToken"] }),
    /runtime state entered persistence/,
  );
  console.log("Offscreen media playback verifier self-test passed.");
}

function syntheticReport() {
  const geometry = [
    { id: "placement-alpha", evidenceId: "evidence-alpha", left: 120, top: 150, scaleX: 0.82, scaleY: 0.82, angle: 0, zIndex: 1, posterTimestampUs: 500_000 },
    { id: "placement-beta", evidenceId: "evidence-beta", left: 770, top: 250, scaleX: 0.72, scaleY: 0.72, angle: 5, zIndex: 2, posterTimestampUs: 0 },
  ];
  return {
    schema: REQUIRED_SCHEMA,
    status: "passed",
    generatedAt: "2026-08-01T00:00:00.000Z",
    buildRevision: "0123456789abcdef0123456789abcdef01234567",
    fixture: {
      id: "native-decode-cfr60-issue-8",
      videoSha256: "b1b33aa040553a781420fcc2d56a0e5f2089c430f85b20deac657d1c9d935795",
      exactFrameSha256: "639aba824b4406b29ccfdd5d72f5aa14ab9e11776dccef3a40cc3fc33249ccfd",
    },
    environment: {
      userAgent: "Mozilla/5.0 Chrome/150.0.0.0",
      hardwareConcurrency: 8,
      viewport: { width: 1280, height: 720 },
      videoFrameCallbackSupported: true,
    },
    checks: REQUIRED_CHECKS.map((id) => ({ id, passed: true, detail: `${id} passed` })),
    renderedVideoFrames: 12,
    exactFrame: { timestampUs: 500_000, sampleIndex: 30 },
    cleanup: REQUIRED_CLEANUP.map((reason) => ({ reason, activeCallbacks: 0, liveSources: 0 })),
    geometryFingerprint: JSON.stringify(geometry),
    sourceUrlsExposed: false,
    persistedRuntimeKeys: [
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
