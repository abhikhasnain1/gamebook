import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const REPORT_SCHEMA = "gamebook.streamed-save-spike.v1";
const MANIFEST_SCHEMA = "gamebook.streamed-save-evidence-manifest.v1";
const FIVE_GIB = 5 * 1024 ** 3;
const NEW_ASSET_BYTES = 16 * 1024 ** 2;
const MEMORY_LIMIT = 512 * 1024 ** 2;
const REQUIRED_ROLES = new Set([
  "first-save-local",
  "replacement-local",
  "replacement-onedrive",
  "cancellation",
  "low-space",
  "write-failure",
  "corruption",
  "forced-termination",
]);
const SUCCESS_ROLES = new Set(["first-save-local", "replacement-local", "replacement-onedrive"]);

function parseArgs(args) {
  const options = { reports: [], scenario: undefined, manifest: undefined, selfTest: false };
  for (let index = 0; index < args.length; index += 1) {
    switch (args[index]) {
      case "--scenario":
        options.scenario = args[++index];
        break;
      case "--manifest":
        options.manifest = args[++index];
        break;
      case "--self-test":
        options.selfTest = true;
        break;
      case "--help":
      case "-h":
        console.log("verify-streamed-save-report [--scenario NAME] REPORT...");
        console.log("verify-streamed-save-report --manifest MANIFEST");
        console.log("verify-streamed-save-report --self-test");
        process.exit(0);
        break;
      default:
        options.reports.push(args[index]);
    }
  }
  return options;
}

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

function verifyReport(report, expectedScenario, label = "report") {
  assert.equal(report.schema, REPORT_SCHEMA, `${label}: report schema mismatch`);
  assert.equal(report.issue, 16, `${label}: issue must be 16`);
  assert.equal(report.result, "passed", `${label}: result must be passed`);
  assert.equal(report.errorMessage, null, `${label}: passed report cannot contain an error`);
  assert.ok(report.startedAt && report.completedAt, `${label}: timestamps are required`);
  assert.equal(report.scenario, expectedScenario ?? report.scenario, `${label}: scenario mismatch`);
  assert.ok(REQUIRED_ROLES.has(report.scenario), `${label}: unsupported scenario`);
  assert.equal(report.command?.[0], "streamed_save_spike.exe", `${label}: executable must be redacted`);
  assert.equal(report.command?.[2], report.scenario, `${label}: command scenario mismatch`);
  assert.equal(report.applicationBuild?.name, "gamebook", `${label}: application name mismatch`);
  assert.equal(report.applicationBuild?.version, "0.5.3", `${label}: compatibility version mismatch`);
  assert.match(report.applicationBuild?.sourceRevision ?? "", /^[a-zA-Z0-9._-]{7,160}$/, `${label}: source revision is invalid`);
  assert.ok(["debug", "release"].includes(report.applicationBuild?.profile), `${label}: profile is invalid`);
  verifyEnvironment(report, label);
  verifySecurity(report, label);
  verifyAccessibility(report, label);
  verifyCompatibility(report, label);
  verifyPrivacy(report, label);
  verifyScenario(report, label);
  assert.equal(report.cleanup?.runRootRemoved, true, `${label}: run root cleanup failed`);
  assert.equal(report.cleanup?.partialOutputs, 0, `${label}: partial outputs remain`);
  assert.equal(report.cleanup?.replacementArchivesRetained, 0, `${label}: replacement archive remains`);
  assert.equal(report.cleanup?.priorProjectDeletedOnFailure, false, `${label}: prior project was deleted on failure`);
  assertNoPrivateMarkers(report, label);
}

function verifyEnvironment(report, label) {
  const environment = report.environment ?? {};
  assert.equal(environment.os, "windows", `${label}: Windows evidence is required`);
  assert.match(environment.windowsRelease ?? "", /^\d+\.\d+\.\d+$/, `${label}: Windows release is required`);
  assert.ok(typeof environment.cpuModel === "string" && environment.cpuModel.length >= 3, `${label}: CPU model is required`);
  assert.ok(environment.logicalProcessors > 0, `${label}: logical processor count is required`);
  assert.ok(environment.totalMemoryBytes > 0, `${label}: system memory is required`);
  assert.equal(environment.filesystem, "NTFS", `${label}: NTFS evidence is required`);
  assert.equal(environment.storageHealth, "healthy", `${label}: storage health is required`);
  assert.equal(environment.zipCrateVersion, "8.6.0", `${label}: ZIP dependency mismatch`);
  if (report.scenario === "replacement-onedrive") {
    assert.equal(environment.storageMode, "onedrive-managed-ntfs", `${label}: OneDrive storage mode mismatch`);
    assert.equal(environment.oneDriveState, "managed-path", `${label}: OneDrive managed-path evidence is required`);
  } else {
    assert.equal(environment.storageMode, "local-ntfs", `${label}: local NTFS storage mode mismatch`);
  }
}

function verifySecurity(report, label) {
  for (const key of [
    "destinationLeafValidated",
    "temporaryIsExclusiveSibling",
    "sameVolumeReplacement",
    "sourceArchiveNamesValidated",
    "validationBeforeVisibility",
    "priorProjectPreservedOnFailure",
    "partialReplacementUnreferenced",
  ]) {
    assert.equal(report.security?.[key], true, `${label}: security.${key} must be true`);
  }
  assert.equal(report.security?.manifestRecordLimitBytes, 16 * 1024 ** 2, `${label}: manifest limit mismatch`);
  assert.equal(report.security?.frontendFilesystemAccess, false, `${label}: frontend filesystem access changed`);
}

function verifyAccessibility(report, label) {
  assert.equal(report.accessibility?.interactiveUi, false, `${label}: native spike must be noninteractive`);
  assert.equal(report.accessibility?.semanticReviewSurface, "streamed-save-harness", `${label}: semantic surface mismatch`);
  assert.match(report.accessibility?.productionAnnouncementContract ?? "", /save estimate.*progress.*cancellation.*external-change choices.*validation errors.*recovery.*success.*failure/i, `${label}: announcement contract is incomplete`);
}

function verifyCompatibility(report, label) {
  assert.equal(report.compatibility?.productionCommandsChanged, false, `${label}: production commands changed`);
  assert.equal(report.compatibility?.productionSchemaChanged, false, `${label}: production schema changed`);
  assert.equal(report.compatibility?.version1ProjectChanged, false, `${label}: version 1 changed`);
  assert.equal(report.compatibility?.screenshotBehaviorChanged, false, `${label}: screenshot behavior changed`);
}

function verifyPrivacy(report, label) {
  assert.equal(report.privacy?.syntheticInputOnly, true, `${label}: inputs must be synthetic`);
  assert.equal(report.privacy?.applicationNetworkAccess, false, `${label}: application network access changed`);
  assert.equal(report.privacy?.productionProjectWrites, false, `${label}: production project writes changed`);
  assert.equal(report.privacy?.localPathsInReport, false, `${label}: report contains local paths`);
  assert.equal(report.privacy?.projectTitlesInReport, false, `${label}: report contains project titles`);
  assert.equal(report.privacy?.mediaBytesInReport, false, `${label}: report contains media bytes`);
}

function verifyScenario(report, label) {
  const evidence = report.evidence ?? {};
  assert.equal(evidence.fixture?.kind, "synthetic-zip64-stored-media", `${label}: fixture kind mismatch`);
  assert.match(evidence.fixture?.mediaEntryDigest ?? "", /^[a-f0-9]{64}$/, `${label}: fixture digest is invalid`);
  assert.equal(evidence.replacement?.passed, true, `${label}: replacement contract failed`);
  if (SUCCESS_ROLES.has(report.scenario)) {
    verifySuccess(report, label);
    return;
  }
  const save = evidence.save ?? {};
  assert.equal(save.passed, true, `${label}: failure recovery scenario failed`);
  assert.equal(evidence.replacement.attempted, false, `${label}: failed save attempted replacement`);
  assert.equal(evidence.replacement.priorProjectRetained, true, `${label}: prior project was not retained`);
  switch (report.scenario) {
    case "cancellation":
      assert.equal(evidence.outcome, "cancelled", `${label}: cancellation outcome mismatch`);
      assert.equal(save.errorClass, "save-cancelled", `${label}: cancellation class mismatch`);
      assert.equal(save.temporaryRemoved, true, `${label}: cancellation temporary remains`);
      break;
    case "low-space":
      assert.equal(evidence.outcome, "insufficient-space", `${label}: low-space outcome mismatch`);
      assert.equal(save.spaceCheckMode, "deterministic-injected-available-space", `${label}: low-space injection mismatch`);
      assert.ok(save.effectiveAvailableBytes < save.estimateBytes, `${label}: effective free space did not fail estimate`);
      assert.equal(save.temporaryCreated, false, `${label}: low-space created a temporary`);
      break;
    case "write-failure":
      assert.equal(evidence.outcome, "write-failure", `${label}: write-failure outcome mismatch`);
      assert.equal(save.errorClass, "simulated-write-failure", `${label}: write-failure class mismatch`);
      assert.equal(save.temporaryRemoved, true, `${label}: write-failure temporary remains`);
      break;
    case "corruption":
      assert.equal(evidence.outcome, "checksum-failure", `${label}: corruption outcome mismatch`);
      assert.ok(["crc-mismatch", "sha256-mismatch", "archive-validation-failure"].includes(save.validationErrorClass), `${label}: corruption class mismatch`);
      assert.equal(save.replacementRejectedBeforeVisibility, true, `${label}: corrupted output reached visibility`);
      assert.equal(save.temporaryRemoved, true, `${label}: corrupted temporary remains`);
      break;
    case "forced-termination":
      assert.equal(evidence.outcome, "forced-termination", `${label}: termination outcome mismatch`);
      assert.equal(save.childTerminated, true, `${label}: child was not terminated`);
      assert.equal(save.childExitSuccess, false, `${label}: terminated child exited successfully`);
      assert.ok(save.partialBytes >= save.checkpointBytes, `${label}: child did not write a partial replacement`);
      assert.equal(save.partialArchiveUnreferenced, true, `${label}: partial replacement was referenced`);
      assert.equal(save.temporaryRemovedAfterRecoveryReview, true, `${label}: partial replacement remains`);
      break;
    default:
      assert.fail(`${label}: unsupported failure scenario`);
  }
  assert.equal(save.priorProjectUnchanged, true, `${label}: prior project changed`);
  assert.equal(save.priorProjectValid, true, `${label}: prior project is invalid`);
}

function verifySuccess(report, label) {
  const { fixture, save, replacement } = report.evidence;
  assert.equal(report.evidence.outcome, "saved", `${label}: success outcome mismatch`);
  assert.ok(fixture.logicalArchiveBytes >= FIVE_GIB, `${label}: fixture is smaller than 5 GiB`);
  assert.equal(fixture.mediaBytes, FIVE_GIB, `${label}: media fixture size mismatch`);
  assert.equal(fixture.zip64Required, true, `${label}: fixture is not ZIP64`);
  assert.equal(save.memoryLimitBytes, MEMORY_LIMIT, `${label}: memory limit mismatch`);
  assert.ok(save.additionalPrivateBytes >= 0 && save.additionalPrivateBytes < MEMORY_LIMIT, `${label}: memory gate failed`);
  assert.equal(save.rawCopyApi, "zip::ZipWriter::raw_copy_file", `${label}: raw copy API mismatch`);
  assert.equal(save.rawCopiedEntries, 1, `${label}: raw copied entry count mismatch`);
  assert.equal(save.rawCopiedBytes, FIVE_GIB, `${label}: raw copied byte count mismatch`);
  assert.equal(save.rawCopiedCompression, "stored", `${label}: raw copied compression mismatch`);
  assert.equal(save.streamHashAlgorithm, "SHA-256", `${label}: stream hash algorithm mismatch`);
  assert.equal(save.streamHashedBytes, NEW_ASSET_BYTES, `${label}: stream hash byte count mismatch`);
  assert.equal(save.streamHashMatched, true, `${label}: streamed hash mismatch`);
  assert.equal(save.wholeProjectLoaded, false, `${label}: whole project was loaded`);
  assert.ok(save.boundedBufferBytes <= 1024 ** 2, `${label}: I/O buffer exceeds 1 MiB`);
  assert.equal(save.completeReplacementArchivesAtPeak, 1, `${label}: complete replacement archive count mismatch`);
  assert.equal(save.extraCompleteTemporaryCopies, 0, `${label}: extra complete temporary copy exists`);
  assert.equal(save.temporarySibling, true, `${label}: temporary is not a sibling`);
  assert.equal(save.temporaryCreateNew, true, `${label}: temporary was not exclusive`);
  assert.equal(save.temporaryFileFlushed, true, `${label}: temporary file was not flushed`);
  assert.equal(save.containingDirectoryFlushAttempted, true, `${label}: containing-directory flush was not attempted`);
  assert.equal(save.validation?.assetCount, 2, `${label}: validated asset count mismatch`);
  assert.equal(save.validation?.verifiedBytes, FIVE_GIB + NEW_ASSET_BYTES, `${label}: verified bytes mismatch`);
  assert.equal(save.validation?.zip64Required, true, `${label}: replacement is not ZIP64`);
  assert.equal(save.validation?.referencesSizesAndDigestsValid, true, `${label}: validation contract failed`);
  assert.equal(save.passed, true, `${label}: save gate failed`);
  assert.equal(replacement.writeThrough, true, `${label}: replacement was not write-through`);
  assert.equal(replacement.sameVolumeSibling, true, `${label}: replacement crossed a volume`);
  assert.equal(replacement.priorProjectValidUntilReplacement, true, `${label}: prior project invalid before replacement`);
  assert.equal(replacement.finalProjectValid, true, `${label}: final project invalid`);
  assert.equal(replacement.temporaryAbsentAfterSuccess, true, `${label}: temporary remains after replacement`);
  assert.equal(replacement.kind, report.scenario === "first-save-local" ? "MoveFileExW" : "ReplaceFileW", `${label}: Windows operation mismatch`);
}

function verifyManifest(manifestPath) {
  const manifestBytes = readFileSync(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const label = "manifest";
  assert.equal(manifest.schema, MANIFEST_SCHEMA, `${label}: schema mismatch`);
  assert.equal(manifest.issue, 16, `${label}: issue mismatch`);
  assert.equal(manifest.applicationBuild?.name, "gamebook", `${label}: app mismatch`);
  assert.equal(manifest.applicationBuild?.version, "0.5.3", `${label}: version mismatch`);
  assert.match(manifest.applicationBuild?.sourceRevision ?? "", /^[a-f0-9]{40}$/, `${label}: exact revision required`);
  assert.equal(manifest.applicationBuild?.profile, "release", `${label}: release profile required`);
  assert.match(manifest.binary?.sha256 ?? "", /^[A-F0-9]{64}$/, `${label}: binary hash invalid`);
  assert.ok(manifest.binary?.bytes > 0, `${label}: binary byte count invalid`);
  assert.equal(manifest.reports?.length, REQUIRED_ROLES.size, `${label}: report count mismatch`);
  const baseDir = dirname(resolve(manifestPath));
  const roles = new Set();
  const fingerprints = new Set();
  for (const entry of manifest.reports) {
    assert.ok(REQUIRED_ROLES.has(entry.role), `${label}: unknown role ${entry.role}`);
    assert.ok(!roles.has(entry.role), `${label}: duplicate role ${entry.role}`);
    const reportPath = resolve(baseDir, entry.path);
    const bytes = readFileSync(reportPath);
    assert.equal(hash(bytes), entry.sha256, `${label}:${entry.id}: report hash mismatch`);
    const report = JSON.parse(bytes.toString("utf8"));
    verifyReport(report, entry.role, `${label}:${entry.id}`);
    assert.equal(report.applicationBuild.sourceRevision, manifest.applicationBuild.sourceRevision, `${label}:${entry.id}: revision mismatch`);
    assert.equal(report.applicationBuild.profile, "release", `${label}:${entry.id}: release report required`);
    const fingerprint = JSON.stringify([report.startedAt, report.completedAt, report.command]);
    assert.ok(!fingerprints.has(fingerprint), `${label}:${entry.id}: duplicate evidence report`);
    fingerprints.add(fingerprint);
    roles.add(entry.role);
  }
  assert.deepEqual(roles, REQUIRED_ROLES, `${label}: role set mismatch`);
  assertNoPrivateMarkers(manifest, label);
}

function assertNoPrivateMarkers(value, label) {
  const serialized = JSON.stringify(value);
  for (const marker of [/[A-Za-z]:\\/, /\\Users\\/i, /file:\/\//i]) {
    assert.ok(!marker.test(serialized), `${label}: contains private marker ${marker}`);
  }
}

function syntheticReport(scenario) {
  const success = SUCCESS_ROLES.has(scenario);
  const save = success ? {
    elapsedMs: 10,
    privateBytesBefore: 100,
    privateBytesPeak: 200,
    privateBytesAfter: 150,
    additionalPrivateBytes: 100,
    memoryLimitBytes: MEMORY_LIMIT,
    estimateBytes: FIVE_GIB,
    availableBytesBefore: FIVE_GIB * 2,
    outputBytes: FIVE_GIB + NEW_ASSET_BYTES,
    allocatedOutputBytes: FIVE_GIB + NEW_ASSET_BYTES,
    rawCopyApi: "zip::ZipWriter::raw_copy_file",
    rawCopiedEntries: 1,
    rawCopiedBytes: FIVE_GIB,
    rawCopiedCompression: "stored",
    streamHashAlgorithm: "SHA-256",
    streamHashedBytes: NEW_ASSET_BYTES,
    streamHashMatched: true,
    wholeProjectLoaded: false,
    boundedBufferBytes: 1024 ** 2,
    completeReplacementArchivesAtPeak: 1,
    extraCompleteTemporaryCopies: 0,
    temporarySibling: true,
    temporaryCreateNew: true,
    temporaryFileFlushed: true,
    containingDirectoryFlushAttempted: true,
    containingDirectoryFlushSupported: false,
    validation: { elapsedMs: 10, assetCount: 2, verifiedBytes: FIVE_GIB + NEW_ASSET_BYTES, zip64Required: true, referencesSizesAndDigestsValid: true },
    passed: true,
  } : failureSave(scenario);
  return {
    schema: REPORT_SCHEMA,
    issue: 16,
    startedAt: "2026-08-03T00:00:00Z",
    completedAt: "2026-08-03T00:00:01Z",
    command: ["streamed_save_spike.exe", "--scenario", scenario, "--build-id", "abcdef1234567", "--run-id", `test-${scenario}`],
    scenario,
    result: "passed",
    errorMessage: null,
    applicationBuild: { name: "gamebook", version: "0.5.3", sourceRevision: "abcdef1234567", profile: "release" },
    environment: { os: "windows", windowsRelease: "10.0.26200", arch: "x86_64", cpuModel: "Reference CPU", logicalProcessors: 24, totalMemoryBytes: 64 * 1024 ** 3, filesystem: "NTFS", storageMode: scenario === "replacement-onedrive" ? "onedrive-managed-ntfs" : "local-ntfs", storageHealth: "healthy", oneDriveState: scenario === "replacement-onedrive" ? "managed-path" : "not-applicable", zipCrateVersion: "8.6.0" },
    evidence: {
      outcome: success ? "saved" : failureOutcome(scenario),
      fixture: { kind: "synthetic-zip64-stored-media", logicalArchiveBytes: success ? FIVE_GIB + 1000 : 64 * 1024 ** 2, allocatedSourceBytes: 4096, mediaBytes: success ? FIVE_GIB : 64 * 1024 ** 2, mediaEntry: "content-addressed-stored-media", mediaEntryClass: "content-addressed-stored-media", mediaEntryDigest: "a".repeat(64), entryCount: 3, zip64Required: success, creationMs: 1 },
      save,
      replacement: success ? { kind: scenario === "first-save-local" ? "MoveFileExW" : "ReplaceFileW", writeThrough: true, sameVolumeSibling: true, elapsedMs: 1, priorProjectValidUntilReplacement: true, finalProjectValid: true, preReplacementDigestValidationReusedAfterAtomicMove: true, temporaryAbsentAfterSuccess: true, passed: true } : { kind: "none", attempted: false, reason: "not-attempted", priorProjectRetained: true, passed: true },
    },
    security: { destinationLeafValidated: true, temporaryIsExclusiveSibling: true, sameVolumeReplacement: true, sourceArchiveNamesValidated: true, manifestRecordLimitBytes: 16 * 1024 ** 2, validationBeforeVisibility: true, priorProjectPreservedOnFailure: true, partialReplacementUnreferenced: true, frontendFilesystemAccess: false },
    accessibility: { interactiveUi: false, semanticReviewSurface: "streamed-save-harness", productionAnnouncementContract: "Announce Save estimate, progress, cancellation, external-change choices, validation errors, recovery, success, and failure." },
    compatibility: { productionCommandsChanged: false, productionSchemaChanged: false, version1ProjectChanged: false, screenshotBehaviorChanged: false },
    privacy: { syntheticInputOnly: true, applicationNetworkAccess: false, productionProjectWrites: false, localPathsInReport: false, projectTitlesInReport: false, mediaBytesInReport: false },
    cleanup: { runRootRemoved: true, partialOutputs: 0, replacementArchivesRetained: 0, priorProjectDeletedOnFailure: false },
  };
}

function failureOutcome(scenario) {
  return { cancellation: "cancelled", "low-space": "insufficient-space", "write-failure": "write-failure", corruption: "checksum-failure", "forced-termination": "forced-termination" }[scenario];
}

function failureSave(scenario) {
  const base = { priorProjectUnchanged: true, priorProjectValid: true, passed: true };
  if (scenario === "cancellation") return { ...base, errorClass: "save-cancelled", temporaryRemoved: true };
  if (scenario === "low-space") return { ...base, estimateBytes: 100, actualAvailableBytes: 1000, effectiveAvailableBytes: 99, spaceCheckMode: "deterministic-injected-available-space", temporaryCreated: false };
  if (scenario === "write-failure") return { ...base, errorClass: "simulated-write-failure", temporaryRemoved: true };
  if (scenario === "corruption") return { ...base, validationErrorClass: "crc-mismatch", replacementRejectedBeforeVisibility: true, temporaryRemoved: true };
  return { ...base, checkpointBytes: 8, partialBytes: 8, childTerminated: true, childExitSuccess: false, partialArchiveUnreferenced: true, temporaryRemovedAfterRecoveryReview: true };
}

function runSelfTest() {
  for (const scenario of REQUIRED_ROLES) verifyReport(syntheticReport(scenario), scenario, `self-test:${scenario}`);
  const badMemory = structuredClone(syntheticReport("replacement-local"));
  badMemory.evidence.save.additionalPrivateBytes = MEMORY_LIMIT;
  assert.throws(() => verifyReport(badMemory, "replacement-local"), /memory gate failed/);
  const badRecovery = structuredClone(syntheticReport("forced-termination"));
  badRecovery.evidence.save.priorProjectUnchanged = false;
  assert.throws(() => verifyReport(badRecovery, "forced-termination"), /prior project changed/);
  const badPrivacy = structuredClone(syntheticReport("cancellation"));
  badPrivacy.extra = "C:\\Users\\private\\project.gamebook";
  assert.throws(() => verifyReport(badPrivacy, "cancellation"), /private marker/);
  console.log("streamed Save verifier self-test passed");
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.selfTest) {
    runSelfTest();
    return;
  }
  if (options.manifest) {
    verifyManifest(options.manifest);
    console.log(`Verified streamed Save evidence manifest: ${options.manifest}`);
    return;
  }
  assert.ok(options.reports.length > 0, "At least one report path is required. Use --help for usage.");
  for (const path of options.reports) {
    verifyReport(JSON.parse(readFileSync(path, "utf8")), options.scenario, path);
    console.log(`Verified streamed Save report: ${path}`);
  }
}

main();
