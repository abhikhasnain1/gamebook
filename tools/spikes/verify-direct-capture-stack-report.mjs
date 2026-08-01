import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

const MANIFEST_SCHEMA = "gamebook.direct-capture-stack-evidence.v1";
const EXPECTED_FAILURES = new Set([
  "initialization-failure",
  "encoder-failure",
  "gpu-failure",
  "storage-failure",
  "finalization-failure",
  "decoder-failure",
]);
const PRIVATE_MARKERS = [
  /[a-z]:\\/i,
  /\\users\\/i,
  /onedrive/i,
];

function parseArgs(args) {
  const options = { reports: [], scenario: undefined, manifest: undefined, selfTest: false };
  for (let index = 0; index < args.length; index += 1) {
    switch (args[index]) {
      case "--scenario":
        options.scenario = args[++index];
        assert.ok(options.scenario, "--scenario requires a value");
        break;
      case "--manifest":
        options.manifest = args[++index];
        assert.ok(options.manifest, "--manifest requires a path");
        break;
      case "--self-test":
        options.selfTest = true;
        break;
      default:
        options.reports.push(args[index]);
    }
  }
  return options;
}

function assertNoPrivateMarkers(value, label) {
  const serialized = JSON.stringify(value);
  for (const marker of PRIVATE_MARKERS) {
    assert.ok(!marker.test(serialized), `${label}: contains private marker ${marker}`);
  }
}

function verifyReport(report, expectedScenario, label = "report") {
  assert.equal(report.schemaVersion, 1, `${label}: schema version mismatch`);
  assert.equal(report.result, "passed", `${label}: result must be passed`);
  assert.match(report.applicationBuild ?? "", /^[A-Fa-f0-9]{7,64}$/, `${label}: build revision is invalid`);
  assert.match(report.runId ?? "", /^[A-Za-z0-9_-]{1,80}$/, `${label}: run ID is invalid`);
  assert.ok(report.startedAt?.startsWith("unix-ms-"), `${label}: redacted timestamp is required`);
  assert.equal(report.networkAccess, false, `${label}: network access must be false`);
  assert.equal(report.projectWrites, false, `${label}: project writes must be false`);
  assert.equal(report.audioCapture, false, `${label}: audio capture must be false`);
  assert.equal(report.microphoneCapture, false, `${label}: microphone capture must be false`);
  assertNoPrivateMarkers(report, label);
  if (expectedScenario) {
    assert.equal(report.scenario, expectedScenario, `${label}: scenario mismatch`);
  }

  if (report.scenario === "capture") {
    assert.equal(report.outcome, "finalized", `${label}: capture must finalize`);
    verifyRetainedMedia(report, label);
    assert.ok(report.submittedFrames > 0, `${label}: capture needs frames`);
    assert.ok(report.finalizationMs >= 0 && report.finalizationMs <= 5_000, `${label}: finalization exceeds five seconds`);
  } else if (report.scenario === "cancel") {
    assert.equal(report.outcome, "cancelled-clean", `${label}: cancellation outcome mismatch`);
    assert.equal(report.retainedMedia, false, `${label}: cancellation retained media`);
  } else if (EXPECTED_FAILURES.has(report.scenario)) {
    assert.equal(report.failureCleanup, "passed", `${label}: failure cleanup must pass`);
    assert.equal(report.retainedMedia, false, `${label}: failed operation retained media`);
    assert.ok(report.errorMessage?.trim(), `${label}: explicit failure message is required`);
  } else if (report.scenario === "source-close") {
    assert.equal(report.outcome, "source-closed-finalized-draft", `${label}: source-close outcome mismatch`);
    assert.ok(["graphics-capture-closed-event", "owned-source-exit-fallback"].includes(report.sourceCloseDetection), `${label}: source-close detection is missing`);
    verifyRetainedMedia(report, label);
  } else if (report.scenario === "device-loss") {
    assert.equal(report.outcome, "injected-device-loss-finalized-draft", `${label}: device-loss outcome mismatch`);
    assert.equal(report.deviceLossInjection, true, `${label}: device loss must be labeled injected`);
    assert.equal(report.projectReferenced, false, `${label}: draft cannot be project-referenced`);
    verifyRetainedMedia(report, label);
  } else if (report.scenario === "protected-content") {
    assert.equal(report.retainedMedia, false, `${label}: protected-content run retained media`);
    assert.equal(report.displayAffinity, "WDA_EXCLUDEFROMCAPTURE", `${label}: display affinity mismatch`);
    assert.equal(typeof report.protectedPixelsVisible, "boolean", `${label}: protected visibility result is required`);
  } else if (report.scenario === "hud-exclusion") {
    assert.equal(report.retainedMedia, false, `${label}: HUD run retained media`);
    assert.equal(report.displayAffinity, "WDA_EXCLUDEFROMCAPTURE", `${label}: display affinity mismatch`);
    assert.equal(typeof report.fallbackRequired, "boolean", `${label}: HUD fallback result is required`);
  } else if (["capture-interrupt", "promotion-interrupt"].includes(report.scenario)) {
    assert.equal(report.retainedMedia, true, `${label}: interruption staging media is required`);
    assert.equal(report.projectReferenced, false, `${label}: interruption media cannot be referenced`);
    assert.equal(report.automaticDeletion, false, `${label}: interruption media cannot be silently deleted`);
  } else if (report.scenario === "recovery-check") {
    assert.equal(report.outcome, "recovery-classified", `${label}: recovery outcome mismatch`);
    assert.ok(["recoverable-playable-draft", "quarantined-unplayable-media"].includes(report.classification), `${label}: recovery classification mismatch`);
    assert.equal(report.retainedMedia, true, `${label}: recovery must retain user-controlled media`);
    assert.equal(report.automaticDeletion, false, `${label}: recovery cannot silently delete media`);
    assert.equal(report.projectReferenced, false, `${label}: recovery media cannot be referenced`);
  } else {
    assert.fail(`${label}: unsupported scenario ${report.scenario}`);
  }
}

function verifyRetainedMedia(report, label) {
  assert.equal(report.retainedMedia, true, `${label}: retained media is required`);
  assert.ok(Number.isSafeInteger(report.outputBytes) && report.outputBytes > 0, `${label}: output must be non-empty`);
}

function verifyManifest(manifest, manifestPath) {
  const label = basename(manifestPath);
  assert.equal(manifest.schema, MANIFEST_SCHEMA, `${label}: manifest schema mismatch`);
  assert.equal(manifest.issue, 9, `${label}: issue must be 9`);
  assert.match(manifest.binarySha256 ?? "", /^[A-F0-9]{64}$/, `${label}: release binary SHA-256 is required`);
  assert.match(manifest.applicationBuild ?? "", /^[A-Fa-f0-9]{7,64}$/, `${label}: build revision is invalid`);
  assertNoPrivateMarkers({ ...manifest, reports: undefined }, label);
  const baseDir = dirname(resolve(manifestPath));
  const counts = new Map();
  for (const entry of manifest.reports ?? []) {
    const reportPath = resolve(baseDir, entry.path);
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    verifyReport(report, entry.scenario, `${label}:${entry.id}`);
    assert.equal(report.applicationBuild, manifest.applicationBuild, `${label}:${entry.id}: build mismatch`);
    counts.set(entry.role, (counts.get(entry.role) ?? 0) + 1);
    if (entry.artifact) {
      assert.match(entry.artifact.sha256 ?? "", /^[A-F0-9]{64}$/, `${label}:${entry.id}: artifact hash is invalid`);
      const bytes = readFileSync(resolve(baseDir, entry.artifact.path));
      assert.equal(bytes.length, report.outputBytes, `${label}:${entry.id}: artifact size mismatch`);
      assert.equal(createHash("sha256").update(bytes).digest("hex").toUpperCase(), entry.artifact.sha256, `${label}:${entry.id}: artifact hash mismatch`);
    }
  }
  for (const [role, minimum] of Object.entries(manifest.requiredRoleCounts ?? {})) {
    assert.ok((counts.get(role) ?? 0) >= minimum, `${label}: role ${role} requires at least ${minimum} reports`);
  }
}

function syntheticReport() {
  return {
    schemaVersion: 1,
    applicationBuild: "abcdef0",
    runId: "capture-01",
    scenario: "capture",
    startedAt: "unix-ms-1",
    result: "passed",
    outcome: "finalized",
    submittedFrames: 60,
    finalizationMs: 10,
    outputBytes: 100,
    retainedMedia: true,
    networkAccess: false,
    projectWrites: false,
    audioCapture: false,
    microphoneCapture: false,
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.selfTest) {
    verifyReport(syntheticReport());
    assert.throws(() => verifyReport({ ...syntheticReport(), networkAccess: true }));
    assert.throws(() => verifyReport({ ...syntheticReport(), runId: "../escape" }));
    console.log("Direct capture stack verifier self-test passed.");
    return;
  }
  if (options.manifest) {
    verifyManifest(JSON.parse(readFileSync(options.manifest, "utf8")), options.manifest);
    console.log(`Verified direct capture stack manifest ${options.manifest}`);
    return;
  }
  assert.ok(options.reports.length > 0, "At least one report path is required");
  for (const path of options.reports) {
    verifyReport(JSON.parse(readFileSync(path, "utf8")), options.scenario, basename(path));
    console.log(`Verified ${path}`);
  }
}

main();
