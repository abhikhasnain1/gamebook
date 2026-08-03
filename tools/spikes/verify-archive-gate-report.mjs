import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_REFERENCE = resolve(root, "docs/spikes/archive-gate-reference-report.json");
const GATE_SCHEMA = "gamebook.archive-gate-reference.v1";

function parseArgs(args) {
  const options = { reference: undefined, selfTest: false };
  for (let index = 0; index < args.length; index += 1) {
    switch (args[index]) {
      case "--reference":
        options.reference = args[++index];
        break;
      case "--self-test":
        options.selfTest = true;
        break;
      case "--help":
      case "-h":
        console.log("verify-archive-gate-report --reference REFERENCE");
        console.log("verify-archive-gate-report --self-test");
        process.exit(0);
        break;
      default:
        assert.fail(`Unknown option: ${args[index]}`);
    }
  }
  return options;
}

function loadJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function sourceByIssue(reference, baseDir) {
  const sources = new Map();
  for (const retained of reference.sources ?? []) {
    assert.ok([14, 15, 16].includes(retained.issue), `reference: unexpected source issue ${retained.issue}`);
    assert.ok(!sources.has(retained.issue), `reference: duplicate source issue ${retained.issue}`);
    const path = resolve(baseDir, retained.path);
    const report = loadJson(path);
    assert.equal(report.schema, retained.schema, `reference:#${retained.issue}: schema mismatch`);
    assert.equal(report.status, retained.status, `reference:#${retained.issue}: status mismatch`);
    assert.equal(report.status, "passed", `reference:#${retained.issue}: source did not pass`);
    assert.equal(report.build?.sourceRevision, retained.sourceRevision, `reference:#${retained.issue}: revision mismatch`);
    assert.equal(report.build?.binarySha256, retained.binarySha256, `reference:#${retained.issue}: binary hash mismatch`);
    assert.equal(report.rawEvidence?.reportCount, retained.reportCount, `reference:#${retained.issue}: report count mismatch`);
    sources.set(retained.issue, report);
  }
  assert.deepEqual(new Set(sources.keys()), new Set([14, 15, 16]), "reference: source issue set mismatch");
  return sources;
}

function assertEqual(actual, expected, label) {
  assert.deepEqual(actual, expected, `reference:${label} mismatch`);
}

function verifyGate(reference, sources) {
  assert.equal(reference.schema, GATE_SCHEMA, "reference: schema mismatch");
  assert.equal(reference.status, "passed", "reference: gate must pass");
  assert.equal(reference.governingIssue, 17, "reference: governing issue mismatch");
  assert.equal(reference.recommendation?.container, "zip64", "reference: container recommendation mismatch");
  assert.equal(reference.recommendation?.decisionStatus, "proposed-for-milestone-5", "reference: decision status mismatch");
  assert.equal(reference.recommendation?.sqliteComparisonRequired, false, "reference: SQLite comparison must remain conditional");

  const lazy = sources.get(14);
  const workspace = sources.get(15);
  const streamed = sources.get(16);
  const open5 = lazy.metadataOpen.find((entry) => entry.scenario === "open-5gb");
  const selected = lazy.materialization.find((entry) => entry.scenario === "materialize-selected");
  const sameSource = workspace.identity.find((entry) => entry.scenario === "identity-same-source");
  const copied = workspace.identity.find((entry) => entry.scenario === "identity-copied-project");
  const liveLock = workspace.locks.find((entry) => entry.scenario === "live-lock");
  const freshLock = workspace.locks.find((entry) => entry.scenario === "dead-fresh-lock");
  const staleLock = workspace.locks.find((entry) => entry.scenario === "stale-lock-recovery");
  const malformedLock = workspace.locks.find((entry) => entry.scenario === "malformed-lock-recovery");
  const cache = workspace.cache.find((entry) => entry.scenario === "cache-eviction");
  const cacheCancellation = workspace.cache.find((entry) => entry.scenario === "eviction-cancellation");
  const firstSave = streamed.largeSaves.find((entry) => entry.scenario === "first-save-local");
  const localReplacement = streamed.largeSaves.find((entry) => entry.scenario === "replacement-local");
  const oneDriveReplacement = streamed.largeSaves.find((entry) => entry.scenario === "replacement-onedrive");

  assertEqual(reference.metadataOpen, {
    logicalArchiveBytes: open5.archiveBytes,
    allocatedFixtureBytes: open5.allocatedBytes,
    openMs: open5.openMs,
    additionalPrivateBytes: open5.additionalPrivateBytes,
    memoryLimitBytes: 256 * 1024 ** 2,
    assetPayloadsOpened: open5.assetPayloadsOpened,
    mediaExtractionBytes: open5.mediaExtractionBytes,
    materializedAssets: open5.materializedAssets,
    passed: open5.passed,
  }, "metadataOpen");
  assert.ok(reference.metadataOpen.additionalPrivateBytes < reference.metadataOpen.memoryLimitBytes, "reference: metadata memory gate failed");

  assertEqual(reference.selectedMaterialization, {
    bytesWritten: selected.bytesWritten,
    onlySelectedAssetRequested: selected.onlySelectedAssetRequested,
    largeAssetRequested: selected.largeAssetRequested,
    sha256BeforeVisibility: selected.finalVisibleOnlyAfterDigest,
    tokenBits: selected.tokenBits,
    partialOutputRemoved: selected.partialOutputRemoved,
    passed: selected.passed,
  }, "selectedMaterialization");

  assertEqual(reference.workspace, {
    sameSourceWorkspaceCount: sameSource.workspaceCount,
    copiedProjectWorkspaceCount: copied.workspaceCount,
    registryContainsSourcePaths: sameSource.registryContainsSourcePaths || copied.registryContainsSourcePaths,
    liveLockDisposition: liveLock.disposition,
    deadFreshLockDisposition: freshLock.disposition,
    staleLockDisposition: staleLock.disposition,
    malformedLockDisposition: malformedLock.disposition,
    externalChangePausedSave: workspace.externalChange.savePaused,
    externalChangeAutomaticReplacement: workspace.externalChange.automaticReplacement,
    externalChangeChoices: workspace.externalChange.choices,
    cleanCacheBytesBefore: cache.cleanCacheBytesBefore,
    cleanCacheBytesAfter: cache.cleanCacheBytesAfter,
    protectedEntriesRetained: cache.protectedEntriesRetained,
    reparseEscapeRejected: workspace.reparse.escapeRejected,
    passed: [sameSource, copied, liveLock, freshLock, staleLock, malformedLock, workspace.externalChange, cache, cacheCancellation, workspace.reparse].every((entry) => entry.passed),
  }, "workspace");

  const maximumAdditionalPrivateBytes = Math.max(...streamed.largeSaves.map((entry) => entry.additionalPrivateBytes));
  assertEqual(reference.streamedSave, {
    fixtureMediaBytes: streamed.fixture.mediaBytes,
    memoryLimitBytes: firstSave.memoryLimitBytes,
    maximumAdditionalPrivateBytes,
    rawCopiedBytes: firstSave.rawCopiedBytes,
    streamHashedBytes: firstSave.streamHashedBytes,
    verifiedAssetBytes: firstSave.verifiedAssetBytes,
    completeReplacementArchivesAtPeak: Math.max(...streamed.largeSaves.map((entry) => entry.completeReplacementArchivesAtPeak)),
    extraCompleteTemporaryCopies: Math.max(...streamed.largeSaves.map((entry) => entry.extraCompleteTemporaryCopies)),
    localFirstSaveMs: firstSave.elapsedMs,
    localReplacementMs: localReplacement.elapsedMs,
    oneDriveReplacementMs: oneDriveReplacement.elapsedMs,
    firstSaveOperation: firstSave.replacementKind,
    replacementOperation: localReplacement.replacementKind,
    oneDriveState: oneDriveReplacement.oneDriveState,
    passed: streamed.largeSaves.every((entry) => entry.passed),
  }, "streamedSave");
  assert.ok(reference.streamedSave.maximumAdditionalPrivateBytes < reference.streamedSave.memoryLimitBytes, "reference: Save memory gate failed");

  const lazyMaterialization = Object.fromEntries(lazy.materialization.map((entry) => [entry.scenario, entry]));
  const lazyValidation = Object.fromEntries(lazy.validation.map((entry) => [entry.scenario, entry]));
  const saveFailure = Object.fromEntries(streamed.failures.map((entry) => [entry.scenario, entry]));
  assertEqual(reference.failureAndRecovery, {
    materializationDigestFailurePassed: lazyMaterialization["digest-failure"].passed && lazyMaterialization["digest-failure"].partialOutputRemoved,
    materializationChecksumFailurePassed: lazyMaterialization["checksum-failure"].passed && lazyMaterialization["checksum-failure"].partialOutputRemoved,
    materializationCancellationPassed: lazyMaterialization.cancellation.passed && lazyMaterialization.cancellation.partialOutputRemoved,
    malformedArchiveRejected: lazyValidation.malformed.passed && !lazyValidation.malformed.canonicalRecordsChanged,
    parentTraversalRejected: lazyValidation.traversal.passed && !lazyValidation.traversal.outputExposed,
    caseInsensitiveDuplicateRejected: lazyValidation["case-duplicate"].passed && !lazyValidation["case-duplicate"].outputExposed,
    oversizedAndCompressedOversizedJsonRejected: lazyValidation["oversized-json"].passed && lazyValidation["decompression-bomb"].passed,
    staleAndMalformedLocksPreservedRecovery: staleLock.passed && staleLock.workspaceDeleted === false && malformedLock.passed && malformedLock.workspaceDeleted === false,
    externalChangePreservedPriorProject: workspace.externalChange.passed && workspace.externalChange.priorProjectIntact,
    cacheCancellationPreservedEntries: cacheCancellation.passed && cacheCancellation.cancellationPreservedAllEntries,
    saveCancellationPreservedPriorProject: saveFailure.cancellation.passed && saveFailure.cancellation.priorProjectUnchanged,
    lowSpaceRefusedBeforeTemporaryCreation: saveFailure["low-space"].passed && saveFailure["low-space"].temporaryCreated === false,
    writeFailurePreservedPriorProject: saveFailure["write-failure"].passed && saveFailure["write-failure"].priorProjectUnchanged,
    corruptionRejectedBeforeVisibility: saveFailure.corruption.passed && saveFailure.corruption.replacementRejectedBeforeVisibility,
    forcedTerminationPreservedPriorProject: saveFailure["forced-termination"].passed && saveFailure["forced-termination"].partialArchiveUnreferenced,
    passed: true,
  }, "failureAndRecovery");

  assertEqual(reference.durability.temporaryFileFlushed, streamed.durability.temporaryFileFlushed, "durability.temporaryFileFlushed");
  assertEqual(reference.durability.containingDirectoryFlushAttempted, streamed.durability.containingDirectoryFlushAttempted, "durability.containingDirectoryFlushAttempted");
  assertEqual(reference.durability.containingDirectoryFlushSupported, streamed.durability.containingDirectoryFlushSupported, "durability.containingDirectoryFlushSupported");
  assertEqual(reference.durability.firstSaveWriteThrough, streamed.durability.firstSaveWriteThrough, "durability.firstSaveWriteThrough");
  assertEqual(reference.durability.replacementWriteThrough, streamed.durability.replacementWriteThrough, "durability.replacementWriteThrough");
  assertEqual(reference.durability.sameVolumeSibling, streamed.durability.sameVolumeSibling, "durability.sameVolumeSibling");
  assert.ok(reference.durability.consequence.includes("Do not claim"), "reference: durability limitation consequence is missing");

  const accessibilitySources = [lazy.accessibility, workspace.accessibility, streamed.accessibility];
  assert.equal(reference.accessibility.componentTests, accessibilitySources.reduce((sum, entry) => sum + entry.componentTests, 0), "reference: component test count mismatch");
  assert.equal(reference.accessibility.axeSeriousOrCriticalViolations, 0, "reference: axe gate failed");
  assert.equal(accessibilitySources.every((entry) => entry.axeSeriousOrCriticalViolations === 0), true, "reference: source axe gate failed");
  assert.equal(accessibilitySources.every((entry) => String(entry.nvdaSpokenReview).startsWith("passed")), true, "reference: source NVDA gate failed");
  assert.equal(accessibilitySources.every((entry) => String(entry.highContrastReview).startsWith("passed")), true, "reference: source High Contrast gate failed");
  assert.equal(reference.accessibility.nvda, "passed", "reference: NVDA gate failed");
  assert.equal(reference.accessibility.windowsHighContrast, "passed", "reference: High Contrast gate failed");

  assertEqual(reference.securityAndPrivacy, {
    archiveValidationLimitsEnforced: lazy.security.declaredAndActualLimitsEnforced,
    unsafeNamesLinksReparseAndDuplicatesRejected: lazy.security.relativePosixNamesRequired
      && lazy.security.absoluteDriveTraversalNulAdsRejected
      && lazy.security.caseInsensitiveDuplicatesRejected
      && lazy.security.linksSpecialEntriesAndWorkspaceReparseRejected
      && workspace.security.reparseEscapeRejected,
    sha256BeforeVisibility: lazy.security.sha256BeforeVisibility,
    workspaceUnderCurrentUserLocalAppData: workspace.security.workspaceUnderCurrentUserLocalAppData,
    onlyVerifiedRecreatableCacheEvictable: workspace.security.onlyVerifiedRecreatableCacheEvictable,
    unsavedInterruptedRecoveryAndTrashProtected: workspace.security.unsavedInterruptedRecoveryAndTrashProtected,
    frontendFilesystemAccess: streamed.security.frontendFilesystemAccess,
    applicationNetworkAccess: lazy.security.networkAccess || workspace.security.networkAccess || streamed.security.applicationNetworkAccess,
    productionProjectWrites: lazy.security.projectWrites || workspace.security.productionProjectWrites || streamed.security.productionProjectWrites,
    reportsRedacted: !lazy.security.localPathsMediaBytesAndTokensInReports
      && !workspace.security.localPathsProjectTitlesAndSourceBytesInReports
      && !streamed.security.localPathsProjectTitlesAndMediaBytesInReports,
    passed: true,
  }, "securityAndPrivacy");
  assertEqual(reference.compatibility, {
    productionCommandsChanged: false,
    productionSchemaChanged: false,
    screenshotBehaviorChanged: false,
    version1ProjectChanged: false,
    passed: true,
  }, "compatibility");
  for (const report of [lazy, workspace, streamed]) {
    assert.equal(report.compatibility.productionCommandsChanged, false, "reference: production commands changed");
    assert.equal(report.compatibility.productionSchemaChanged, false, "reference: production schema changed");
    assert.equal(report.compatibility.screenshotBehaviorChanged, false, "reference: screenshot behavior changed");
    assert.equal(report.compatibility.version1ProjectChanged, false, "reference: version 1 project changed");
  }
  assert.ok(reference.revisitTriggers?.length >= 6, "reference: revisit triggers are incomplete");
  assertNoPrivateMarkers(reference);
}

function assertNoPrivateMarkers(value) {
  const serialized = JSON.stringify(value).toLowerCase();
  for (const marker of ["\\users\\", "file://", ":\\"]) {
    assert.equal(serialized.includes(marker), false, `reference: private marker ${marker}`);
  }
}

function verifyReference(referencePath) {
  const absolute = resolve(referencePath);
  const reference = loadJson(absolute);
  const sources = sourceByIssue(reference, dirname(absolute));
  verifyGate(reference, sources);
  return { reference, sources };
}

function runSelfTest() {
  const { reference, sources } = verifyReference(DEFAULT_REFERENCE);
  const badMemory = structuredClone(reference);
  badMemory.streamedSave.maximumAdditionalPrivateBytes += 1;
  assert.throws(() => verifyGate(badMemory, sources), /streamedSave mismatch/);
  const badDecision = structuredClone(reference);
  badDecision.recommendation.sqliteComparisonRequired = true;
  assert.throws(() => verifyGate(badDecision, sources), /SQLite comparison/);
  console.log("archive gate verifier self-test passed");
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.selfTest) {
    runSelfTest();
    return;
  }
  assert.ok(options.reference, "--reference is required. Use --help for usage.");
  verifyReference(options.reference);
  console.log(`Verified archive gate report: ${options.reference}`);
}

main();
