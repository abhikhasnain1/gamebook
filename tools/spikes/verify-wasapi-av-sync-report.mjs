import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

const REPORT_SCHEMA = "gamebook.wasapi-av-sync-spike.v1";
const MANIFEST_SCHEMA = "gamebook.wasapi-av-sync-evidence-set.v1";
const REQUIRED_PROBES = new Set([
  "windows-os-memory",
  "cpu",
  "audio-devices",
  "storage-volumes",
  "power-scheme",
]);
const REQUIRED_ROLES = new Map([
  ["active-audio", { scenario: "active-audio", minimumCount: 2 }],
  ["silence", { scenario: "silence", minimumCount: 2 }],
  ["cancellation", { scenario: "cancel", minimumCount: 2 }],
  ["audio-failure", { scenario: "audio-failure", minimumCount: 1 }],
  ["endpoint-change", { scenario: "endpoint-change", minimumCount: 1 }],
  ["encoder-failure", { scenario: "encoder-failure", minimumCount: 1 }],
]);
const PATH_MARKERS = [
  /[A-Z]:\\\\Users\\\\/i,
  /OneDrive[\\\\/]/i,
  /Program Files[\\\\/]/i,
  /"location"\s*:/i,
];

function parseArgs(argv) {
  const options = {
    manifest: undefined,
    reports: [],
    scenario: undefined,
    maxDriftMs: 50,
    maxFinalizationMs: 5000,
    selfTest: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--manifest":
        options.manifest = readValue(argv, ++index, arg);
        break;
      case "--scenario":
        options.scenario = readValue(argv, ++index, arg);
        break;
      case "--max-drift-ms":
        options.maxDriftMs = Number(readValue(argv, ++index, arg));
        break;
      case "--max-finalization-ms":
        options.maxFinalizationMs = Number(readValue(argv, ++index, arg));
        break;
      case "--self-test":
        options.selfTest = true;
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
  console.log(`WASAPI A/V synchronization report verifier

Usage:
  npm.cmd run wasapi-sync:verify -- <report.json> --scenario active-audio
  npm.cmd run wasapi-sync:verify -- --manifest <evidence-set.json>
  npm.cmd run wasapi-sync:verify -- --self-test

Options:
  --scenario NAME             Require one scenario.
  --max-drift-ms N            Maximum absolute A/V drift. Default: 50.
  --max-finalization-ms N     Maximum finalization time. Default: 5000.
  --manifest PATH             Verify a complete issue #7 evidence set.
  --self-test                 Run synthetic verifier tests.`);
}

function verifyReport(report, options = defaultOptions(), label = "report") {
  assert.equal(report.schema, REPORT_SCHEMA, `${label}: schema mismatch`);
  assert.equal(report.issue, 7, `${label}: report must target issue 7`);
  assert.ok(report.startedAt, `${label}: missing startedAt`);
  assert.ok(report.completedAt, `${label}: missing completedAt`);
  assert.ok(Array.isArray(report.command) && report.command.length > 0, `${label}: invalid command`);
  assert.ok(!report.command.includes("--microphone"), `${label}: command exposes microphone capture`);
  assert.equal(report.defaultEndpointKind, "render", `${label}: endpoint must be render`);
  assert.equal(report.microphoneCaptureEnabled, false, `${label}: microphone must be disabled`);
  assert.equal(report.captureEndpointActivated, false, `${label}: capture endpoint was activated`);
  assert.match(report.outputPath, /^artifact(?::[^\\/]+)?$/, `${label}: outputPath is not redacted`);
  assertNoPathMarkers(report, label);
  verifyEnvironment(report, label);

  if (options.scenario) {
    assert.equal(report.scenario, options.scenario, `${label}: scenario mismatch`);
  }

  switch (report.scenario) {
    case "active-audio":
      verifyCompletedCapture(report, options, label);
      assert.equal(report.controlledStimulus, "local-tone", `${label}: tone fixture missing`);
      assert.ok(report.framesCaptured > report.silentFrames, `${label}: active run contains no active samples`);
      break;
    case "silence":
      verifyCompletedCapture(report, options, label);
      assert.equal(report.controlledStimulus, "local-silence", `${label}: silence fixture missing`);
      assert.ok(report.silentFrames > 0, `${label}: silence run contains no silent frames`);
      break;
    case "cancel":
      verifyCancellation(report, label);
      break;
    case "audio-failure":
      verifyAudioFailure(report, label);
      break;
    case "endpoint-change":
      verifyCompletedCapture(report, options, label);
      assert.equal(report.endpointChanged, true, `${label}: endpoint change was not observed`);
      break;
    case "encoder-failure":
      verifyEncoderFailure(report, label);
      break;
    default:
      throw new Error(`${label}: unsupported scenario ${report.scenario}`);
  }
}

function verifyCompletedCapture(report, options, label) {
  assert.equal(report.result, "completed", `${label}: capture did not complete`);
  verifyStartedAudioShape(report, label);
  assert.ok(report.outputBytes > 0, `${label}: encoded output is empty`);
  assert.ok(report.encodedDurationMs !== null, `${label}: encoded duration missing`);
  assert.ok(report.finalizationMs !== null, `${label}: finalization time missing`);
  assert.ok(
    report.finalizationMs <= options.maxFinalizationMs,
    `${label}: finalization exceeded ${options.maxFinalizationMs}ms`,
  );
  assert.ok(report.avDriftMs !== null, `${label}: A/V drift missing`);
  assert.ok(
    Math.abs(report.avDriftMs) <= options.maxDriftMs,
    `${label}: A/V drift exceeded ${options.maxDriftMs}ms`,
  );
  assert.ok(
    Math.abs(report.encodedDurationErrorMs) <= report.endpointBufferDurationMs,
    `${label}: encoded duration differs by more than one endpoint buffer`,
  );
  assert.equal(report.cancelled, false, `${label}: completed capture marked cancelled`);
  assert.equal(report.cleanedPartialOutput, false, `${label}: completed output was cleaned`);
}

function verifyStartedAudioShape(report, label) {
  assert.ok(report.audioFormat, `${label}: missing audio format`);
  assert.ok([1, 2].includes(report.audioFormat.channels), `${label}: unsupported channel count`);
  assert.ok(
    [44100, 48000].includes(report.audioFormat.samplesPerSecond),
    `${label}: unsupported sample rate`,
  );
  assert.equal(report.audioFormat.encoderBitsPerSample, 16, `${label}: encoder input is not PCM16`);
  assert.ok(report.endpointBufferFrames > 0, `${label}: endpoint buffer is empty`);
  assert.ok(report.endpointBufferDurationMs > 0, `${label}: endpoint buffer duration missing`);
  assert.ok(report.packetsCaptured > 0, `${label}: no packets captured`);
  assert.ok(report.framesCaptured > 0, `${label}: no audio frames captured`);
  assert.ok(report.firstAudioQpc100ns !== null, `${label}: first audio QPC missing`);
  assert.ok(report.lastAudioQpc100ns !== null, `${label}: last audio QPC missing`);
  assert.ok(report.audioTimelineDurationMs > 0, `${label}: audio timeline missing`);
  assert.ok(report.videoReferenceDurationMs > 0, `${label}: video reference timeline missing`);
  assert.ok(report.videoReferenceFrames > 0, `${label}: video reference frames missing`);
}

function verifyCancellation(report, label) {
  assert.equal(report.result, "cancelled", `${label}: cancellation result mismatch`);
  assert.equal(report.cancelled, true, `${label}: cancellation flag missing`);
  assert.equal(report.cleanedPartialOutput, true, `${label}: partial output was not removed`);
  assert.ok(!report.outputBytes, `${label}: cancellation retained encoded output`);
  assert.equal(report.encodedDurationMs, null, `${label}: cancellation retained duration`);
}

function verifyAudioFailure(report, label) {
  assert.equal(report.result, "audio-failed", `${label}: audio failure result mismatch`);
  verifyStartedAudioShape(report, label);
  assert.ok(report.errorMessage, `${label}: audio failure has no explanation`);
  assert.ok(
    report.videoReferenceDurationMs >= report.requestedDurationMs - 250,
    `${label}: reference video clock did not continue after audio failure`,
  );
  assert.ok(
    report.audioTimelineDurationMs < report.videoReferenceDurationMs,
    `${label}: simulated audio failure did not stop audio early`,
  );
  assert.equal(report.cancelled, false, `${label}: audio failure marked cancelled`);
}

function verifyEncoderFailure(report, label) {
  assert.equal(report.result, "startup-failed", `${label}: encoder failure did not fail startup`);
  assert.equal(report.packetsCaptured, 0, `${label}: encoder failure captured packets`);
  assert.equal(report.framesCaptured, 0, `${label}: encoder failure captured frames`);
  assert.equal(report.microphoneCaptureEnabled, false, `${label}: microphone enabled during failure`);
  assert.ok(report.errorMessage, `${label}: encoder failure has no explanation`);
  assert.ok(!report.outputBytes, `${label}: encoder failure retained output`);
  assert.equal(report.cleanedPartialOutput, true, `${label}: encoder failure cleanup missing`);
}

function verifyEnvironment(report, label) {
  const environment = report.environment;
  assert.ok(environment, `${label}: missing environment`);
  assert.deepEqual(
    environment.applicationBuild,
    {
      name: "gamebook",
      version: "0.5.3",
      sourceRevision: environment.applicationBuild.sourceRevision,
      profile: environment.applicationBuild.profile,
    },
    `${label}: application build shape mismatch`,
  );
  assert.match(
    environment.applicationBuild.sourceRevision,
    /^[0-9a-f]{7,64}$/,
    `${label}: source revision is not an exact hexadecimal build`,
  );
  assert.ok(["debug", "release"].includes(environment.applicationBuild.profile), `${label}: invalid profile`);
  assert.equal(environment.currentDir, ".", `${label}: currentDir must be redacted`);
  assert.equal(environment.windowsCrateVersion, "0.61.3", `${label}: windows crate mismatch`);
  assert.ok(Array.isArray(environment.probes), `${label}: probes must be an array`);
  const probes = new Map(environment.probes.map((probe) => [probe.name, probe]));
  for (const name of REQUIRED_PROBES) {
    assert.ok(probes.has(name), `${label}: missing environment probe ${name}`);
    assert.equal(probes.get(name).exitCode, 0, `${label}: environment probe ${name} failed`);
  }
}

function verifyManifest(manifest, manifestPath) {
  const label = basename(manifestPath);
  assert.equal(manifest.schema, MANIFEST_SCHEMA, `${label}: manifest schema mismatch`);
  assert.equal(manifest.issue, 7, `${label}: manifest must target issue 7`);
  assert.ok(manifest.decisionRationale?.trim(), `${label}: decisionRationale is required`);
  assertNoPathMarkers(manifest, label);
  assert.ok(Array.isArray(manifest.reports), `${label}: reports must be an array`);
  const baseDir = dirname(resolve(manifestPath));
  const seenIds = new Set();
  const seenPaths = new Set();
  const seenRuns = new Set();
  const roleCounts = new Map();

  for (const entry of manifest.reports) {
    assert.ok(entry.id && !seenIds.has(entry.id), `${label}: duplicate or missing report id`);
    seenIds.add(entry.id);
    assert.ok(REQUIRED_ROLES.has(entry.role), `${label}: unsupported role ${entry.role}`);
    const reportPath = resolve(baseDir, entry.path);
    const normalized = reportPath.toLowerCase();
    assert.ok(!seenPaths.has(normalized), `${label}: report path reused by ${entry.id}`);
    seenPaths.add(normalized);
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    const runFingerprint = JSON.stringify([report.startedAt, report.completedAt, report.command]);
    assert.ok(!seenRuns.has(runFingerprint), `${label}: duplicate run evidence ${entry.id}`);
    seenRuns.add(runFingerprint);
    assert.equal(entry.scenario, REQUIRED_ROLES.get(entry.role).scenario, `${label}:${entry.id}: role scenario mismatch`);
    verifyReport(report, { ...defaultOptions(), scenario: entry.scenario }, `${label}:${entry.id}`);
    assert.deepEqual(
      report.environment.applicationBuild,
      manifest.applicationBuild,
      `${label}:${entry.id}: build identity mismatch`,
    );
    roleCounts.set(entry.role, (roleCounts.get(entry.role) ?? 0) + 1);
  }

  for (const [role, requirement] of REQUIRED_ROLES) {
    assert.ok(
      (roleCounts.get(role) ?? 0) >= requirement.minimumCount,
      `${label}: role ${role} requires ${requirement.minimumCount} run(s)`,
    );
  }
}

function assertNoPathMarkers(value, label) {
  const serialized = JSON.stringify(value);
  for (const marker of PATH_MARKERS) {
    assert.ok(!marker.test(serialized), `${label}: contains local path or private marker ${marker}`);
  }
}

function defaultOptions() {
  return {
    scenario: undefined,
    maxDriftMs: 50,
    maxFinalizationMs: 5000,
  };
}

function syntheticBase(overrides = {}) {
  return {
    schema: REPORT_SCHEMA,
    issue: 7,
    startedAt: "unix-ms-1",
    completedAt: "unix-ms-2",
    command: ["wasapi_av_sync_spike.exe", "--scenario", "active-audio"],
    scenario: "active-audio",
    result: "completed",
    errorMessage: null,
    requestedDurationMs: 30000,
    defaultEndpointKind: "render",
    microphoneCaptureEnabled: false,
    captureEndpointActivated: false,
    controlledStimulus: "local-tone",
    audioFormat: {
      channels: 2,
      samplesPerSecond: 48000,
      sourceBitsPerSample: 32,
      sourceBlockAlignment: 8,
      sourceSampleFormat: "float32",
      encoderBitsPerSample: 16,
      encoderAverageBytesPerSecond: 24000,
    },
    endpointBufferFrames: 480,
    endpointBufferDurationMs: 10,
    packetsCaptured: 3000,
    framesCaptured: 1440000,
    silentFrames: 0,
    discontinuityPackets: 0,
    timestampErrorPackets: 0,
    firstDevicePosition: 0,
    lastDevicePosition: 1439520,
    firstAudioQpc100ns: 1000000,
    lastAudioQpc100ns: 300900000,
    audioTimelineDurationMs: 30000,
    videoReferenceFrames: 1800,
    videoReferenceDurationMs: 30000,
    initialAvOffsetMs: 2,
    finalAvOffsetMs: 3,
    avDriftMs: 1,
    outputPath: "artifact:synthetic.mp4",
    outputBytes: 720000,
    encodedDurationMs: 30005,
    encodedDurationErrorMs: 5,
    finalizationMs: 100,
    cancelled: false,
    cleanedPartialOutput: false,
    endpointChanged: false,
    environment: {
      applicationBuild: {
        name: "gamebook",
        version: "0.5.3",
        sourceRevision: "09e56de",
        profile: "release",
      },
      exe: "wasapi_av_sync_spike.exe",
      currentDir: ".",
      os: "windows",
      arch: "x86_64",
      family: "windows",
      windowsCrateVersion: "0.61.3",
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
  verifyReport(syntheticBase());
  assert.throws(() => verifyReport(syntheticBase({ microphoneCaptureEnabled: true })));
  assert.throws(() => verifyReport(syntheticBase({ avDriftMs: 50.1 })));
  assert.throws(() => verifyReport(syntheticBase({ encodedDurationErrorMs: 10.1 })));

  verifyReport(
    syntheticBase({
      scenario: "silence",
      controlledStimulus: "local-silence",
      silentFrames: 1440000,
    }),
  );
  verifyReport(
    syntheticBase({
      scenario: "cancel",
      result: "cancelled",
      controlledStimulus: null,
      outputBytes: null,
      encodedDurationMs: null,
      encodedDurationErrorMs: null,
      finalizationMs: null,
      cancelled: true,
      cleanedPartialOutput: true,
    }),
  );
  verifyReport(
    syntheticBase({
      scenario: "audio-failure",
      result: "audio-failed",
      errorMessage: "Simulated post-start audio failure.",
      controlledStimulus: null,
      audioTimelineDurationMs: 5000,
      videoReferenceDurationMs: 30000,
    }),
  );
  verifyReport(
    syntheticBase({
      scenario: "endpoint-change",
      controlledStimulus: null,
      endpointChanged: true,
    }),
  );
  verifyReport(
    syntheticBase({
      scenario: "encoder-failure",
      result: "startup-failed",
      errorMessage: "Encoder initialization failed.",
      controlledStimulus: null,
      audioFormat: null,
      endpointBufferFrames: null,
      endpointBufferDurationMs: null,
      packetsCaptured: 0,
      framesCaptured: 0,
      silentFrames: 0,
      firstDevicePosition: null,
      lastDevicePosition: null,
      firstAudioQpc100ns: null,
      lastAudioQpc100ns: null,
      audioTimelineDurationMs: null,
      videoReferenceFrames: 0,
      videoReferenceDurationMs: null,
      initialAvOffsetMs: null,
      finalAvOffsetMs: null,
      avDriftMs: null,
      outputBytes: null,
      encodedDurationMs: null,
      encodedDurationErrorMs: null,
      finalizationMs: null,
      cleanedPartialOutput: true,
      environment: {
        ...syntheticBase().environment,
        probes: [...REQUIRED_PROBES].map((name) => ({
          name,
          command: name,
          exitCode: 0,
          stdout: "{}",
          stderr: "",
        })),
      },
    }),
  );
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.selfTest) {
    runSelfTest();
    console.log("WASAPI A/V synchronization verifier self-test passed.");
    return;
  }
  if (options.manifest) {
    const manifest = JSON.parse(readFileSync(options.manifest, "utf8"));
    verifyManifest(manifest, options.manifest);
    console.log(`Verified WASAPI evidence manifest ${options.manifest}`);
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
