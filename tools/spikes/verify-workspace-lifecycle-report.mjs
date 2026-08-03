import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

const REPORT_SCHEMA = "gamebook.workspace-lifecycle-spike.v1";
const MANIFEST_SCHEMA = "gamebook.workspace-lifecycle-evidence-manifest.v1";
const ONE_MIB = 1024 ** 2;
const REQUIRED_ROLES = new Set([
  "identity-same-source",
  "identity-copied-project",
  "live-lock",
  "dead-fresh-lock",
  "stale-lock-recovery",
  "malformed-lock-recovery",
  "external-change",
  "close-reopen",
  "cache-eviction",
  "eviction-cancellation",
  "reparse-rejection",
]);
const PRIVATE_MARKERS = [/[a-z]:\\/i, /\\users\\/i, /onedrive/i];
const PROTECTED_CLASSES = new Set([
  "unsaved-work",
  "interrupted-recording",
  "recovery-pending",
  "project-trash",
]);

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
        console.log("verify-workspace-lifecycle-report [--scenario NAME] REPORT...");
        console.log("verify-workspace-lifecycle-report --manifest MANIFEST");
        console.log("verify-workspace-lifecycle-report --self-test");
        process.exit(0);
        break;
      default:
        options.reports.push(args[index]);
    }
  }
  return options;
}

function verifyReport(report, expectedScenario, label = "report") {
  assert.equal(report.schema, REPORT_SCHEMA, `${label}: report schema mismatch`);
  assert.equal(report.issue, 15, `${label}: issue must be 15`);
  assert.equal(report.result, "passed", `${label}: result must be passed`);
  assert.equal(report.errorMessage, null, `${label}: passed report cannot contain an error`);
  assert.ok(report.startedAt && report.completedAt, `${label}: timestamps are required`);
  assert.ok(Array.isArray(report.command) && report.command.length >= 7, `${label}: redacted command is required`);
  assert.equal(report.command[0], "workspace_lifecycle_spike.exe", `${label}: executable must be redacted`);
  assert.equal(report.scenario, expectedScenario ?? report.scenario, `${label}: scenario mismatch`);
  assert.equal(report.command[2], report.scenario, `${label}: command scenario mismatch`);
  assert.equal(report.applicationBuild?.name, "gamebook", `${label}: application name mismatch`);
  assert.equal(report.applicationBuild?.version, "0.5.3", `${label}: compatibility version mismatch`);
  assert.match(report.applicationBuild?.sourceRevision ?? "", /^[a-zA-Z0-9._-]{7,128}$/, `${label}: invalid source revision`);
  assert.ok(["debug", "release"].includes(report.applicationBuild?.profile), `${label}: invalid profile`);
  assert.equal(report.environment?.os, "windows", `${label}: Windows evidence is required`);
  assert.equal(report.environment?.heartbeatTimeoutMs, 30000, `${label}: heartbeat threshold mismatch`);
  verifySecurity(report, label);
  verifyAccessibility(report, label);
  verifyCompatibility(report, label);
  verifyPrivacy(report, label);
  verifyScenario(report, label);
  assert.equal(report.cleanup?.fixtureRemoved, true, `${label}: fixture cleanup failed`);
  assert.equal(report.cleanup?.workspaceRunRootRemoved, true, `${label}: workspace cleanup failed`);
  assert.equal(report.cleanup?.partialOutputs, 0, `${label}: partial outputs remain`);
  assert.equal(report.cleanup?.protectedDataDeletedDuringScenario, false, `${label}: protected data was deleted`);
  assertNoPrivateMarkers(report, label);
}

function verifySecurity(report, label) {
  for (const key of [
    "workspaceUnderCurrentUserLocalAppData",
    "workspaceAncestorsNonReparse",
    "reparseEscapeRejected",
    "sourceFingerprintSha256",
    "lockIncludesProcessInstanceFingerprintHeartbeat",
    "staleRequiresDeadProcessAndExpiredHeartbeat",
    "malformedLockRequiresRecovery",
    "onlyVerifiedRecreatableCacheEvictable",
    "unsavedInterruptedRecoveryAndTrashProtected",
  ]) {
    assert.equal(report.security?.[key], true, `${label}: security.${key} must be true`);
  }
  assert.equal(report.security?.registryStoresPaths, false, `${label}: registry cannot store source paths`);
}

function verifyAccessibility(report, label) {
  assert.equal(report.accessibility?.interactiveUi, false, `${label}: native spike must be noninteractive`);
  assert.equal(report.accessibility?.semanticReviewSurface, "workspace-recovery-harness", `${label}: review surface mismatch`);
  assert.match(report.accessibility?.productionAnnouncementContract ?? "", /workspace reuse.*copied-project.*lock recovery.*external-change.*cache estimates.*cleanup.*cancellation.*errors.*completion/i, `${label}: announcement contract incomplete`);
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
  assert.equal(report.privacy?.projectWrites, false, `${label}: production project writes must be false`);
  assert.equal(report.privacy?.localPathsInReport, false, `${label}: report cannot contain paths`);
  assert.equal(report.privacy?.projectTitlesInReport, false, `${label}: report cannot contain project titles`);
  assert.equal(report.privacy?.sourceBytesInReport, false, `${label}: report cannot contain source bytes`);
}

function verifyScenario(report, label) {
  const evidence = report.evidence ?? {};
  assert.equal(evidence.passed, true, `${label}: scenario did not pass`);
  switch (report.scenario) {
    case "identity-same-source":
      verifyIdentity(evidence, false, label);
      break;
    case "identity-copied-project":
      verifyIdentity(evidence, true, label);
      break;
    case "live-lock":
      verifyLock(evidence, { parsed: true, alive: true, expired: true, disposition: "activate-existing" }, label);
      break;
    case "dead-fresh-lock":
      verifyLock(evidence, { parsed: true, alive: false, expired: false, disposition: "wait-for-owner" }, label);
      break;
    case "stale-lock-recovery":
      verifyLock(evidence, { parsed: true, alive: false, expired: true, disposition: "recovery-required" }, label);
      break;
    case "malformed-lock-recovery":
      verifyLock(evidence, { parsed: false, alive: false, expired: null, disposition: "recovery-required" }, label);
      break;
    case "external-change":
      verifyExternalChange(evidence, label);
      break;
    case "close-reopen":
      verifyCloseReopen(evidence, label);
      break;
    case "cache-eviction":
      verifyCache(evidence, false, label);
      break;
    case "eviction-cancellation":
      verifyCache(evidence, true, label);
      break;
    case "reparse-rejection":
      verifyReparse(evidence, label);
      break;
    default:
      assert.fail(`${label}: unsupported scenario ${report.scenario}`);
  }
}

function verifyIdentity(evidence, copied, label) {
  assert.equal(evidence.kind, "identity", `${label}: identity evidence missing`);
  assert.equal(evidence.sameSourceReused, !copied, `${label}: reuse result mismatch`);
  assert.equal(evidence.workspaceIdsEqual, !copied, `${label}: workspace identity mismatch`);
  assert.equal(evidence.sourceFingerprintsEqual, !copied, `${label}: source fingerprint mismatch`);
  assert.equal(evidence.contentDigestsEqual, true, `${label}: source bytes must match`);
  assert.equal(evidence.copyDetected, copied, `${label}: copy detection mismatch`);
  assert.equal(evidence.workspaceCount, copied ? 2 : 1, `${label}: workspace count mismatch`);
  assert.equal(evidence.registryContainsSourcePaths, false, `${label}: registry leaked paths`);
}

function verifyLock(evidence, expected, label) {
  assert.equal(evidence.kind, "lock", `${label}: lock evidence missing`);
  assert.equal(evidence.lockParsed, expected.parsed, `${label}: lock parse mismatch`);
  assert.equal(evidence.processAlive, expected.alive, `${label}: process liveness mismatch`);
  assert.equal(evidence.heartbeatExpired, expected.expired, `${label}: heartbeat mismatch`);
  assert.equal(evidence.disposition, expected.disposition, `${label}: lock disposition mismatch`);
  assert.equal(evidence.workspaceDeleted, false, `${label}: workspace was deleted`);
  assert.equal(evidence.lockRetained, true, `${label}: lock evidence was deleted`);
  assert.equal(evidence.recoveryJournalRetained, true, `${label}: recovery journal was deleted`);
}

function verifyExternalChange(evidence, label) {
  assert.equal(evidence.kind, "external-change", `${label}: external-change evidence missing`);
  assert.equal(evidence.baselineMatched, false, `${label}: external change was missed`);
  assert.equal(evidence.digestChanged, true, `${label}: digest change missing`);
  assert.equal(evidence.savePaused, true, `${label}: save did not pause`);
  assert.equal(evidence.automaticReplacement, false, `${label}: replacement was automatic`);
  assert.deepEqual(evidence.choices, ["save-as", "replace-explicit", "cancel"], `${label}: recovery choices mismatch`);
  assert.equal(evidence.priorProjectIntact, true, `${label}: prior project changed`);
  assert.equal(evidence.workspaceRetained, true, `${label}: workspace was lost`);
}

function verifyCloseReopen(evidence, label) {
  assert.equal(evidence.kind, "close-reopen", `${label}: close/reopen evidence missing`);
  for (const key of ["workspaceReused", "workspaceIdsEqual", "lockRemovedOnCleanClose", "recoveryJournalRetained", "registryReloadedFromDisk"]) {
    assert.equal(evidence[key], true, `${label}: ${key} must be true`);
  }
}

function verifyCache(evidence, cancelled, label) {
  assert.equal(evidence.kind, "cache", `${label}: cache evidence missing`);
  assert.equal(evidence.cancelled, cancelled, `${label}: cancellation mismatch`);
  assert.equal(evidence.cleanCacheBytesBefore, 6 * ONE_MIB, `${label}: clean cache baseline mismatch`);
  assert.equal(evidence.storageLimitBytes, 2 * ONE_MIB, `${label}: storage limit mismatch`);
  assert.equal(evidence.cleanCacheBytesAfter, cancelled ? 6 * ONE_MIB : 2 * ONE_MIB, `${label}: clean cache result mismatch`);
  assert.deepEqual(evidence.evictedEntries, cancelled ? [] : ["cache:old"], `${label}: eviction set mismatch`);
  assert.equal(evidence.protectedEntries, 4, `${label}: protected-entry count mismatch`);
  assert.deepEqual(new Set(evidence.protectedClasses), PROTECTED_CLASSES, `${label}: protected classes mismatch`);
  assert.equal(evidence.protectedEntriesRetained, true, `${label}: protected entries were removed`);
  assert.equal(evidence.onlyVerifiedRecreatableEvicted, true, `${label}: unsafe entry was evicted`);
  assert.equal(evidence.closedProjectRequired, true, `${label}: open-project eviction was allowed`);
  assert.equal(evidence.cancellationPreservedAllEntries, true, `${label}: cancellation changed entries`);
}

function verifyReparse(evidence, label) {
  assert.equal(evidence.kind, "reparse", `${label}: reparse evidence missing`);
  assert.equal(evidence.reparseDetected, true, `${label}: reparse point was missed`);
  assert.equal(evidence.escapeRejected, true, `${label}: escape was accepted`);
  assert.equal(evidence.workspaceCreatedThroughLink, false, `${label}: escaped workspace was created`);
  assert.equal(evidence.outsideSentinelPreserved, true, `${label}: outside data changed`);
}

function verifyManifest(manifest, manifestPath) {
  const label = basename(manifestPath);
  assert.equal(manifest.schema, MANIFEST_SCHEMA, `${label}: manifest schema mismatch`);
  assert.equal(manifest.issue, 15, `${label}: issue must be 15`);
  assert.equal(manifest.applicationBuild?.name, "gamebook", `${label}: application name mismatch`);
  assert.equal(manifest.applicationBuild?.version, "0.5.3", `${label}: version mismatch`);
  assert.equal(manifest.applicationBuild?.profile, "release", `${label}: evidence must use release`);
  assert.match(manifest.applicationBuild?.sourceRevision ?? "", /^[a-f0-9]{40}$/, `${label}: exact revision required`);
  assert.match(manifest.binary?.sha256 ?? "", /^[A-F0-9]{64}$/, `${label}: binary hash required`);
  assert.ok(Number.isInteger(manifest.binary?.bytes) && manifest.binary.bytes > 0, `${label}: binary bytes required`);
  assert.equal(manifest.reports?.length, REQUIRED_ROLES.size, `${label}: report count mismatch`);

  const baseDir = dirname(resolve(manifestPath));
  verifyArtifact(resolve(baseDir, manifest.binary.path), manifest.binary.bytes, manifest.binary.sha256, `${label}:binary`);
  const roles = new Set();
  const runFingerprints = new Set();
  for (const entry of manifest.reports) {
    assert.ok(REQUIRED_ROLES.has(entry.role), `${label}: unknown role ${entry.role}`);
    assert.ok(!roles.has(entry.role), `${label}: duplicate role ${entry.role}`);
    const reportPath = resolve(baseDir, entry.path);
    const bytes = readFileSync(reportPath);
    assert.equal(hash(bytes), entry.sha256, `${label}:${entry.id}: report hash mismatch`);
    const report = JSON.parse(bytes.toString("utf8"));
    verifyReport(report, entry.role, `${label}:${entry.id}`);
    assert.equal(report.applicationBuild.sourceRevision, manifest.applicationBuild.sourceRevision, `${label}:${entry.id}: revision mismatch`);
    assert.equal(report.applicationBuild.profile, "release", `${label}:${entry.id}: report must use release`);
    const fingerprint = JSON.stringify([report.startedAt, report.completedAt, report.command]);
    assert.ok(!runFingerprints.has(fingerprint), `${label}:${entry.id}: duplicate run evidence`);
    runFingerprints.add(fingerprint);
    roles.add(entry.role);
  }
  assert.deepEqual(roles, REQUIRED_ROLES, `${label}: role set mismatch`);
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

function syntheticReport(scenario = "identity-same-source") {
  const report = {
    schema: REPORT_SCHEMA,
    issue: 15,
    startedAt: "unix-ms-1",
    completedAt: "unix-ms-2",
    command: ["workspace_lifecycle_spike.exe", "--scenario", scenario, "--build-id", "abcdef0", "--run-id", `run-${scenario}`],
    scenario,
    result: "passed",
    errorMessage: null,
    applicationBuild: { name: "gamebook", version: "0.5.3", sourceRevision: "abcdef0", profile: "release" },
    environment: { os: "windows", arch: "x86_64", storage: "current-user-local-app-data", heartbeatTimeoutMs: 30000 },
    evidence: syntheticEvidence(scenario),
    security: { workspaceUnderCurrentUserLocalAppData: true, workspaceAncestorsNonReparse: true, reparseEscapeRejected: true, sourceFingerprintSha256: true, registryStoresPaths: false, lockIncludesProcessInstanceFingerprintHeartbeat: true, staleRequiresDeadProcessAndExpiredHeartbeat: true, malformedLockRequiresRecovery: true, onlyVerifiedRecreatableCacheEvictable: true, unsavedInterruptedRecoveryAndTrashProtected: true },
    accessibility: { interactiveUi: false, semanticReviewSurface: "workspace-recovery-harness", productionAnnouncementContract: "Announce workspace reuse, copied-project separation, lock recovery, external-change choices, cache estimates, cleanup, cancellation, errors, and completion." },
    compatibility: { productionCommandsChanged: false, productionSchemaChanged: false, version1ProjectChanged: false, screenshotBehaviorChanged: false },
    privacy: { syntheticInputOnly: true, networkAccess: false, projectWrites: false, localPathsInReport: false, projectTitlesInReport: false, sourceBytesInReport: false },
    cleanup: { fixtureRemoved: true, workspaceRunRootRemoved: true, partialOutputs: 0, protectedDataDeletedDuringScenario: false },
  };
  return report;
}

function syntheticEvidence(scenario) {
  if (scenario === "identity-same-source" || scenario === "identity-copied-project") {
    const copied = scenario.endsWith("copied-project");
    return { kind: "identity", sameSourceReused: !copied, workspaceIdsEqual: !copied, sourceFingerprintsEqual: !copied, contentDigestsEqual: true, copyDetected: copied, workspaceCount: copied ? 2 : 1, registryContainsSourcePaths: false, passed: true };
  }
  const lockCases = {
    "live-lock": [true, true, true, "activate-existing"],
    "dead-fresh-lock": [true, false, false, "wait-for-owner"],
    "stale-lock-recovery": [true, false, true, "recovery-required"],
    "malformed-lock-recovery": [false, false, null, "recovery-required"],
  };
  if (lockCases[scenario]) {
    const [parsed, alive, expired, disposition] = lockCases[scenario];
    return { kind: "lock", lockParsed: parsed, processAlive: alive, heartbeatExpired: expired, disposition, workspaceDeleted: false, lockRetained: true, recoveryJournalRetained: true, passed: true };
  }
  if (scenario === "external-change") return { kind: "external-change", baselineMatched: false, sizeChanged: true, digestChanged: true, savePaused: true, automaticReplacement: false, choices: ["save-as", "replace-explicit", "cancel"], priorProjectIntact: true, workspaceRetained: true, passed: true };
  if (scenario === "close-reopen") return { kind: "close-reopen", workspaceReused: true, workspaceIdsEqual: true, lockRemovedOnCleanClose: true, recoveryJournalRetained: true, registryReloadedFromDisk: true, passed: true };
  if (scenario === "cache-eviction" || scenario === "eviction-cancellation") {
    const cancelled = scenario.startsWith("eviction-");
    return { kind: "cache", cancelled, cleanCacheBytesBefore: 6 * ONE_MIB, cleanCacheBytesAfter: cancelled ? 6 * ONE_MIB : 2 * ONE_MIB, storageLimitBytes: 2 * ONE_MIB, evictedEntries: cancelled ? [] : ["cache:old"], protectedEntries: 4, protectedClasses: [...PROTECTED_CLASSES], protectedEntriesRetained: true, onlyVerifiedRecreatableEvicted: true, closedProjectRequired: true, cancellationPreservedAllEntries: true, passed: true };
  }
  return { kind: "reparse", reparseDetected: true, escapeRejected: true, workspaceCreatedThroughLink: false, outsideSentinelPreserved: true, passed: true };
}

function runSelfTest() {
  for (const scenario of REQUIRED_ROLES) verifyReport(syntheticReport(scenario), scenario, scenario);
  assert.throws(() => verifyReport({ ...syntheticReport(), result: "failed" }));
  const stale = syntheticReport("stale-lock-recovery");
  stale.evidence.workspaceDeleted = true;
  assert.throws(() => verifyReport(stale));
  const cache = syntheticReport("cache-eviction");
  cache.evidence.evictedEntries = ["work:unsaved"];
  assert.throws(() => verifyReport(cache));
  const pathLeak = syntheticReport();
  pathLeak.debugPath = "C:\\Users\\name\\project.gamebook";
  assert.throws(() => verifyReport(pathLeak));
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.selfTest) {
    runSelfTest();
    console.log("Workspace lifecycle verifier self-test passed.");
    return;
  }
  if (options.manifest) {
    verifyManifest(JSON.parse(readFileSync(options.manifest, "utf8")), options.manifest);
    console.log(`Verified workspace lifecycle evidence manifest ${options.manifest}`);
    return;
  }
  assert.ok(options.reports.length > 0, "At least one report path is required. Use --help for usage.");
  for (const path of options.reports) {
    verifyReport(JSON.parse(readFileSync(path, "utf8")), options.scenario, basename(path));
    console.log(`Verified ${path}`);
  }
}

main();
