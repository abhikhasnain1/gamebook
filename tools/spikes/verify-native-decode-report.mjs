import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

const REPORT_SCHEMA = "gamebook.native-decode-spike.v1";
const MANIFEST_SCHEMA = "gamebook.native-decode-evidence-manifest.v1";
const SUCCESS_SCENARIOS = new Set(["cfr-30", "cfr-60", "vfr", "sdr-color", "odd-aperture"]);
const HDR_SCENARIOS = new Set(["hdr-pq-block", "hdr-hlg-block"]);
const FAILURE_SCENARIOS = new Set(["malformed", "out-of-range", "cancel", "decoder-failure"]);
const REQUIRED_ROLES = new Map([
  ["cfr-30", "cfr-30"],
  ["cfr-60", "cfr-60"],
  ["vfr", "vfr"],
  ["sdr-rec709", "sdr-color"],
  ["odd-aperture", "odd-aperture"],
  ["hdr-pq-block", "hdr-pq-block"],
  ["hdr-hlg-block", "hdr-hlg-block"],
  ["malformed-input", "malformed"],
  ["out-of-range", "out-of-range"],
  ["cancellation", "cancel"],
  ["decoder-failure", "decoder-failure"],
]);
const PRIVATE_MARKERS = [
  /[a-z]:\\/i,
  /\\users\\/i,
  /onedrive/i,
  /\.local-governance/i,
  /\.agents(?:\\|\/)/i,
  /agents\.md/i,
  /assistant/i,
  /provider/i,
  /model reference/i,
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
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
        break;
      default:
        options.reports.push(args[index]);
    }
  }
  return options;
}

function printHelp() {
  console.log("verify-native-decode-report [--scenario NAME] REPORT...");
  console.log("verify-native-decode-report --manifest MANIFEST");
  console.log("verify-native-decode-report --self-test");
}

function verifyReport(report, expectedScenario, label = "report") {
  assert.equal(report.schema, REPORT_SCHEMA, `${label}: report schema mismatch`);
  assert.equal(report.issue, 8, `${label}: issue must be 8`);
  assert.equal(report.result, "passed", `${label}: result must be passed`);
  assert.equal(report.errorMessage, null, `${label}: passed report cannot contain an error`);
  assert.ok(report.startedAt && report.completedAt, `${label}: timestamps are required`);
  assert.ok(Array.isArray(report.command) && report.command.length >= 3, `${label}: redacted command is required`);
  assert.equal(report.command[0], "native_decode_spike.exe", `${label}: executable must be redacted`);
  assert.equal(report.applicationBuild?.name, "gamebook", `${label}: application name mismatch`);
  assert.equal(report.applicationBuild?.version, "0.5.3", `${label}: compatibility version mismatch`);
  assert.match(report.applicationBuild?.sourceRevision ?? "", /^[a-zA-Z0-9._-]{7,128}$/, `${label}: source revision is invalid`);
  assert.ok(["debug", "release"].includes(report.applicationBuild?.profile), `${label}: build profile is invalid`);
  assert.equal(report.privacy?.syntheticInputOnly, true, `${label}: only synthetic input is permitted`);
  assert.equal(report.privacy?.networkAccess, false, `${label}: network access must be false`);
  assert.equal(report.privacy?.projectWrites, false, `${label}: project writes must be false`);
  assert.equal(report.privacy?.mediaBytesInReport, false, `${label}: media bytes cannot be reported`);
  assert.equal(report.privacy?.localPathsInReport, false, `${label}: local paths cannot be reported`);
  assert.equal(report.accessibility?.interactiveUi, false, `${label}: spike must remain noninteractive`);
  assert.ok(report.accessibility?.productionAnnouncementContract?.trim(), `${label}: production announcement contract is required`);
  assertNoPrivateMarkers(report, label);

  if (expectedScenario) {
    assert.equal(report.scenario, expectedScenario, `${label}: scenario mismatch`);
  }
  assert.ok(
    SUCCESS_SCENARIOS.has(report.scenario) || HDR_SCENARIOS.has(report.scenario) || FAILURE_SCENARIOS.has(report.scenario),
    `${label}: unsupported scenario ${report.scenario}`,
  );

  if (SUCCESS_SCENARIOS.has(report.scenario)) {
    verifySuccessfulDecode(report, label);
  } else if (HDR_SCENARIOS.has(report.scenario)) {
    verifyHdrBlock(report, label);
  } else {
    verifyFailureMode(report, label);
  }
}

function verifySuccessfulDecode(report, label) {
  assert.equal(report.sourceArtifact, "artifact:synthetic.mp4", `${label}: source artifact must be redacted`);
  assert.ok(Number.isInteger(report.outputBytes) && report.outputBytes > 0, `${label}: MP4 must be non-empty`);
  const timeline = report.timeline;
  assert.ok(Array.isArray(timeline?.submitted) && timeline.submitted.length > 0, `${label}: submitted timeline is required`);
  assert.ok(Array.isArray(timeline.decodedPts100ns), `${label}: decoded timestamps are required`);
  assert.equal(timeline.exactTimestamps, true, `${label}: timestamps must be exact`);
  assert.equal(timeline.exactSampleOrder, true, `${label}: sample order must be exact`);
  const submittedPts = timeline.submitted.map((sample) => sample.pts100ns);
  assert.deepEqual(timeline.decodedPts100ns, submittedPts, `${label}: decoded timestamps differ from submitted timestamps`);
  for (const [index, sample] of timeline.submitted.entries()) {
    assert.ok(Number.isSafeInteger(sample.pts100ns) && sample.pts100ns >= 0, `${label}: sample ${index} PTS must be a nonnegative integer`);
    assert.ok(Number.isSafeInteger(sample.duration100ns) && sample.duration100ns > 0, `${label}: sample ${index} duration must be a positive integer`);
    if (index > 0) {
      assert.ok(sample.pts100ns > timeline.submitted[index - 1].pts100ns, `${label}: PTS must be strictly increasing`);
    }
  }
  assert.deepEqual(
    timeline.extractedSamples.map((sample) => sample.sampleIndex),
    timeline.requestedSampleIndices,
    `${label}: extracted sample indices must exactly match requests`,
  );
  assert.ok(timeline.extractedSamples.every((sample) => /^artifact:sample-\d+\.png$/.test(sample.path)), `${label}: extracted paths must be redacted`);
  assert.equal(report.video?.edgeReplicationVerifiedBeforeEncode, true, `${label}: edge replication must be verified`);
  assert.equal(report.video?.restoredPngLogicalDimensions, true, `${label}: PNG dimensions must be restored`);
  assert.equal(report.cleanup?.partialArtifactsRemoved, true, `${label}: cleanup contract is required`);

  if (report.scenario === "cfr-30") {
    assert.equal(timeline.submitted.length, 30, `${label}: CFR 30 fixture must contain 30 samples`);
  }
  if (report.scenario === "cfr-60") {
    assert.equal(timeline.submitted.length, 60, `${label}: CFR 60 fixture must contain 60 samples`);
  }
  if (report.scenario === "vfr") {
    assert.equal(timeline.submitted.length, 12, `${label}: VFR fixture must contain 12 samples`);
    assert.ok(new Set(timeline.submitted.map((sample) => sample.duration100ns)).size >= 4, `${label}: VFR durations must be nonuniform`);
  }
  if (report.scenario !== "sdr-color") {
    assert.deepEqual(
      timeline.decodedFrameIds,
      Array.from({ length: timeline.submitted.length }, (_, index) => index),
      `${label}: decoded frame identities must be exact`,
    );
    for (const extracted of timeline.extractedSamples) {
      assert.equal(extracted.decodedFrameId, extracted.sampleIndex, `${label}: extracted frame identity mismatch`);
    }
  }
  if (report.scenario === "sdr-color") {
    verifyColor(report.color, label);
  }
  if (report.scenario === "odd-aperture") {
    verifyOddAperture(report.video, timeline, label);
  }
}

function verifyColor(color, label) {
  assert.equal(color?.classification, "sdr-rec709", `${label}: SDR classification mismatch`);
  assert.equal(color?.primaries, "bt709", `${label}: primaries mismatch`);
  assert.equal(color?.transfer, "bt709", `${label}: transfer mismatch`);
  assert.equal(color?.matrix, "bt709", `${label}: matrix mismatch`);
  assert.equal(color?.range, "full", `${label}: nominal range mismatch`);
  assert.ok(Number.isInteger(color?.perChannelTolerance) && color.perChannelTolerance > 0, `${label}: color tolerance is required`);
  assert.equal(color?.passed, true, `${label}: color comparison must pass`);
  assert.equal(color?.centralPatchComparisons?.length, 7, `${label}: seven color-bar patches are required`);
  for (const patch of color.centralPatchComparisons) {
    assert.equal(patch.passed, true, `${label}: color patch ${patch.bar} failed`);
    assert.ok(patch.deltaRgb.every((delta) => Math.abs(delta) <= color.perChannelTolerance), `${label}: color patch ${patch.bar} exceeds tolerance`);
  }
}

function verifyOddAperture(video, timeline, label) {
  assert.equal(video.logicalWidth % 2, 1, `${label}: logical width must be odd`);
  assert.equal(video.logicalHeight % 2, 1, `${label}: logical height must be odd`);
  assert.ok(video.paddingRight >= 0 && video.paddingRight <= 1, `${label}: right padding exceeds one pixel`);
  assert.ok(video.paddingBottom >= 0 && video.paddingBottom <= 1, `${label}: bottom padding exceeds one pixel`);
  assert.equal(video.decodeAperturePreserved, true, `${label}: negotiated decode aperture must be preserved`);
  assert.equal(video.decodeAperture?.width, video.logicalWidth, `${label}: aperture width mismatch`);
  assert.equal(video.decodeAperture?.height, video.logicalHeight, `${label}: aperture height mismatch`);
  assert.equal(video.sourceContainerAperturePreserved, false, `${label}: reference result must record MP4 aperture loss`);
  assert.ok(timeline.extractedSamples.every((sample) => sample.width === video.logicalWidth && sample.height === video.logicalHeight), `${label}: extracted dimensions mismatch`);
}

function verifyHdrBlock(report, label) {
  assert.equal(report.hdr?.primaries, "bt2020", `${label}: HDR primaries must be BT.2020`);
  assert.equal(report.hdr?.transfer, report.scenario === "hdr-pq-block" ? "pq" : "hlg", `${label}: HDR transfer mismatch`);
  assert.equal(report.hdr?.blocked, true, `${label}: unsupported HDR must be blocked`);
  assert.equal(report.hdr?.toneMapped, false, `${label}: spike cannot claim tone mapping`);
  assert.equal(report.hdr?.outputCreated, false, `${label}: blocked HDR cannot create evidence output`);
  assert.equal(report.cleanup?.partialArtifactsRemoved, true, `${label}: HDR cleanup contract is required`);
  assert.deepEqual(report.cleanup?.retainedArtifacts, [], `${label}: HDR block cannot retain output`);
}

function verifyFailureMode(report, label) {
  const expectedOutcome = {
    malformed: "malformed-input-rejected",
    "out-of-range": "out-of-range-rejected",
    cancel: "cancelled-and-cleaned",
    "decoder-failure": "decoder-failure-cleaned",
  }[report.scenario];
  assert.equal(report.failureMode?.outcome, expectedOutcome, `${label}: failure outcome mismatch`);
  assert.equal(report.failureMode?.partialArtifactsRemoved, true, `${label}: failure cleanup must pass`);
  assert.ok(report.failureMode?.userFacingErrorContract?.trim(), `${label}: recovery message contract is required`);
  assert.equal(report.cleanup?.partialArtifactsRemoved, true, `${label}: cleanup must pass`);
  assert.deepEqual(report.cleanup?.retainedArtifacts, [], `${label}: failure scenario retained artifacts`);
}

function verifyManifest(manifest, manifestPath) {
  const label = basename(manifestPath);
  assert.equal(manifest.schema, MANIFEST_SCHEMA, `${label}: manifest schema mismatch`);
  assert.equal(manifest.issue, 8, `${label}: issue must be 8`);
  assert.ok(manifest.decisionRationale?.trim(), `${label}: decision rationale is required`);
  assert.match(manifest.binarySha256 ?? "", /^[A-F0-9]{64}$/, `${label}: release binary SHA-256 is required`);
  assertNoPrivateMarkers(manifest, label);
  assert.ok(Array.isArray(manifest.reports), `${label}: reports must be an array`);
  const baseDir = dirname(resolve(manifestPath));
  const ids = new Set();
  const paths = new Set();
  const runs = new Set();
  const roles = new Map();

  for (const entry of manifest.reports) {
    assert.ok(entry.id && !ids.has(entry.id), `${label}: duplicate or missing report id`);
    ids.add(entry.id);
    assert.equal(REQUIRED_ROLES.get(entry.role), entry.scenario, `${label}:${entry.id}: role/scenario mismatch`);
    const reportPath = resolve(baseDir, entry.path);
    assert.ok(!paths.has(reportPath.toLowerCase()), `${label}: report path reused`);
    paths.add(reportPath.toLowerCase());
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    verifyReport(report, entry.scenario, `${label}:${entry.id}`);
    assert.deepEqual(report.applicationBuild, manifest.applicationBuild, `${label}:${entry.id}: build identity mismatch`);
    const fingerprint = JSON.stringify([report.startedAt, report.completedAt, report.command]);
    assert.ok(!runs.has(fingerprint), `${label}:${entry.id}: duplicate run evidence`);
    runs.add(fingerprint);
    roles.set(entry.role, (roles.get(entry.role) ?? 0) + 1);
  }
  for (const role of REQUIRED_ROLES.keys()) {
    assert.equal(roles.get(role), 1, `${label}: role ${role} requires exactly one independent run`);
  }
}

function assertNoPrivateMarkers(value, label) {
  const serialized = JSON.stringify(value);
  for (const marker of PRIVATE_MARKERS) {
    assert.ok(!marker.test(serialized), `${label}: contains private marker ${marker}`);
  }
}

function syntheticReport(scenario = "hdr-pq-block") {
  return {
    schema: REPORT_SCHEMA,
    issue: 8,
    startedAt: "unix-ms-1",
    completedAt: "unix-ms-2",
    command: ["native_decode_spike.exe", "--scenario", scenario],
    scenario,
    result: "passed",
    errorMessage: null,
    applicationBuild: { name: "gamebook", version: "0.5.3", sourceRevision: "abcdef0", profile: "release" },
    sourceArtifact: null,
    outputBytes: null,
    timeline: null,
    video: null,
    color: null,
    hdr: { primaries: "bt2020", transfer: "pq", blocked: true, reason: "Requires tone mapping.", toneMapped: false, outputCreated: false },
    failureMode: null,
    cleanup: { partialArtifactsRemoved: true, retainedArtifacts: [] },
    accessibility: { interactiveUi: false, productionAnnouncementContract: "Announce the blocked operation in text." },
    privacy: { syntheticInputOnly: true, networkAccess: false, projectWrites: false, mediaBytesInReport: false, localPathsInReport: false },
    environment: { os: "windows", arch: "x86_64", windowsCrateVersion: "0.61.3" },
  };
}

function runSelfTest() {
  verifyReport(syntheticReport());
  const hlg = syntheticReport("hdr-hlg-block");
  hlg.hdr.transfer = "hlg";
  verifyReport(hlg);
  assert.throws(() => verifyReport({ ...syntheticReport(), result: "failed" }));
  assert.throws(() => verifyReport({ ...syntheticReport(), privacy: { ...syntheticReport().privacy, networkAccess: true } }));
  assert.throws(() => verifyReport({ ...syntheticReport(), command: ["C:\\Users\\name\\spike.exe"] }));
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.selfTest) {
    runSelfTest();
    console.log("Native decode verifier self-test passed.");
    return;
  }
  if (options.manifest) {
    verifyManifest(JSON.parse(readFileSync(options.manifest, "utf8")), options.manifest);
    console.log(`Verified native decode evidence manifest ${options.manifest}`);
    return;
  }
  assert.ok(options.reports.length > 0, "At least one report path is required. Use --help for usage.");
  for (const path of options.reports) {
    verifyReport(JSON.parse(readFileSync(path, "utf8")), options.scenario, basename(path));
    console.log(`Verified ${path}`);
  }
}

main();
