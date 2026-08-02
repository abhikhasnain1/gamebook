import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

const REPORT_SCHEMA = "gamebook.zip64-lazy-materialization-spike.v1";
const MANIFEST_SCHEMA = "gamebook.zip64-lazy-materialization-evidence-manifest.v1";
const ONE_GIB = 1024 ** 3;
const FIVE_GIB = 5 * ONE_GIB;
const OPEN_MEMORY_LIMIT = 256 * 1024 ** 2;
const REQUIRED_ROLES = new Map([
  ["open-1gb", "open-1gb"],
  ["open-5gb", "open-5gb"],
  ["materialize-selected", "materialize-selected"],
  ["digest-failure", "digest-failure"],
  ["checksum-failure", "checksum-failure"],
  ["cancellation", "cancellation"],
  ["malformed", "malformed"],
  ["traversal", "traversal"],
  ["case-duplicate", "case-duplicate"],
  ["oversized-json", "oversized-json"],
  ["decompression-bomb", "decompression-bomb"],
]);
const REJECTION_CLASSES = new Map([
  ["malformed", "malformed-archive"],
  ["traversal", "unsafe-entry-name"],
  ["case-duplicate", "case-insensitive-duplicate"],
  ["oversized-json", "record-size-limit"],
  ["decompression-bomb", "record-size-limit"],
]);
const MATERIALIZATION_OUTCOMES = new Map([
  ["materialize-selected", "materialized"],
  ["digest-failure", "digest-mismatch"],
  ["checksum-failure", "archive-checksum-failure"],
  ["cancellation", "cancelled"],
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
  console.log("verify-zip64-lazy-materialization-report [--scenario NAME] REPORT...");
  console.log("verify-zip64-lazy-materialization-report --manifest MANIFEST");
  console.log("verify-zip64-lazy-materialization-report --self-test");
}

function verifyReport(report, expectedScenario, label = "report") {
  assert.equal(report.schema, REPORT_SCHEMA, `${label}: report schema mismatch`);
  assert.equal(report.issue, 14, `${label}: issue must be 14`);
  assert.equal(report.result, "passed", `${label}: result must be passed`);
  assert.equal(report.errorMessage, null, `${label}: passed report cannot contain an error`);
  assert.ok(report.startedAt && report.completedAt, `${label}: timestamps are required`);
  assert.ok(Array.isArray(report.command) && report.command.length >= 7, `${label}: redacted command is required`);
  assert.equal(report.command[0], "zip64_lazy_materialization_spike.exe", `${label}: executable must be redacted`);
  assert.equal(report.scenario, expectedScenario ?? report.scenario, `${label}: scenario mismatch`);
  assert.equal(report.command[2], report.scenario, `${label}: command scenario mismatch`);
  assert.equal(report.applicationBuild?.name, "gamebook", `${label}: application name mismatch`);
  assert.equal(report.applicationBuild?.version, "0.5.3", `${label}: compatibility version mismatch`);
  assert.match(report.applicationBuild?.sourceRevision ?? "", /^[a-zA-Z0-9._-]{7,128}$/, `${label}: source revision is invalid`);
  assert.ok(["debug", "release"].includes(report.applicationBuild?.profile), `${label}: profile is invalid`);
  verifySecurity(report, label);
  verifyCompatibility(report, label);
  verifyPrivacy(report, label);
  verifyAccessibility(report, label);
  assert.equal(report.cleanup?.partialOutputs, 0, `${label}: partial outputs must be zero`);
  assert.equal(report.cleanup?.materializedOutputs, 0, `${label}: retained materialized outputs must be zero`);

  if (report.scenario === "open-1gb" || report.scenario === "open-5gb") {
    verifyOpen(report, label);
  } else if (MATERIALIZATION_OUTCOMES.has(report.scenario)) {
    verifyMaterialization(report, label);
  } else if (REJECTION_CLASSES.has(report.scenario)) {
    verifyRejection(report, label);
  } else {
    assert.fail(`${label}: unsupported scenario ${report.scenario}`);
  }
  assertNoPrivateMarkers(report, label);
}

function verifySecurity(report, label) {
  const security = report.security ?? {};
  for (const key of [
    "relativePosixNames",
    "absoluteDriveTraversalNulAdsRejected",
    "caseInsensitiveDuplicatesRejected",
    "linksAndSpecialEntriesRejected",
    "workspaceReparseRejected",
    "declaredAndActualLimits",
    "sha256BeforeVisibility",
    "temporaryCreateNew",
    "tokenBoundToWorkspaceDigestOperationAndExpiry",
  ]) {
    assert.equal(security[key], true, `${label}: security.${key} must be true`);
  }
  assert.equal(security.entryCountLimit, 250000, `${label}: entry-count limit mismatch`);
  assert.equal(security.manifestRecordLimitBytes, 16 * 1024 ** 2, `${label}: JSON limit mismatch`);
  assert.equal(security.previewLimitBytes, 32 * 1024 ** 2, `${label}: preview limit mismatch`);
  assert.equal(security.opaqueTokenBits, 256, `${label}: token strength mismatch`);
}

function verifyCompatibility(report, label) {
  assert.equal(report.compatibility?.productionCommandsChanged, false, `${label}: production commands changed`);
  assert.equal(report.compatibility?.productionSchemaChanged, false, `${label}: production schema changed`);
  assert.equal(report.compatibility?.version1ProjectChanged, false, `${label}: version 1 changed`);
  assert.equal(report.compatibility?.screenshotBehaviorChanged, false, `${label}: screenshot behavior changed`);
}

function verifyPrivacy(report, label) {
  assert.equal(report.privacy?.syntheticInputOnly, true, `${label}: inputs must be synthetic`);
  assert.equal(report.privacy?.networkAccess, false, `${label}: network access must be false`);
  assert.equal(report.privacy?.projectWrites, false, `${label}: project writes must be false`);
  assert.equal(report.privacy?.mediaBytesInReport, false, `${label}: report cannot contain media`);
  assert.equal(report.privacy?.localPathsInReport, false, `${label}: report cannot contain local paths`);
  assert.equal(report.privacy?.tokensInReport, false, `${label}: report cannot contain tokens`);
}

function verifyAccessibility(report, label) {
  assert.equal(report.accessibility?.interactiveUi, false, `${label}: native spike must be noninteractive`);
  assert.equal(report.accessibility?.semanticReviewSurface, "archive-materialization-harness", `${label}: semantic review surface mismatch`);
  assert.match(report.accessibility?.productionAnnouncementContract ?? "", /open.*progress.*cancellation.*validation failure.*recovery.*successful materialization/i, `${label}: announcement contract incomplete`);
}

function verifyFixture(fixture, minimumBytes, requireZip64, label) {
  assert.ok(fixture && typeof fixture === "object", `${label}: fixture is required`);
  assert.ok(fixture.archiveBytes >= minimumBytes, `${label}: archive is below required size`);
  assert.ok(fixture.logicalUncompressedBytes >= minimumBytes, `${label}: logical project is below required size`);
  assert.ok(fixture.allocatedBytes > 0 && fixture.allocatedBytes < fixture.archiveBytes, `${label}: fixture must prove sparse allocation`);
  assert.equal(fixture.sparse, true, `${label}: sparse fixture flag missing`);
  assert.equal(fixture.zip64Required, requireZip64, `${label}: ZIP64 classification mismatch`);
  assert.equal(fixture.entryCount, 4, `${label}: fixture entry count mismatch`);
  assert.equal(fixture.selectedEntry, "asset:selected", `${label}: selected entry must be redacted`);
  assert.equal(fixture.largeEntry, "asset:large", `${label}: large entry must be redacted`);
  assert.match(fixture.selectedDigest ?? "", /^[a-f0-9]{64}$/, `${label}: selected digest invalid`);
  assert.equal(fixture.selectedBytes, 4 * 1024 ** 2, `${label}: selected fixture size mismatch`);
  assert.ok(Number.isInteger(fixture.creationMs) && fixture.creationMs >= 0, `${label}: creation timing missing`);
}

function verifyOpen(report, label) {
  const fiveGb = report.scenario === "open-5gb";
  verifyFixture(report.fixture, fiveGb ? FIVE_GIB : ONE_GIB, fiveGb, label);
  const open = report.open ?? {};
  assert.equal(open.passed, true, `${label}: open gate failed`);
  assert.ok(open.additionalPrivateBytes >= 0 && open.additionalPrivateBytes < OPEN_MEMORY_LIMIT, `${label}: open memory threshold failed`);
  assert.equal(open.memoryLimitBytes, OPEN_MEMORY_LIMIT, `${label}: memory limit mismatch`);
  assert.equal(open.assetPayloadsOpened, 0, `${label}: asset payload was opened`);
  assert.equal(open.mediaExtractionBytes, 0, `${label}: media bytes were extracted`);
  assert.equal(open.materializedAssetCount, 0, `${label}: asset was materialized`);
  assert.equal(open.centralDirectoryAndSelectedRecordsOnly, true, `${label}: lazy-open assertion failed`);
  assert.ok(open.bytesRead > 0 && open.bytesRead < 1024 ** 2, `${label}: open read volume is implausible`);
  assert.ok(open.assetRangeReadAheadBytes >= 0 && open.assetRangeReadAheadBytes < 4096, `${label}: parser read-ahead is excessive`);
  assert.ok(open.recordBytesRead > 0, `${label}: initial records were not read`);
  assert.equal(open.entryCount, 4, `${label}: open entry count mismatch`);
  assert.equal(open.initialRecordCount, 1, `${label}: initial record count mismatch`);
  assert.equal(report.cleanup?.fixtureRemoved, true, `${label}: fixture cleanup failed`);
}

function verifyMaterialization(report, label) {
  verifyFixture(report.fixture, 64 * 1024 ** 2, false, label);
  const materialization = report.materialization ?? {};
  const expectedOutcome = MATERIALIZATION_OUTCOMES.get(report.scenario);
  assert.equal(materialization.expectedOutcome, expectedOutcome, `${label}: expected outcome mismatch`);
  assert.equal(materialization.actualOutcome, expectedOutcome, `${label}: actual outcome mismatch`);
  assert.equal(materialization.passed, true, `${label}: materialization gate failed`);
  assert.equal(materialization.selectedAssetBytes, 4 * 1024 ** 2, `${label}: selected size mismatch`);
  assert.equal(materialization.onlySelectedAssetRequested, true, `${label}: nonselected asset was requested`);
  assert.equal(materialization.largeAssetRequested, false, `${label}: large asset was requested`);
  assert.equal(materialization.projectedSpaceChecked, true, `${label}: free-space check missing`);
  assert.ok(materialization.availableBytesBefore > materialization.selectedAssetBytes, `${label}: invalid free-space evidence`);
  assert.equal(materialization.temporaryOutputUsed, true, `${label}: temporary output was not used`);
  assert.equal(materialization.partialOutputRemoved, true, `${label}: partial output remains`);
  assert.equal(materialization.tokenContainsPath, false, `${label}: token exposed a path`);
  assert.equal(materialization.tokenPersisted, false, `${label}: token was persisted`);
  if (report.scenario === "materialize-selected") {
    assert.equal(materialization.bytesWritten, materialization.selectedAssetBytes, `${label}: materialized byte count mismatch`);
    assert.equal(materialization.finalVisibleOnlyAfterDigest, true, `${label}: verified output was not exposed`);
    assert.equal(materialization.tokenBits, 256, `${label}: token strength mismatch`);
    assert.equal(materialization.tokenWorkspaceBound, true, `${label}: token is not workspace-bound`);
    assert.equal(materialization.tokenDigestBound, true, `${label}: token is not digest-bound`);
    assert.equal(materialization.tokenOperation, "read", `${label}: token is not read-only`);
    assert.equal(materialization.tokenTtlSeconds, 600, `${label}: token lifetime mismatch`);
    assert.equal(materialization.workspaceFilesBeforeCleanup, 1, `${label}: workspace must contain only selected output`);
  } else {
    assert.equal(materialization.finalVisibleOnlyAfterDigest, false, `${label}: failed output became visible`);
    assert.equal(materialization.tokenBits, 0, `${label}: failed output received a token`);
    assert.equal(materialization.workspaceFilesBeforeCleanup, 0, `${label}: failed output remains`);
  }
  assert.equal(report.cleanup?.fixtureRemoved, true, `${label}: fixture cleanup failed`);
  assert.equal(report.cleanup?.workspaceRemoved, true, `${label}: workspace cleanup failed`);
}

function verifyRejection(report, label) {
  const validation = report.validation ?? {};
  const expectedClass = REJECTION_CLASSES.get(report.scenario);
  assert.equal(validation.expectedClass, expectedClass, `${label}: expected rejection class mismatch`);
  assert.equal(validation.actualClass, expectedClass, `${label}: actual rejection class mismatch`);
  assert.equal(validation.accepted, false, `${label}: malformed fixture was accepted`);
  assert.equal(validation.canonicalRecordsChanged, false, `${label}: rejection changed records`);
  assert.equal(validation.outputExposed, false, `${label}: rejection exposed output`);
  assert.equal(validation.passed, true, `${label}: rejection gate failed`);
  assert.equal(report.cleanup?.fixtureRemoved, true, `${label}: fixture cleanup failed`);
}

function verifyManifest(manifest, manifestPath) {
  const label = basename(manifestPath);
  assert.equal(manifest.schema, MANIFEST_SCHEMA, `${label}: manifest schema mismatch`);
  assert.equal(manifest.issue, 14, `${label}: issue must be 14`);
  assert.equal(manifest.applicationBuild?.name, "gamebook", `${label}: application name mismatch`);
  assert.equal(manifest.applicationBuild?.version, "0.5.3", `${label}: version mismatch`);
  assert.equal(manifest.applicationBuild?.profile, "release", `${label}: evidence must use a release build`);
  assert.match(manifest.applicationBuild?.sourceRevision ?? "", /^[a-f0-9]{40}$/, `${label}: exact source revision required`);
  assert.match(manifest.binary?.sha256 ?? "", /^[A-F0-9]{64}$/, `${label}: binary SHA-256 required`);
  assert.ok(Number.isInteger(manifest.binary?.bytes) && manifest.binary.bytes > 0, `${label}: binary byte count required`);
  assert.ok(Array.isArray(manifest.reports), `${label}: reports must be an array`);
  assert.equal(manifest.reports.length, REQUIRED_ROLES.size, `${label}: report count mismatch`);
  const baseDir = dirname(resolve(manifestPath));
  const binaryPath = resolve(baseDir, manifest.binary.path);
  verifyArtifact(binaryPath, manifest.binary.bytes, manifest.binary.sha256, `${label}:binary`);

  const roles = new Map();
  const runFingerprints = new Set();
  for (const entry of manifest.reports) {
    assert.ok(REQUIRED_ROLES.has(entry.role), `${label}: unknown role ${entry.role}`);
    const reportPath = resolve(baseDir, entry.path);
    const bytes = readFileSync(reportPath);
    assert.equal(hash(bytes), entry.sha256, `${label}:${entry.id}: report SHA-256 mismatch`);
    const report = JSON.parse(bytes.toString("utf8"));
    verifyReport(report, REQUIRED_ROLES.get(entry.role), `${label}:${entry.id}`);
    assert.equal(report.applicationBuild.sourceRevision, manifest.applicationBuild.sourceRevision, `${label}:${entry.id}: source revision mismatch`);
    assert.equal(report.applicationBuild.profile, "release", `${label}:${entry.id}: report must use release profile`);
    const fingerprint = JSON.stringify([report.startedAt, report.completedAt, report.command]);
    assert.ok(!runFingerprints.has(fingerprint), `${label}:${entry.id}: duplicate run evidence`);
    runFingerprints.add(fingerprint);
    roles.set(entry.role, (roles.get(entry.role) ?? 0) + 1);
  }
  for (const role of REQUIRED_ROLES.keys()) {
    assert.equal(roles.get(role), 1, `${label}: role ${role} requires one report`);
  }
  assertNoPrivateMarkers(manifest, label);
}

function verifyArtifact(path, expectedBytes, expectedHash, label) {
  const bytes = readFileSync(path);
  assert.equal(bytes.length, expectedBytes, `${label}: byte count mismatch`);
  assert.equal(hash(bytes), expectedHash, `${label}: SHA-256 mismatch`);
}

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

function assertNoPrivateMarkers(value, label) {
  const serialized = JSON.stringify(value);
  for (const marker of PRIVATE_MARKERS) {
    assert.ok(!marker.test(serialized), `${label}: contains private marker ${marker}`);
  }
}

function syntheticReport(scenario = "open-5gb") {
  const report = {
    schema: REPORT_SCHEMA,
    issue: 14,
    startedAt: "unix-ms-1",
    completedAt: "unix-ms-2",
    command: ["zip64_lazy_materialization_spike.exe", "--scenario", scenario, "--build-id", "abcdef0", "--run-id", `run-${scenario}`],
    scenario,
    result: "passed",
    errorMessage: null,
    applicationBuild: { name: "gamebook", version: "0.5.3", sourceRevision: "abcdef0", profile: "release" },
    fixture: null,
    open: null,
    materialization: null,
    validation: null,
    cleanup: { fixtureRemoved: true, workspaceRemoved: true, partialOutputs: 0, materializedOutputs: 0 },
    accessibility: { interactiveUi: false, semanticReviewSurface: "archive-materialization-harness", productionAnnouncementContract: "Announce open, progress, cancellation, validation failure, recovery, and successful materialization without exposing local paths." },
    security: { relativePosixNames: true, absoluteDriveTraversalNulAdsRejected: true, caseInsensitiveDuplicatesRejected: true, linksAndSpecialEntriesRejected: true, workspaceReparseRejected: true, declaredAndActualLimits: true, entryCountLimit: 250000, manifestRecordLimitBytes: 16 * 1024 ** 2, previewLimitBytes: 32 * 1024 ** 2, sha256BeforeVisibility: true, temporaryCreateNew: true, opaqueTokenBits: 256, tokenBoundToWorkspaceDigestOperationAndExpiry: true },
    compatibility: { productionCommandsChanged: false, productionSchemaChanged: false, version1ProjectChanged: false, screenshotBehaviorChanged: false },
    privacy: { syntheticInputOnly: true, networkAccess: false, projectWrites: false, mediaBytesInReport: false, localPathsInReport: false, tokensInReport: false },
  };
  if (scenario.startsWith("open-")) {
    const fiveGb = scenario === "open-5gb";
    report.fixture = syntheticFixture(fiveGb ? FIVE_GIB : ONE_GIB, fiveGb);
    report.open = { elapsedMs: 10, privateBytesBefore: 10, privateBytesPeak: 20, privateBytesAfter: 15, additionalPrivateBytes: 10, memoryLimitBytes: OPEN_MEMORY_LIMIT, bytesRead: 2000, recordBytesRead: 400, assetRangeReadAheadBytes: 620, assetPayloadsOpened: 0, mediaExtractionBytes: 0, materializedAssetCount: 0, entryCount: 4, initialRecordCount: 1, centralDirectoryAndSelectedRecordsOnly: true, passed: true };
  } else if (MATERIALIZATION_OUTCOMES.has(scenario)) {
    const success = scenario === "materialize-selected";
    report.fixture = syntheticFixture(64 * 1024 ** 2, false);
    report.open = { elapsedMs: 5, additionalPrivateBytes: 10, assetRangeReadAheadBytes: 620, assetPayloadsOpened: 0, mediaExtractionBytes: 0 };
    report.materialization = { expectedOutcome: MATERIALIZATION_OUTCOMES.get(scenario), actualOutcome: MATERIALIZATION_OUTCOMES.get(scenario), elapsedMs: 20, selectedAssetBytes: 4 * 1024 ** 2, bytesWritten: success ? 4 * 1024 ** 2 : 2 * 1024 ** 2, onlySelectedAssetRequested: true, largeAssetRequested: false, projectedSpaceChecked: true, availableBytesBefore: ONE_GIB, temporaryOutputUsed: true, finalVisibleOnlyAfterDigest: success, partialOutputRemoved: true, tokenBits: success ? 256 : 0, tokenContainsPath: false, tokenPersisted: false, tokenWorkspaceBound: success, tokenDigestBound: success, tokenOperation: success ? "read" : "none", tokenTtlSeconds: success ? 600 : 0, workspaceFilesBeforeCleanup: success ? 1 : 0, passed: true };
  } else {
    report.validation = { expectedClass: REJECTION_CLASSES.get(scenario), actualClass: REJECTION_CLASSES.get(scenario), accepted: false, canonicalRecordsChanged: false, outputExposed: false, passed: true };
  }
  return report;
}

function syntheticFixture(size, zip64) {
  return { archiveBytes: size + 1000, allocatedBytes: 4 * 1024 ** 2, logicalUncompressedBytes: size + 500, entryCount: 4, selectedEntry: "asset:selected", selectedDigest: "a".repeat(64), selectedBytes: 4 * 1024 ** 2, largeEntry: "asset:large", zip64Required: zip64, sparse: true, creationMs: 100 };
}

function runSelfTest() {
  for (const scenario of REQUIRED_ROLES.values()) {
    verifyReport(syntheticReport(scenario), scenario, scenario);
  }
  assert.throws(() => verifyReport({ ...syntheticReport(), result: "failed" }));
  const extracted = syntheticReport();
  extracted.open.mediaExtractionBytes = 1;
  assert.throws(() => verifyReport(extracted));
  const exposed = syntheticReport("digest-failure");
  exposed.materialization.finalVisibleOnlyAfterDigest = true;
  assert.throws(() => verifyReport(exposed));
  const pathLeakReport = syntheticReport();
  pathLeakReport.debugPath = "C:\\Users\\name\\archive.gamebook";
  assert.throws(() => verifyReport(pathLeakReport));
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.selfTest) {
    runSelfTest();
    console.log("ZIP64 lazy materialization verifier self-test passed.");
    return;
  }
  if (options.manifest) {
    verifyManifest(JSON.parse(readFileSync(options.manifest, "utf8")), options.manifest);
    console.log(`Verified ZIP64 lazy materialization evidence manifest ${options.manifest}`);
    return;
  }
  assert.ok(options.reports.length > 0, "At least one report path is required. Use --help for usage.");
  for (const path of options.reports) {
    verifyReport(JSON.parse(readFileSync(path, "utf8")), options.scenario, basename(path));
    console.log(`Verified ${path}`);
  }
}

main();
