import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

const REQUIRED_SCHEMA = "gamebook.native-capture-spike.v1";
const REQUIRED_CAPABILITY_SCHEMA = "gamebook.native-encoder-capability.v1";
const REQUIRED_MANIFEST_SCHEMA = "gamebook.native-capture-evidence-set.v1";
const ADOPT_DECISION = "adopt-windows-capture";
const FALLBACK_DECISION = "direct-windows-api-fallback";
const REQUIRED_PROBES = new Set([
  "windows-os-memory",
  "cpu",
  "gpu-display-driver",
  "audio-devices",
  "storage-volumes",
  "webview2-runtime",
  "power-scheme",
]);
const REQUIRED_REPORT_ROLES = new Map([
  ["monitor-1080p60", { scenario: "encode", minimumCount: 2 }],
  ["monitor-1440p60", { scenario: "encode", minimumCount: 2 }],
  ["selected-window", { scenario: "encode", minimumCount: 2 }],
  ["cancellation", { scenario: "cancel", minimumCount: 2 }],
  ["source-close", { scenario: "source-close", minimumCount: 2 }],
  ["encoder-failure", { scenario: "encoder-failure", minimumCount: 1 }],
]);
const REQUIRED_FALLBACK_REPORT_ROLES = new Map(
  [...REQUIRED_REPORT_ROLES].filter(([role]) => role !== "source-close"),
);
const REQUIRED_FALLBACK_FAILURE_ROLES = new Set([
  "monitor-1080p60",
  "monitor-1440p60",
  "selected-window",
]);
const REQUIRED_FALLBACK_FOLLOW_UP_GATES = new Set([
  "source-close",
  "device-loss",
  "protected-content",
  "hud-exclusion-fallback",
]);
const REQUIRED_MANUAL_EVIDENCE = new Map([
  ["device-loss", 2],
  ["protected-content", 2],
  ["hud-exclusion-fallback", 1],
  ["accessibility-contract", 1],
]);
const REQUIRED_CAPABILITY_PROFILES = [
  { width: 3840, height: 2160, frameRate: 60 },
  { width: 3840, height: 2160, frameRate: 30 },
  { width: 2560, height: 1440, frameRate: 60 },
  { width: 1920, height: 1080, frameRate: 60 },
];
const PATH_MARKERS = [
  /[A-Z]:\\\\Users\\\\/i,
  /OneDrive[\\\\/]/i,
  /Program Files[\\\\/]/i,
  /SilentUninstall/i,
  /"location"\s*:/i,
];

function parseArgs(argv) {
  const options = {
    durationToleranceFrames: 1,
    maxFinalizationMs: 5000,
    minOutputBytes: 1,
    minSubmittedFrames: 1,
    minSourceWidth: 0,
    minSourceHeight: 0,
    manifest: undefined,
    reports: [],
    scenario: undefined,
    selfTest: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--self-test":
        options.selfTest = true;
        break;
      case "--manifest":
        options.manifest = readValue(argv, ++index, arg);
        break;
      case "--scenario":
        options.scenario = readValue(argv, ++index, arg);
        break;
      case "--min-source-width":
        options.minSourceWidth = Number(readValue(argv, ++index, arg));
        break;
      case "--min-source-height":
        options.minSourceHeight = Number(readValue(argv, ++index, arg));
        break;
      case "--duration-tolerance-frames":
        options.durationToleranceFrames = Number(readValue(argv, ++index, arg));
        break;
      case "--max-finalization-ms":
        options.maxFinalizationMs = Number(readValue(argv, ++index, arg));
        break;
      case "--min-output-bytes":
        options.minOutputBytes = Number(readValue(argv, ++index, arg));
        break;
      case "--min-submitted-frames":
        options.minSubmittedFrames = Number(readValue(argv, ++index, arg));
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
        break;
      default:
        if (arg.startsWith("--")) {
          throw new Error(`Unknown option: ${arg}`);
        }
        options.reports.push(arg);
    }
  }

  return options;
}

function readValue(argv, index, name) {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function printHelp() {
  console.log(`Native capture report verifier

Usage:
  npm.cmd run native-capture:verify -- <report.json> --scenario encode --min-source-width 1920 --min-source-height 1080
  npm.cmd run native-capture:verify -- <report.json> --scenario cancel
  npm.cmd run native-capture:verify -- <report.json> --scenario source-close
  npm.cmd run native-capture:verify -- <report.json> --scenario encoder-failure
  npm.cmd run native-capture:verify -- <encoder-capability.json>
  npm.cmd run native-capture:verify -- --manifest <evidence-set.json>

Options:
  --duration-tolerance-frames N   Finalized output-duration tolerance. Default: 1 frame
  --max-finalization-ms N         Maximum finalization time for encode reports. Default: 5000
  --min-output-bytes N            Minimum MP4 byte count for encode reports. Default: 1
  --min-submitted-frames N        Minimum submitted frames for encode reports. Default: 1
  --manifest PATH                 Verify an adopt-or-fallback evidence set and every report.
  --self-test                     Run synthetic verifier tests.`);
}

function verifyReport(report, options, label = "report") {
  assert.equal(report.schema, REQUIRED_SCHEMA, `${label}: schema mismatch`);
  assert.ok(report.startedAt, `${label}: missing startedAt`);
  assert.ok(report.completedAt, `${label}: missing completedAt`);
  assert.ok(Array.isArray(report.command), `${label}: command must be an array`);
  assert.ok(report.command.length > 0, `${label}: command is empty`);
  assert.ok(
    ["monitor", "window", "unspecified"].includes(report.declaredTargetKind),
    `${label}: invalid declaredTargetKind`,
  );
  verifyTargetLabel(report, label);
  assert.match(report.outputPath, /^artifact(?::[^\\/]+)?$/, `${label}: outputPath is not redacted`);
  assertNoPathMarkers(report, label);

  if (options.scenario) {
    assert.equal(report.scenario, options.scenario, `${label}: scenario mismatch`);
  }
  assert.ok(report.sourceWidth >= options.minSourceWidth, `${label}: source width below threshold`);
  assert.ok(report.sourceHeight >= options.minSourceHeight, `${label}: source height below threshold`);
  assert.equal(report.requestedWidth % 2, 0, `${label}: requested width must be even`);
  assert.equal(report.requestedHeight % 2, 0, `${label}: requested height must be even`);
  assert.ok(report.estimatedFrameDurationMs > 0, `${label}: missing frame duration`);
  assert.ok(
    Number.isInteger(report.estimatedDroppedFrames) && report.estimatedDroppedFrames >= 0,
    `${label}: invalid estimatedDroppedFrames`,
  );
  verifyEnvironment(report, label);

  switch (report.scenario) {
    case "encode":
      verifyEncodeReport(report, options, label);
      break;
    case "cancel":
      verifyCancelReport(report, label);
      break;
    case "source-close":
      verifySourceCloseReport(report, label);
      break;
    case "encoder-failure":
      verifyEncoderFailureReport(report, label);
      break;
    default:
      throw new Error(`${label}: unsupported scenario ${report.scenario}`);
  }
}

function verifyEncodeReport(report, options, label) {
  assert.equal(report.result, "completed", `${label}: encode result must be completed`);
  assert.equal(report.cancelled, false, `${label}: encode must not be marked cancelled`);
  assert.ok(report.outputBytes >= options.minOutputBytes, `${label}: output too small`);
  assert.ok(
    report.submittedFrames >= options.minSubmittedFrames,
    `${label}: submitted frame count too low`,
  );
  assert.equal(report.backwardsTimestamps, 0, `${label}: backwards timestamps found`);
  assert.ok(report.finalizationMs !== null, `${label}: missing finalizationMs`);
  assert.ok(
    report.finalizationMs <= options.maxFinalizationMs,
    `${label}: finalization exceeded ${options.maxFinalizationMs}ms`,
  );
  assert.ok(
    report.captureTimestampSpanMs !== null,
    `${label}: missing captureTimestampSpanMs`,
  );
  assert.ok(report.outputDurationMs !== null, `${label}: missing outputDurationMs`);
  assert.ok(report.durationErrorMs !== null, `${label}: missing durationErrorMs`);

  const toleranceMs = report.estimatedFrameDurationMs * options.durationToleranceFrames;
  assert.ok(
    Math.abs(report.durationErrorMs) <= toleranceMs,
    `${label}: duration error ${report.durationErrorMs}ms exceeds ${toleranceMs}ms`,
  );
}

function verifyCancelReport(report, label) {
  assert.equal(report.result, "cancelled", `${label}: cancel result must be cancelled`);
  assert.equal(report.cancelled, true, `${label}: cancel report must be marked cancelled`);
  assert.equal(
    report.cleanedPartialOutput,
    true,
    `${label}: cancellation must clean partial output`,
  );
  assert.ok(!report.outputBytes || report.outputBytes === 0, `${label}: cancelled output remains`);
  assert.equal(report.outputDurationMs, null, `${label}: cancelled output has a duration`);
}

function verifyEncoderFailureReport(report, label) {
  assert.equal(report.result, "startup-failed", `${label}: failure result must be startup-failed`);
  assert.equal(report.submittedFrames, 0, `${label}: startup failure submitted frames`);
  assert.ok(report.errorMessage, `${label}: missing startup failure message`);
  assert.ok(!report.outputBytes || report.outputBytes === 0, `${label}: failure output remains`);
  assert.equal(report.outputDurationMs, null, `${label}: failed output has a duration`);
}

function verifySourceCloseReport(report, label) {
  assert.equal(report.result, "source-closed", `${label}: source-close result must be source-closed`);
  assert.equal(report.cancelled, false, `${label}: source close is not user cancellation`);
  assert.equal(
    report.cleanedPartialOutput,
    true,
    `${label}: source close must leave no partial output`,
  );
  assert.ok(report.submittedFrames > 0, `${label}: source closed before any frame was submitted`);
  assert.ok(!report.outputBytes || report.outputBytes === 0, `${label}: source-close output remains`);
  assert.equal(report.outputDurationMs, null, `${label}: source-close output has a duration`);
}

function verifyEnvironment(report, label) {
  assert.ok(report.environment, `${label}: missing environment`);
  verifyApplicationBuild(report.environment.applicationBuild, label);
  assert.equal(report.environment.exe, "native_capture_spike.exe", `${label}: exe is not redacted`);
  assert.equal(report.environment.currentDir, ".", `${label}: currentDir is not redacted`);
  assert.equal(
    report.environment.windowsCaptureVersion,
    "2.0.0",
    `${label}: unexpected windows-capture version`,
  );

  const probes = new Set((report.environment.probes ?? []).map((probe) => probe.name));
  for (const required of REQUIRED_PROBES) {
    assert.ok(probes.has(required), `${label}: missing environment probe ${required}`);
  }
}

function verifyCapabilityReport(report, label = "capability report") {
  assert.equal(report.schema, REQUIRED_CAPABILITY_SCHEMA, `${label}: schema mismatch`);
  assert.ok(report.startedAt, `${label}: missing startedAt`);
  assert.ok(report.completedAt, `${label}: missing completedAt`);
  assert.ok(Array.isArray(report.command) && report.command.length > 0, `${label}: command is empty`);
  assert.equal(report.codec, "h264", `${label}: codec must be h264`);
  assert.equal(
    report.capabilityScope,
    "synthetic-two-frame-initialization-and-finalization",
    `${label}: capability scope mismatch`,
  );
  assert.equal(report.captureStarted, false, `${label}: capability probe must not start capture`);
  assert.equal(report.syntheticFramesOnly, true, `${label}: capability probe must be synthetic`);
  assert.ok(Array.isArray(report.attempts), `${label}: attempts must be an array`);
  assert.equal(
    report.attempts.length,
    REQUIRED_CAPABILITY_PROFILES.length,
    `${label}: fallback ladder is incomplete`,
  );
  verifyEnvironment(report, label);
  assertNoPathMarkers(report, label);

  for (let index = 0; index < REQUIRED_CAPABILITY_PROFILES.length; index += 1) {
    const attempt = report.attempts[index];
    const expected = REQUIRED_CAPABILITY_PROFILES[index];
    assert.deepEqual(attempt.profile, expected, `${label}: profile ${index} is out of order`);
    assert.match(
      attempt.outputPath,
      /^artifact:[^\\/]+\.mp4$/,
      `${label}: attempt ${index} outputPath is not redacted`,
    );
    assert.ok(
      Number.isInteger(attempt.initializationMs) && attempt.initializationMs >= 0,
      `${label}: attempt ${index} missing initializationMs`,
    );
    assert.equal(
      attempt.frameBytes,
      expected.width * expected.height * 4,
      `${label}: attempt ${index} frameBytes mismatch`,
    );
    assert.ok(
      Number.isInteger(attempt.framesSubmitted) &&
        attempt.framesSubmitted >= 0 &&
        attempt.framesSubmitted <= 2,
      `${label}: attempt ${index} invalid framesSubmitted`,
    );
    assert.equal(attempt.cleanedOutput, true, `${label}: attempt ${index} output was not cleaned`);
    assert.ok(
      ["supported", "unsupported"].includes(attempt.result),
      `${label}: attempt ${index} has an invalid result`,
    );

    if (attempt.result === "supported") {
      assert.equal(attempt.framesSubmitted, 2, `${label}: supported attempt needs two frames`);
      assert.ok(attempt.outputBytes > 0, `${label}: supported attempt has no MP4 bytes`);
      assert.ok(attempt.finalizationMs !== null, `${label}: supported attempt was not finalized`);
      assert.equal(attempt.errorMessage, null, `${label}: supported attempt has an error`);
    } else {
      assert.ok(attempt.errorMessage, `${label}: unsupported attempt needs an error`);
    }
  }

  const selected = report.attempts.find((attempt) => attempt.result === "supported")?.profile ?? null;
  assert.deepEqual(report.selectedProfile, selected, `${label}: selectedProfile is not first supported`);
  const fourK60Supported = report.attempts[0].result === "supported";
  assert.equal(
    report.fourK60Supported,
    fourK60Supported,
    `${label}: fourK60Supported does not match the 4K60 attempt`,
  );
  assert.equal(
    report.fallbackRequired,
    !fourK60Supported,
    `${label}: fallbackRequired does not match the 4K60 attempt`,
  );
  assert.equal(
    report.result,
    selected ? "supported" : "unsupported",
    `${label}: overall result does not match the fallback ladder`,
  );
}

function verifyApplicationBuild(build, label) {
  assert.ok(build, `${label}: missing applicationBuild`);
  assert.equal(build.name, "gamebook", `${label}: unexpected applicationBuild name`);
  assert.match(
    build.version,
    /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/,
    `${label}: invalid applicationBuild version`,
  );
  assert.match(
    build.sourceRevision,
    /^[0-9a-f]{7,64}$/,
    `${label}: invalid applicationBuild sourceRevision`,
  );
  assert.ok(
    ["debug", "release"].includes(build.profile),
    `${label}: invalid applicationBuild profile`,
  );
}

function verifyTargetLabel(report, label) {
  const expected = {
    monitor: /^(primary-monitor|monitor-index-\d+|picker-selected-monitor)$/,
    window: /^(picker-selected-window|controlled-fixture-window)$/,
    unspecified: /^picker-selected-unspecified$/,
  }[report.declaredTargetKind];
  assert.match(report.targetLabel, expected, `${label}: targetLabel is not anonymous`);
}

function assertNoPathMarkers(report, label) {
  const serialized = JSON.stringify(report);
  for (const marker of PATH_MARKERS) {
    assert.ok(!marker.test(serialized), `${label}: unredacted path marker ${marker}`);
  }
}

function verifyManifest(manifest, manifestPath) {
  const label = basename(manifestPath);
  assert.equal(manifest.schema, REQUIRED_MANIFEST_SCHEMA, `${label}: manifest schema mismatch`);
  assert.equal(manifest.issue, 6, `${label}: manifest must target issue 6`);
  assert.ok(
    [ADOPT_DECISION, FALLBACK_DECISION].includes(manifest.decision),
    `${label}: decision must adopt windows-capture or select the direct Windows API fallback`,
  );
  assert.ok(
    manifest.decisionRationale && manifest.decisionRationale.trim(),
    `${label}: decisionRationale is required`,
  );
  verifyApplicationBuild(manifest.applicationBuild, label);
  assertNoPathMarkers(manifest, label);
  assert.ok(Array.isArray(manifest.reports), `${label}: reports must be an array`);
  assert.ok(manifest.reports.length > 0, `${label}: reports cannot be empty`);
  assert.ok(
    Array.isArray(manifest.capabilityReports),
    `${label}: capabilityReports must be an array`,
  );
  assert.ok(
    manifest.capabilityReports.length > 0,
    `${label}: capabilityReports cannot be empty`,
  );

  const baseDir = dirname(resolve(manifestPath));
  const seenIds = new Set();
  const seenReportPaths = new Set();
  const seenRunFingerprints = new Set();
  const roleCounts = new Map();
  const passingRoleCounts = new Map();
  const failureRoleCounts = new Map();
  for (const entry of manifest.reports) {
    assert.ok(entry.id, `${label}: report entry missing id`);
    assert.ok(!seenIds.has(entry.id), `${label}: duplicate report id ${entry.id}`);
    seenIds.add(entry.id);
    assert.ok(entry.role, `${label}: report ${entry.id} missing role`);
    assert.ok(
      REQUIRED_REPORT_ROLES.has(entry.role),
      `${label}: report ${entry.id} has unsupported role ${entry.role}`,
    );
    assert.ok(entry.path, `${label}: report ${entry.id} missing path`);
    const reportPath = resolve(baseDir, entry.path);
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    registerUniqueReportEvidence(
      entry,
      reportPath,
      report,
      seenReportPaths,
      seenRunFingerprints,
      label,
    );
    const expectedOutcome = entry.expectedOutcome ?? "pass";
    assert.ok(
      ["pass", "capture-gate-failure"].includes(expectedOutcome),
      `${label}:${entry.id}: invalid expectedOutcome`,
    );
    assert.ok(
      expectedOutcome === "pass" || entry.scenario === "encode",
      `${label}:${entry.id}: only encode reports may expect a capture-gate failure`,
    );
    const acceptsFailedCaptureGates = expectedOutcome === "capture-gate-failure";
    verifyReport(
      report,
      {
        ...defaultOptions(),
        scenario: entry.scenario,
        minSourceWidth: entry.minSourceWidth ?? 0,
        minSourceHeight: entry.minSourceHeight ?? 0,
        durationToleranceFrames: acceptsFailedCaptureGates
          ? Number.POSITIVE_INFINITY
          : (entry.durationToleranceFrames ?? 1),
        maxFinalizationMs: acceptsFailedCaptureGates
          ? Number.POSITIVE_INFINITY
          : (entry.maxFinalizationMs ?? 5000),
        minOutputBytes: entry.minOutputBytes ?? 1,
        minSubmittedFrames: entry.minSubmittedFrames ?? 1,
      },
      `${label}:${entry.id}`,
    );
    assert.deepEqual(
      report.environment.applicationBuild,
      manifest.applicationBuild,
      `${label}:${entry.id}: applicationBuild does not match the evidence set`,
    );
    verifyReportRole(entry, report, `${label}:${entry.id}`, expectedOutcome);
    if (acceptsFailedCaptureGates) {
      verifyCaptureGateFailure(report, `${label}:${entry.id}`);
      failureRoleCounts.set(entry.role, (failureRoleCounts.get(entry.role) ?? 0) + 1);
    } else {
      passingRoleCounts.set(entry.role, (passingRoleCounts.get(entry.role) ?? 0) + 1);
    }
    roleCounts.set(entry.role, (roleCounts.get(entry.role) ?? 0) + 1);
  }

  for (const entry of manifest.capabilityReports) {
    assert.ok(entry.id, `${label}: capability report entry missing id`);
    assert.ok(!seenIds.has(entry.id), `${label}: duplicate evidence id ${entry.id}`);
    seenIds.add(entry.id);
    assert.ok(entry.path, `${label}: capability report ${entry.id} missing path`);
    const reportPath = resolve(baseDir, entry.path);
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    registerUniqueReportEvidence(
      entry,
      reportPath,
      report,
      seenReportPaths,
      seenRunFingerprints,
      label,
    );
    verifyCapabilityReport(report, `${label}:${entry.id}`);
    assert.deepEqual(
      report.environment.applicationBuild,
      manifest.applicationBuild,
      `${label}:${entry.id}: applicationBuild does not match the evidence set`,
    );
  }

  if (manifest.decision === ADOPT_DECISION) {
    assert.equal(
      failureRoleCounts.size,
      0,
      `${label}: adoption evidence cannot declare a capture-gate failure`,
    );
    assertRequiredReportRoles(passingRoleCounts, label, REQUIRED_REPORT_ROLES);
    assertRequiredManualEvidence(manifest.manualEvidence ?? [], label);
  } else {
    assertRequiredReportRoles(roleCounts, label, REQUIRED_FALLBACK_REPORT_ROLES);
    for (const role of REQUIRED_FALLBACK_FAILURE_ROLES) {
      assert.ok(
        (failureRoleCounts.get(role) ?? 0) > 0,
        `${label}: fallback decision requires capture-gate failure evidence for ${role}`,
      );
    }
    verifyFallbackFollowUp(manifest.fallbackFollowUp, label);
  }
}

function registerUniqueReportEvidence(
  entry,
  reportPath,
  report,
  seenReportPaths,
  seenRunFingerprints,
  label,
) {
  const normalizedPath = reportPath.toLowerCase();
  assert.ok(!seenReportPaths.has(normalizedPath), `${label}: report path reused by ${entry.id}`);
  seenReportPaths.add(normalizedPath);

  const runFingerprint = JSON.stringify([report.startedAt, report.completedAt, report.command]);
  assert.ok(
    !seenRunFingerprints.has(runFingerprint),
    `${label}: duplicate run evidence ${entry.id}`,
  );
  seenRunFingerprints.add(runFingerprint);
}

function verifyReportRole(entry, report, label, expectedOutcome = "pass") {
  const requirement = REQUIRED_REPORT_ROLES.get(entry.role);
  assert.equal(entry.scenario, requirement.scenario, `${label}: role scenario mismatch`);
  const requirePassingCaptureGates = expectedOutcome === "pass";

  switch (entry.role) {
    case "monitor-1080p60":
      verifyTimed60FpsCapture(report, label, requirePassingCaptureGates);
      verifyMonitorTarget(report, label);
      assert.ok(report.sourceWidth >= 1920, `${label}: 1080p source width below 1920`);
      assert.equal(report.sourceHeight, 1080, `${label}: 1080p source height mismatch`);
      break;
    case "monitor-1440p60":
      verifyTimed60FpsCapture(report, label, requirePassingCaptureGates);
      verifyMonitorTarget(report, label);
      assert.ok(report.sourceWidth >= 2560, `${label}: 1440p source width below 2560`);
      assert.equal(report.sourceHeight, 1440, `${label}: 1440p source height mismatch`);
      break;
    case "selected-window":
      verifyTimed60FpsCapture(report, label, requirePassingCaptureGates);
      verifyDeclaredWindowTarget(report, label);
      break;
    case "source-close":
      verifyDeclaredWindowTarget(report, label);
      break;
    case "cancellation":
    case "encoder-failure":
      break;
    default:
      throw new Error(`${label}: unsupported report role ${entry.role}`);
  }
}

function verifyTimed60FpsCapture(report, label, requirePassingCaptureGates = true) {
  assert.equal(report.requestedFrameRate, 60, `${label}: capture must request 60 FPS`);
  assert.equal(report.requestedDurationMs, 30000, `${label}: capture must request 30 seconds`);
  if (!requirePassingCaptureGates) {
    return;
  }
  const expectedFrames = report.requestedDurationMs / report.estimatedFrameDurationMs;
  const minimumFrames = Math.floor(expectedFrames * 0.95);
  assert.ok(
    report.submittedFrames >= minimumFrames,
    `${label}: submitted ${report.submittedFrames} frames; at least ${minimumFrames} required`,
  );
}

function captureGateFailures(report) {
  const failures = [];
  const expectedFrames = report.requestedDurationMs / report.estimatedFrameDurationMs;
  const minimumFrames = Math.floor(expectedFrames * 0.95);
  if (report.submittedFrames < minimumFrames) {
    failures.push("submitted-frame-throughput");
  }
  if (report.finalizationMs === null || report.finalizationMs > 5000) {
    failures.push("finalization-time");
  }
  if (
    report.durationErrorMs === null ||
    Math.abs(report.durationErrorMs) > report.estimatedFrameDurationMs
  ) {
    failures.push("output-duration");
  }
  return failures;
}

function verifyCaptureGateFailure(report, label) {
  assert.equal(report.scenario, "encode", `${label}: capture-gate failure must be an encode run`);
  assert.ok(
    captureGateFailures(report).length > 0,
    `${label}: report passed every capture gate but was declared as a failure`,
  );
}

function verifyMonitorTarget(report, label) {
  assert.equal(report.declaredTargetKind, "monitor", `${label}: target must be a monitor`);
  assert.match(
    report.targetLabel,
    /^(primary-monitor|monitor-index-\d+)$/,
    `${label}: target label is not a direct monitor target`,
  );
}

function verifyDeclaredWindowTarget(report, label) {
  assert.equal(report.declaredTargetKind, "window", `${label}: target must be declared as a window`);
  assert.match(
    report.targetLabel,
    /^(picker-selected-window|controlled-fixture-window)$/,
    `${label}: target must use the system picker or the title-exact controlled fixture`,
  );
}

function assertRequiredReportRoles(roleCounts, label, requirements = REQUIRED_REPORT_ROLES) {
  for (const [role, requirement] of requirements) {
    const actual = roleCounts.get(role) ?? 0;
    assert.ok(
      actual >= requirement.minimumCount,
      `${label}: report role ${role} requires ${requirement.minimumCount} run(s); found ${actual}`,
    );
  }
}

function verifyFallbackFollowUp(followUp, label) {
  assert.ok(followUp, `${label}: fallbackFollowUp is required`);
  assert.equal(followUp.issue, 9, `${label}: fallback follow-up must be issue 9`);
  assert.ok(Array.isArray(followUp.gates), `${label}: fallbackFollowUp.gates must be an array`);
  assert.deepEqual(
    new Set(followUp.gates),
    REQUIRED_FALLBACK_FOLLOW_UP_GATES,
    `${label}: fallback follow-up gates are incomplete`,
  );
  assert.ok(
    followUp.notes && followUp.notes.trim(),
    `${label}: fallbackFollowUp.notes is required`,
  );
}

function assertRequiredManualEvidence(manualEvidence, label) {
  assert.ok(Array.isArray(manualEvidence), `${label}: manualEvidence must be an array`);
  const entries = new Map();
  for (const entry of manualEvidence) {
    assert.ok(entry.id, `${label}: manual evidence entry missing id`);
    assert.ok(!entries.has(entry.id), `${label}: duplicate manual evidence ${entry.id}`);
    entries.set(entry.id, entry);
  }

  for (const [id, minimumAttempts] of REQUIRED_MANUAL_EVIDENCE) {
    assert.ok(entries.has(id), `${label}: missing manual evidence ${id}`);
    const entry = entries.get(id);
    assert.equal(entry.status, "passed", `${label}: manual evidence ${id} is not complete`);
    assert.ok(
      Number.isInteger(entry.attempts) && entry.attempts >= minimumAttempts,
      `${label}: manual evidence ${id} requires at least ${minimumAttempts} attempt(s)`,
    );
    assert.ok(entry.notes && entry.notes.trim(), `${label}: manual evidence ${id} missing notes`);
  }
}

function syntheticBase(overrides = {}) {
  return {
    schema: REQUIRED_SCHEMA,
    startedAt: "unix-ms-1",
    completedAt: "unix-ms-2",
    command: ["native_capture_spike.exe", "--scenario", "encode"],
    scenario: "encode",
    declaredTargetKind: "monitor",
    targetLabel: "primary-monitor",
    sourceWidth: 1920,
    sourceHeight: 1080,
    requestedWidth: 1920,
    requestedHeight: 1080,
    requestedFrameRate: 60,
    requestedDurationMs: 30000,
    outputPath: "artifact:synthetic.mp4",
    outputBytes: 1024,
    submittedFrames: 1800,
    estimatedFrameDurationMs: 1000 / 60,
    firstTimestampTicks: 0,
    lastTimestampTicks: 300000000,
    captureTimestampSpanMs: 29983.333,
    outputDurationMs: 30000,
    durationErrorMs: 0,
    largestFrameGapMs: 16.7,
    estimatedDroppedFrames: 0,
    duplicateTimestamps: 0,
    backwardsTimestamps: 0,
    finalizationMs: 1200,
    cancelled: false,
    cleanedPartialOutput: false,
    result: "completed",
    errorMessage: null,
    environment: {
      applicationBuild: {
        name: "gamebook",
        version: "0.5.3",
        sourceRevision: "a73e733",
        profile: "debug",
      },
      exe: "native_capture_spike.exe",
      currentDir: ".",
      os: "windows",
      arch: "x86_64",
      family: "windows",
      windowsCaptureVersion: "2.0.0",
      probes: [...REQUIRED_PROBES].map((name) => ({
        name,
        command: name,
        exitCode: 0,
        stdout: "{}",
        stderr: "",
      })),
    },
    notes: [],
    ...overrides,
  };
}

function syntheticCapability(overrides = {}) {
  const attempts = REQUIRED_CAPABILITY_PROFILES.map((profile, index) => ({
    profile,
    outputPath: `artifact:capability-${index}.mp4`,
    initializationMs: 20,
    finalizationMs: index === 0 ? null : 80,
    framesSubmitted: index === 0 ? 0 : 2,
    frameBytes: profile.width * profile.height * 4,
    outputBytes: index === 0 ? null : 1024,
    cleanedOutput: true,
    result: index === 0 ? "unsupported" : "supported",
    errorMessage: index === 0 ? "Profile is not supported." : null,
  }));

  return {
    schema: REQUIRED_CAPABILITY_SCHEMA,
    startedAt: "unix-ms-10",
    completedAt: "unix-ms-11",
    command: ["native_capture_spike.exe", "--scenario", "encoder-capability"],
    codec: "h264",
    capabilityScope: "synthetic-two-frame-initialization-and-finalization",
    captureStarted: false,
    syntheticFramesOnly: true,
    fourK60Supported: false,
    fallbackRequired: true,
    selectedProfile: REQUIRED_CAPABILITY_PROFILES[1],
    result: "supported",
    attempts,
    environment: syntheticBase().environment,
    notes: [],
    ...overrides,
  };
}

function runSelfTest() {
  verifyReport(syntheticBase(), { ...defaultOptions(), scenario: "encode" }, "encode");
  verifyCapabilityReport(syntheticCapability(), "encoder-capability");
  assert.throws(() =>
    verifyCapabilityReport(
      syntheticCapability({ captureStarted: true }),
      "capability-started-capture",
    ),
  );
  assert.throws(() =>
    verifyCapabilityReport(
      syntheticCapability({ selectedProfile: REQUIRED_CAPABILITY_PROFILES[2] }),
      "wrong-capability-fallback",
    ),
  );
  assert.throws(() =>
    verifyReport(
      syntheticBase({ durationErrorMs: 100 }),
      { ...defaultOptions(), scenario: "encode" },
      "bad-duration",
    ),
  );
  verifyCaptureGateFailure(
    syntheticBase({ submittedFrames: 1600 }),
    "low-throughput-fallback",
  );
  assert.throws(() => verifyCaptureGateFailure(syntheticBase(), "passing-fallback"));
  verifyReport(
    syntheticBase({
      scenario: "cancel",
      outputBytes: 0,
      result: "cancelled",
      cancelled: true,
      cleanedPartialOutput: true,
      finalizationMs: null,
      outputDurationMs: null,
      durationErrorMs: null,
    }),
    { ...defaultOptions(), scenario: "cancel" },
    "cancel",
  );
  verifyReport(
    syntheticBase({
      command: ["native_capture_spike.exe", "--scenario", "encoder-failure"],
      scenario: "encoder-failure",
      outputPath: "artifact:native-capture-spike",
      outputBytes: 0,
      submittedFrames: 0,
      result: "startup-failed",
      errorMessage: "New handler error",
      finalizationMs: null,
      captureTimestampSpanMs: null,
      outputDurationMs: null,
      durationErrorMs: null,
    }),
    { ...defaultOptions(), scenario: "encoder-failure" },
    "encoder-failure",
  );
  verifyReport(
    syntheticBase({
      command: [
        "native_capture_spike.exe",
        "--target",
        "controlled-fixture-window",
        "--scenario",
        "source-close",
      ],
      scenario: "source-close",
      declaredTargetKind: "window",
      targetLabel: "controlled-fixture-window",
      outputBytes: 0,
      submittedFrames: 120,
      result: "source-closed",
      cancelled: false,
      cleanedPartialOutput: true,
      finalizationMs: null,
      outputDurationMs: null,
      durationErrorMs: null,
    }),
    { ...defaultOptions(), scenario: "source-close" },
    "source-close",
  );
  verifyReportRole(
    { role: "selected-window", scenario: "encode" },
    syntheticBase({
      declaredTargetKind: "window",
      targetLabel: "controlled-fixture-window",
    }),
    "controlled-window-role",
  );
  assert.throws(() =>
    verifyReport(
      syntheticBase({ command: ["C:\\Users\\name\\native_capture_spike.exe"] }),
      { ...defaultOptions(), scenario: "encode" },
      "unredacted",
    ),
  );
  assert.throws(() =>
    verifyReport(
      syntheticBase({ targetLabel: "primary-monitor:\\\\.\\DISPLAY1" }),
      { ...defaultOptions(), scenario: "encode" },
      "named-monitor",
    ),
  );
  assert.throws(() =>
    verifyReport(
      syntheticBase({
        environment: {
          ...syntheticBase().environment,
          applicationBuild: {
            ...syntheticBase().environment.applicationBuild,
            sourceRevision: "uncommitted",
          },
        },
      }),
      { ...defaultOptions(), scenario: "encode" },
      "unidentified-build",
    ),
  );
  assert.throws(() =>
    verifyManifest(
      {
        schema: REQUIRED_MANIFEST_SCHEMA,
        issue: 6,
        applicationBuild: syntheticBase().environment.applicationBuild,
        reports: [],
        capabilityReports: [],
        manualEvidence: [],
      },
      "empty-manifest.json",
    ),
  );
  assert.throws(() =>
    assertRequiredManualEvidence(
      [
        {
          id: "device-loss",
          status: "pending",
          notes: "Not run.",
        },
      ],
      "pending-manual",
    ),
  );

  verifyReportRole(
    { role: "monitor-1080p60", scenario: "encode" },
    syntheticBase({ targetLabel: "primary-monitor" }),
    "1080p-role",
  );
  assert.throws(() =>
    verifyReportRole(
      { role: "monitor-1440p60", scenario: "encode" },
      syntheticBase({ targetLabel: "primary-monitor" }),
      "wrong-1440p-role",
    ),
  );

  const completeRoleCounts = new Map(
    [...REQUIRED_REPORT_ROLES].map(([role, requirement]) => [role, requirement.minimumCount]),
  );
  assertRequiredReportRoles(completeRoleCounts, "complete-roles");
  completeRoleCounts.set("selected-window", 1);
  assert.throws(() => assertRequiredReportRoles(completeRoleCounts, "sparse-roles"));

  const fallbackRoleCounts = new Map(
    [...REQUIRED_FALLBACK_REPORT_ROLES].map(([role, requirement]) => [
      role,
      requirement.minimumCount,
    ]),
  );
  assertRequiredReportRoles(
    fallbackRoleCounts,
    "complete-fallback-roles",
    REQUIRED_FALLBACK_REPORT_ROLES,
  );
  verifyFallbackFollowUp(
    {
      issue: 9,
      gates: [...REQUIRED_FALLBACK_FOLLOW_UP_GATES],
      notes: "Validate the direct Windows binding path.",
    },
    "fallback-follow-up",
  );
  assert.throws(() =>
    verifyFallbackFollowUp(
      {
        issue: 9,
        gates: ["device-loss"],
        notes: "Incomplete gate handoff.",
      },
      "incomplete-fallback-follow-up",
    ),
  );

  const seenReportPaths = new Set();
  const seenRunFingerprints = new Set();
  registerUniqueReportEvidence(
    { id: "run-01" },
    "C:\\reports\\run-01.json",
    syntheticBase(),
    seenReportPaths,
    seenRunFingerprints,
    "unique-runs",
  );
  assert.throws(() =>
    registerUniqueReportEvidence(
      { id: "reused-path" },
      "C:\\reports\\run-01.json",
      syntheticBase({ startedAt: "unix-ms-3" }),
      seenReportPaths,
      seenRunFingerprints,
      "unique-runs",
    ),
  );
  assert.throws(() =>
    registerUniqueReportEvidence(
      { id: "copied-run" },
      "C:\\reports\\run-copy.json",
      syntheticBase(),
      seenReportPaths,
      seenRunFingerprints,
      "unique-runs",
    ),
  );

  assert.throws(() =>
    assertRequiredManualEvidence(
      [...REQUIRED_MANUAL_EVIDENCE].map(([id, minimumAttempts]) => ({
        id,
        status: "not-applicable",
        attempts: minimumAttempts,
        notes: "Synthetic rationale.",
      })),
      "not-applicable-manual",
    ),
  );
}

function defaultOptions() {
  return {
    durationToleranceFrames: 1,
    maxFinalizationMs: 5000,
    minOutputBytes: 1,
    minSubmittedFrames: 1,
    minSourceWidth: 0,
    minSourceHeight: 0,
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.selfTest) {
    runSelfTest();
    console.log("Native capture report verifier self-test passed.");
    return;
  }

  if (options.manifest) {
    const manifest = JSON.parse(readFileSync(options.manifest, "utf8"));
    verifyManifest(manifest, options.manifest);
    console.log(`Verified evidence manifest ${options.manifest}`);
    return;
  }

  if (options.reports.length === 0) {
    throw new Error("At least one report path is required. Use --help for usage.");
  }

  for (const path of options.reports) {
    const report = JSON.parse(readFileSync(path, "utf8"));
    if (report.schema === REQUIRED_CAPABILITY_SCHEMA) {
      verifyCapabilityReport(report, basename(path));
    } else {
      verifyReport(report, options, basename(path));
    }
    console.log(`Verified ${path}`);
  }
}

main();
