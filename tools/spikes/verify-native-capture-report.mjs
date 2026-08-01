import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

const REQUIRED_SCHEMA = "gamebook.native-capture-spike.v1";
const REQUIRED_MANIFEST_SCHEMA = "gamebook.native-capture-evidence-set.v1";
const REQUIRED_PROBES = new Set([
  "windows-os-memory",
  "cpu",
  "gpu-display-driver",
  "audio-devices",
  "storage-volumes",
  "webview2-runtime",
  "power-scheme",
]);
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
  npm.cmd run native-capture:verify -- <report.json> --scenario encoder-failure
  npm.cmd run native-capture:verify -- --manifest <evidence-set.json>

Options:
  --duration-tolerance-frames N   Encoded duration tolerance for encode reports. Default: 1
  --max-finalization-ms N         Maximum finalization time for encode reports. Default: 5000
  --min-output-bytes N            Minimum MP4 byte count for encode reports. Default: 1
  --min-submitted-frames N        Minimum submitted frames for encode reports. Default: 1
  --manifest PATH                 Verify an evidence-set manifest and every referenced report.
  --self-test                     Run synthetic verifier tests.`);
}

function verifyReport(report, options, label = "report") {
  assert.equal(report.schema, REQUIRED_SCHEMA, `${label}: schema mismatch`);
  assert.ok(report.startedAt, `${label}: missing startedAt`);
  assert.ok(report.completedAt, `${label}: missing completedAt`);
  assert.ok(Array.isArray(report.command), `${label}: command must be an array`);
  assert.ok(report.command.length > 0, `${label}: command is empty`);
  assertNoPathMarkers(report, label);

  if (options.scenario) {
    assert.equal(report.scenario, options.scenario, `${label}: scenario mismatch`);
  }
  assert.ok(report.sourceWidth >= options.minSourceWidth, `${label}: source width below threshold`);
  assert.ok(report.sourceHeight >= options.minSourceHeight, `${label}: source height below threshold`);
  assert.equal(report.requestedWidth % 2, 0, `${label}: requested width must be even`);
  assert.equal(report.requestedHeight % 2, 0, `${label}: requested height must be even`);
  assert.ok(report.estimatedFrameDurationMs > 0, `${label}: missing frame duration`);
  verifyEnvironment(report, label);

  switch (report.scenario) {
    case "encode":
      verifyEncodeReport(report, options, label);
      break;
    case "cancel":
      verifyCancelReport(report, label);
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
  assert.ok(report.encodedDurationMs !== null, `${label}: missing encodedDurationMs`);
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
}

function verifyEncoderFailureReport(report, label) {
  assert.equal(report.result, "startup-failed", `${label}: failure result must be startup-failed`);
  assert.equal(report.submittedFrames, 0, `${label}: startup failure submitted frames`);
  assert.ok(report.errorMessage, `${label}: missing startup failure message`);
  assert.ok(!report.outputBytes || report.outputBytes === 0, `${label}: failure output remains`);
}

function verifyEnvironment(report, label) {
  assert.ok(report.environment, `${label}: missing environment`);
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
  assertNoPathMarkers(manifest, label);
  assert.ok(Array.isArray(manifest.reports), `${label}: reports must be an array`);
  assert.ok(manifest.reports.length > 0, `${label}: reports cannot be empty`);

  const baseDir = dirname(resolve(manifestPath));
  const seenIds = new Set();
  for (const entry of manifest.reports) {
    assert.ok(entry.id, `${label}: report entry missing id`);
    assert.ok(!seenIds.has(entry.id), `${label}: duplicate report id ${entry.id}`);
    seenIds.add(entry.id);
    assert.ok(entry.path, `${label}: report ${entry.id} missing path`);
    const reportPath = resolve(baseDir, entry.path);
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    verifyReport(
      report,
      {
        ...defaultOptions(),
        scenario: entry.scenario,
        minSourceWidth: entry.minSourceWidth ?? 0,
        minSourceHeight: entry.minSourceHeight ?? 0,
        durationToleranceFrames: entry.durationToleranceFrames ?? 1,
        maxFinalizationMs: entry.maxFinalizationMs ?? 5000,
        minOutputBytes: entry.minOutputBytes ?? 1,
        minSubmittedFrames: entry.minSubmittedFrames ?? 1,
      },
      `${label}:${entry.id}`,
    );
  }

  assertRequiredManualEvidence(manifest.manualEvidence ?? [], label);
}

function assertRequiredManualEvidence(manualEvidence, label) {
  const requiredIds = new Set([
    "4k-capability-or-fallback",
    "source-close",
    "device-loss",
    "protected-content",
    "hud-exclusion-fallback",
    "accessibility-contract",
  ]);
  assert.ok(Array.isArray(manualEvidence), `${label}: manualEvidence must be an array`);
  const entries = new Map(manualEvidence.map((entry) => [entry.id, entry]));

  for (const id of requiredIds) {
    assert.ok(entries.has(id), `${label}: missing manual evidence ${id}`);
    const entry = entries.get(id);
    assert.ok(
      entry.status === "passed" || entry.status === "not-applicable",
      `${label}: manual evidence ${id} is not complete`,
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
    targetLabel: "synthetic",
    sourceWidth: 1920,
    sourceHeight: 1080,
    requestedWidth: 1920,
    requestedHeight: 1080,
    requestedFrameRate: 60,
    requestedDurationMs: 30000,
    outputPath: "src-tauri/target/native-capture-spike/synthetic.mp4",
    outputBytes: 1024,
    submittedFrames: 1800,
    estimatedFrameDurationMs: 1000 / 60,
    firstTimestampTicks: 0,
    lastTimestampTicks: 300000000,
    encodedDurationMs: 30000,
    durationErrorMs: 0,
    largestFrameGapMs: 16.7,
    duplicateTimestamps: 0,
    backwardsTimestamps: 0,
    finalizationMs: 1200,
    cancelled: false,
    cleanedPartialOutput: false,
    result: "completed",
    errorMessage: null,
    environment: {
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

function runSelfTest() {
  verifyReport(syntheticBase(), { ...defaultOptions(), scenario: "encode" }, "encode");
  assert.throws(() =>
    verifyReport(
      syntheticBase({ durationErrorMs: 100 }),
      { ...defaultOptions(), scenario: "encode" },
      "bad-duration",
    ),
  );
  verifyReport(
    syntheticBase({
      scenario: "cancel",
      outputBytes: 0,
      result: "cancelled",
      cancelled: true,
      cleanedPartialOutput: true,
      finalizationMs: null,
    }),
    { ...defaultOptions(), scenario: "cancel" },
    "cancel",
  );
  verifyReport(
    syntheticBase({
      command: ["native_capture_spike.exe", "--scenario", "encoder-failure"],
      scenario: "encoder-failure",
      outputPath: "src-tauri/target/native-capture-spike",
      outputBytes: 0,
      submittedFrames: 0,
      result: "startup-failed",
      errorMessage: "New handler error",
      finalizationMs: null,
    }),
    { ...defaultOptions(), scenario: "encoder-failure" },
    "encoder-failure",
  );
  assert.throws(() =>
    verifyReport(
      syntheticBase({ command: ["C:\\Users\\name\\native_capture_spike.exe"] }),
      { ...defaultOptions(), scenario: "encode" },
      "unredacted",
    ),
  );
  assert.throws(() =>
    verifyManifest(
      {
        schema: REQUIRED_MANIFEST_SCHEMA,
        issue: 6,
        reports: [],
        manualEvidence: [],
      },
      "empty-manifest.json",
    ),
  );
  assert.throws(() =>
    assertRequiredManualEvidence(
      [
        {
          id: "4k-capability-or-fallback",
          status: "pending",
          notes: "Not run.",
        },
      ],
      "pending-manual",
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
    verifyReport(report, options, basename(path));
    console.log(`Verified ${path}`);
  }
}

main();
