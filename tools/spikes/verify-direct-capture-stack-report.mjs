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
const REQUIRED_ROLE_COUNTS = Object.freeze({
  "1080p60-monitor": 2,
  "1440p60-monitor": 2,
  "selected-window": 2,
  "monitor-under-pointer": 2,
  "source-close": 2,
  "device-loss": 2,
  "protected-content": 2,
  "hud-exclusion": 2,
  cancellation: 2,
  "capture-interruption": 1,
  "capture-recovery": 1,
  "promotion-interruption": 1,
  "promotion-recovery": 1,
  "force-termination-recovery": 1,
  "initialization-failure": 1,
  "encoder-failure": 1,
  "decoder-failure": 1,
  "gpu-failure": 1,
  "storage-failure": 1,
  "finalization-failure": 1,
});
const REQUIRED_ENVIRONMENT_PROBES = new Set([
  "windows-os-memory",
  "cpu",
  "gpu-display-driver",
  "audio-devices",
  "storage-volumes",
  "webview2-runtime",
  "power-scheme",
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
  assert.equal(report.applicationVersion, "0.5.3", `${label}: package version mismatch`);
  assert.ok(["debug", "release"].includes(report.buildProfile), `${label}: build profile is invalid`);
  assert.match(report.runId ?? "", /^[A-Za-z0-9_-]{1,80}$/, `${label}: run ID is invalid`);
  assert.ok(Number.isSafeInteger(report.requestedDurationMs) && report.requestedDurationMs > 0, `${label}: requested duration is invalid`);
  assert.ok([30, 60].includes(report.requestedFrameRate), `${label}: requested frame rate is invalid`);
  assert.ok(report.startedAt?.startsWith("unix-ms-"), `${label}: redacted timestamp is required`);
  assert.equal(report.networkAccess, false, `${label}: network access must be false`);
  assert.equal(report.projectWrites, false, `${label}: project writes must be false`);
  assert.equal(report.audioCapture, false, `${label}: audio capture must be false`);
  assert.equal(report.microphoneCapture, false, `${label}: microphone capture must be false`);
  assert.ok(["monitor-under-pointer", "controlled-fixture-window", "fixture-monitor"].includes(report.target), `${label}: target is invalid`);
  verifyEnvironment(report, label);
  assertNoPrivateMarkers(report, label);
  if (expectedScenario) {
    assert.equal(report.scenario, expectedScenario, `${label}: scenario mismatch`);
  }

  if (report.scenario === "capture") {
    assert.equal(report.outcome, "finalized", `${label}: capture must finalize`);
    verifyRetainedMedia(report, label);
    assert.ok(report.submittedFrames > 0, `${label}: capture needs frames`);
    assert.ok(report.finalizationMs >= 0, `${label}: finalization time is invalid`);
    verifyFinalizedTimeline(report, label);
    assert.ok(["passed", "blocking-result"].includes(report.captureGate), `${label}: capture gate result is invalid`);
    const expectedGate = report.throughputPassed && report.durationWithinOneFrame && report.finalizationPassed
      ? "passed"
      : "blocking-result";
    assert.equal(report.captureGate, expectedGate, `${label}: capture gate result is inconsistent`);
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
    verifyFinalizedTimeline(report, label);
  } else if (report.scenario === "device-loss") {
    assert.equal(report.outcome, "injected-device-loss-finalized-draft", `${label}: device-loss outcome mismatch`);
    assert.equal(report.deviceLossInjection, true, `${label}: device loss must be labeled injected`);
    assert.equal(report.projectReferenced, false, `${label}: draft cannot be project-referenced`);
    verifyRetainedMedia(report, label);
    verifyFinalizedTimeline(report, label);
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
    if (report.scenario === "promotion-interrupt") {
      verifyFinalizedTimeline(report, label);
    }
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

function verifyEnvironment(report, label) {
  const build = report.environment?.applicationBuild;
  assert.equal(build?.name, "gamebook", `${label}: environment application name mismatch`);
  assert.equal(build?.version, report.applicationVersion, `${label}: environment version mismatch`);
  assert.equal(build?.sourceRevision, report.applicationBuild, `${label}: environment build mismatch`);
  assert.equal(build?.profile, report.buildProfile, `${label}: environment profile mismatch`);
  assert.equal(report.environment?.currentDirectory, ".", `${label}: current directory must be redacted`);
  assert.match(report.environment?.executable ?? "", /^[A-Za-z0-9_.-]+\.exe$/i, `${label}: executable must be a basename`);
  const probes = new Map((report.environment?.probes ?? []).map((probe) => [probe.name, probe]));
  for (const name of REQUIRED_ENVIRONMENT_PROBES) {
    const probe = probes.get(name);
    assert.ok(probe, `${label}: environment probe ${name} is missing`);
    assert.equal(probe.exitCode, 0, `${label}: environment probe ${name} failed`);
    assert.ok(probe.stdout?.trim(), `${label}: environment probe ${name} produced no output`);
  }
}

function verifyFinalizedTimeline(report, label) {
  assert.ok(Number.isSafeInteger(report.encodedSampleCount) && report.encodedSampleCount > 0, `${label}: encoded sample count is invalid`);
  assert.equal(report.encodedSampleCount, report.submittedFrames, `${label}: encoded sample count differs from submitted frames`);
  assert.ok(Number.isSafeInteger(report.outputDuration100ns) && report.outputDuration100ns > 0, `${label}: output duration is invalid`);
  assert.ok(Number.isSafeInteger(report.durationError100ns), `${label}: duration error is invalid`);
  assert.equal(report.durationError100ns, report.outputDuration100ns - report.requestedDurationMs * 10_000, `${label}: duration error is inconsistent`);
  assert.ok(Number.isSafeInteger(report.durationTolerance100ns) && report.durationTolerance100ns > 0, `${label}: duration tolerance is invalid`);
  assert.equal(report.durationWithinOneFrame, Math.abs(report.durationError100ns) <= report.durationTolerance100ns, `${label}: duration tolerance result is inconsistent`);
  assert.equal(report.backwardsEncodedTimestamps, 0, `${label}: encoded timeline moved backwards`);
  assert.equal(report.finalizationPassed, report.finalizationMs <= 5_000, `${label}: finalization result is inconsistent`);
  if (report.scenario === "capture") {
    const requestedFrames = report.requestedDurationMs / 1_000 * report.requestedFrameRate;
    const minimumFrames = Math.ceil(requestedFrames * 0.95);
    assert.equal(report.minimumThroughputFrames, minimumFrames, `${label}: throughput threshold is inconsistent`);
    assert.equal(report.throughputPassed, report.submittedFrames >= minimumFrames, `${label}: throughput result is inconsistent`);
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
  assert.ok(manifest.binaryPath?.trim(), `${label}: release binary path is required`);
  assert.match(manifest.applicationBuild ?? "", /^[A-Fa-f0-9]{7,64}$/, `${label}: build revision is invalid`);
  assertNoPrivateMarkers({ ...manifest, reports: undefined }, label);
  const baseDir = dirname(resolve(manifestPath));
  const binaryBytes = readFileSync(resolve(baseDir, manifest.binaryPath));
  assert.equal(createHash("sha256").update(binaryBytes).digest("hex").toUpperCase(), manifest.binarySha256, `${label}: release binary hash mismatch`);
  assert.deepEqual(manifest.requiredRoleCounts, REQUIRED_ROLE_COUNTS, `${label}: required role contract mismatch`);
  const counts = new Map();
  for (const entry of manifest.reports ?? []) {
    const reportPath = resolve(baseDir, entry.path);
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    verifyReport(report, entry.scenario, `${label}:${entry.id}`);
    assert.equal(report.applicationBuild, manifest.applicationBuild, `${label}:${entry.id}: build mismatch`);
    assert.equal(report.buildProfile, "release", `${label}:${entry.id}: closeout report must use release build`);
    verifyRole(entry.role, report, `${label}:${entry.id}`);
    counts.set(entry.role, (counts.get(entry.role) ?? 0) + 1);
    if (report.retainedMedia) {
      assert.ok(entry.artifact, `${label}:${entry.id}: retained media requires an artifact hash`);
    }
    if (entry.artifact) {
      assert.match(entry.artifact.sha256 ?? "", /^[A-F0-9]{64}$/, `${label}:${entry.id}: artifact hash is invalid`);
      const bytes = readFileSync(resolve(baseDir, entry.artifact.path));
      const expectedBytes = report.outputBytes ?? entry.artifact.bytes;
      assert.ok(Number.isSafeInteger(expectedBytes) && expectedBytes > 0, `${label}:${entry.id}: artifact byte count is required`);
      assert.equal(bytes.length, expectedBytes, `${label}:${entry.id}: artifact size mismatch`);
      assert.equal(createHash("sha256").update(bytes).digest("hex").toUpperCase(), entry.artifact.sha256, `${label}:${entry.id}: artifact hash mismatch`);
    }
  }
  for (const [role, minimum] of Object.entries(REQUIRED_ROLE_COUNTS)) {
    assert.ok((counts.get(role) ?? 0) >= minimum, `${label}: role ${role} requires at least ${minimum} reports`);
  }
}

function verifyRole(role, report, label) {
  assert.ok(Object.hasOwn(REQUIRED_ROLE_COUNTS, role), `${label}: unsupported evidence role ${role}`);
  const expectedScenario = {
    "source-close": "source-close",
    "monitor-under-pointer": "cancel",
    "device-loss": "device-loss",
    "protected-content": "protected-content",
    "hud-exclusion": "hud-exclusion",
    cancellation: "cancel",
    "capture-interruption": "capture-interrupt",
    "promotion-interruption": "promotion-interrupt",
    "initialization-failure": "initialization-failure",
    "encoder-failure": "encoder-failure",
    "decoder-failure": "decoder-failure",
    "gpu-failure": "gpu-failure",
    "storage-failure": "storage-failure",
    "finalization-failure": "finalization-failure",
  }[role];
  if (expectedScenario) {
    assert.equal(report.scenario, expectedScenario, `${label}: role scenario mismatch`);
  }
  if (["1080p60-monitor", "1440p60-monitor", "selected-window"].includes(role)) {
    assert.equal(report.scenario, "capture", `${label}: performance role requires capture scenario`);
    assert.equal(report.requestedDurationMs, 30_000, `${label}: performance role requires 30 seconds`);
    assert.equal(report.requestedFrameRate, 60, `${label}: performance role requires 60 FPS`);
  }
  if (role === "1080p60-monitor") {
    assert.equal(report.target, "fixture-monitor", `${label}: 1080p role requires animated monitor target`);
    assert.equal(report.sourceWidth, 1920, `${label}: 1080p role width mismatch`);
    assert.equal(report.sourceHeight, 1080, `${label}: 1080p role height mismatch`);
  } else if (role === "1440p60-monitor") {
    assert.equal(report.target, "fixture-monitor", `${label}: 1440p role requires animated monitor target`);
    assert.ok(report.sourceWidth >= 2560, `${label}: 1440p role width is too small`);
    assert.equal(report.sourceHeight, 1440, `${label}: 1440p role height mismatch`);
  } else if (role === "selected-window") {
    assert.equal(report.target, "controlled-fixture-window", `${label}: selected-window role target mismatch`);
  } else if (role === "monitor-under-pointer") {
    assert.equal(report.target, "monitor-under-pointer", `${label}: monitor-under-pointer role target mismatch`);
  } else if (role === "capture-recovery") {
    assert.equal(report.scenario, "recovery-check", `${label}: recovery role scenario mismatch`);
    assert.equal(report.journalState, "capture-interrupted", `${label}: capture recovery journal state mismatch`);
  } else if (role === "promotion-recovery") {
    assert.equal(report.scenario, "recovery-check", `${label}: recovery role scenario mismatch`);
    assert.equal(report.journalState, "finalized-unpromoted", `${label}: promotion recovery journal state mismatch`);
  } else if (role === "force-termination-recovery") {
    assert.equal(report.scenario, "recovery-check", `${label}: recovery role scenario mismatch`);
    assert.equal(report.journalState, "capture-active", `${label}: force-termination journal state mismatch`);
  }
}

function syntheticReport() {
  return {
    schemaVersion: 1,
    applicationBuild: "abcdef0",
    applicationVersion: "0.5.3",
    buildProfile: "release",
    runId: "capture-01",
    scenario: "capture",
    target: "fixture-monitor",
    requestedDurationMs: 1_000,
    requestedFrameRate: 60,
    startedAt: "unix-ms-1",
    result: "passed",
    outcome: "finalized",
    submittedFrames: 60,
    finalizationMs: 10,
    encodedSampleCount: 60,
    outputDuration100ns: 10_000_000,
    durationError100ns: 0,
    durationTolerance100ns: 166_666,
    durationWithinOneFrame: true,
    backwardsEncodedTimestamps: 0,
    minimumThroughputFrames: 57,
    throughputPassed: true,
    finalizationPassed: true,
    captureGate: "passed",
    outputBytes: 100,
    retainedMedia: true,
    networkAccess: false,
    projectWrites: false,
    audioCapture: false,
    microphoneCapture: false,
    environment: {
      applicationBuild: {
        name: "gamebook",
        version: "0.5.3",
        sourceRevision: "abcdef0",
        profile: "release",
      },
      executable: "direct_capture_stack_spike.exe",
      currentDirectory: ".",
      probes: [...REQUIRED_ENVIRONMENT_PROBES].map((name) => ({ name, exitCode: 0, stdout: "ok" })),
    },
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
