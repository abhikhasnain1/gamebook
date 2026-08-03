import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const rel = (...parts) => path.join(root, ...parts);
const fail = (message) => { throw new Error(message); };
const assert = (condition, message) => { if (!condition) fail(message); };
const clone = (value) => structuredClone(value);
const readText = (file) => readFile(file, "utf8");
const readJson = async (file) => JSON.parse(await readText(file));

const requiredAdrSections = [
  "## Context",
  "## Decision drivers",
  "## Options considered",
  "## Decision",
  "## Consequences",
  "## Compatibility and migration",
  "## Accessibility",
  "## Security and privacy",
  "## Validation",
  "## Documentation impact",
];

async function markdownFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await markdownFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".md")) files.push(full);
  }
  return files;
}

async function pathExists(file) {
  try { await access(file); return true; } catch { return false; }
}

async function verifyMarkdownLinks(extraDocuments = []) {
  const files = [rel("README.md"), ...await markdownFiles(rel("docs"))];
  const documents = await Promise.all(files.map(async (file) => ({ file, text: await readText(file) })));
  documents.push(...extraDocuments);
  const failures = [];
  for (const { file, text } of documents) {
    const links = text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g);
    for (const match of links) {
      let target = match[1].trim();
      if (target.startsWith("<") && target.endsWith(">")) target = target.slice(1, -1);
      if (/^(https?:|mailto:)/i.test(target) || target.startsWith("#")) continue;
      target = target.split("#", 1)[0];
      if (!target) continue;
      try { target = decodeURIComponent(target); } catch { failures.push(`${path.relative(root, file)}: invalid URL encoding ${target}`); continue; }
      const resolved = path.resolve(path.dirname(file), target);
      if (!resolved.startsWith(root + path.sep) || !await pathExists(resolved)) failures.push(`${path.relative(root, file)}: missing local link ${target}`);
    }
  }
  assert(failures.length === 0, `Documentation link audit failed:\n${failures.join("\n")}`);
  return documents.length;
}

async function loadSources(report) {
  const sources = {};
  for (const source of report.sourceReports) sources[source.issue] = await readJson(rel("docs/spikes", source.path));
  return sources;
}

async function verifyReadiness(report, sources) {
  assert(report.schema === "gamebook.architecture-readiness-reference.v1", "Readiness schema changed");
  assert(report.status === "accepted" && report.governingIssue === 21 && report.roadmapMilestone === 5, "Readiness report identity changed");
  assert(report.repository === "abhikhasnain1/gamebook", "Readiness repository changed");
  assert(JSON.stringify(report.completedDependencies) === JSON.stringify([18, 19, 20]), "Issue #21 dependency set changed");
  assert(report.blockingDecisions.length === 0, "Architecture freeze retains a blocking decision");

  const expectedAdrs = Array.from({ length: 9 }, (_, index) => `ADR-${String(index + 1).padStart(4, "0")}`);
  assert(JSON.stringify(report.acceptedAdrs.map((adr) => adr.id)) === JSON.stringify(expectedAdrs), "Accepted ADR set must be ADR-0001 through ADR-0009");
  for (const adr of report.acceptedAdrs) {
    const text = await readText(rel(...adr.path.split("/")));
    assert(text.startsWith(`# ${adr.id}:`), `${adr.id} title mismatch`);
    assert(text.includes("- Status: Accepted"), `${adr.id} is not Accepted`);
    for (const section of requiredAdrSections) assert(text.includes(section), `${adr.id} missing ${section}`);
    assert(adr.domains.length > 0, `${adr.id} has no authority domain`);
  }

  for (const schemaRef of report.schemas) {
    const schema = await readJson(rel(...schemaRef.path.split("/")));
    assert(schema.$schema === "https://json-schema.org/draft/2020-12/schema", `${schemaRef.path} draft changed`);
    assert(schema.$id === schemaRef.id, `${schemaRef.path} ID changed`);
  }

  for (const sourceRef of report.sourceReports) {
    const source = sources[sourceRef.issue];
    assert(source?.schema === sourceRef.schema, `Issue #${sourceRef.issue} source schema changed`);
    assert(sourceRef.acceptedStatuses.includes(source.status), `Issue #${sourceRef.issue} source is not accepted`);
    assert(source.governingIssue === sourceRef.issue, `Issue #${sourceRef.issue} source ownership changed`);
  }

  const domains = ["mediaTransport", "timing", "rendering", "storageAndSave", "migrationAndRepair", "researchRecords", "accessibility", "securityAndPrivacy", "compatibility", "export"];
  for (const domain of domains) assert(report.authorityMatrix[domain]?.length > 0, `Missing authority matrix domain: ${domain}`);

  const t = report.frozenThresholds;
  const native = sources[18];
  const placement = sources[19];
  const archive = sources[17];
  const format = sources[20];
  assert(t.unqualifiedCaptureFps === native.capture.unqualifiedFallbackFps, "Capture fallback threshold drift");
  assert(t.captureQualificationRatio === native.capture.sustainedFrameQualificationRatio, "Capture qualification threshold drift");
  assert(t.audioDriftMsAfter30Seconds === native.audio.maximumDriftMsAfter30Seconds, "Audio drift threshold drift");
  assert(t.audioFinalizationLimitMs === native.audio.finalizationLimitMs, "Audio finalization threshold drift");
  assert(t.minimumRenderedFps === placement.performance.minimumRenderedFps, "Rendering FPS threshold drift");
  assert(t.maximumTransformP95MsExclusive === placement.performance.maximumTransformP95MsExclusive, "Transform latency threshold drift");
  assert(t.maximumPrivateMemoryReturnBytes === placement.performance.maximumPrivateMemoryReturnBytes, "Rendering memory threshold drift");
  assert(t.metadataOpenMemoryLimitBytes === archive.metadataOpen.memoryLimitBytes, "Archive open memory threshold drift");
  assert(t.fiveGiBSaveMemoryLimitBytes === archive.streamedSave.memoryLimitBytes, "Archive Save memory threshold drift");
  assert(t.jsonEntryLimitBytes === format.archiveLimits.jsonBytes && t.previewEntryLimitBytes === format.archiveLimits.previewBytes && t.archiveEntryLimit === format.archiveLimits.entryCount, "Archive validation limit drift");
  assert(t.mediaTokenBits === native.securityAndPrivacy.mediaTokenBits && t.mediaTokenBits === format.mediaToken.bits, "Media token threshold drift");
  assert(t.renderWidth === format.migration.renderWidth && t.renderHeight === format.migration.renderHeight && t.renderPerChannelThreshold === format.migration.perChannelThreshold && t.renderMaximumChangedPixelRatioExclusive === format.migration.maximumPixelsOverThresholdRatioExclusive, "Migration render threshold drift");

  const issues = report.milestone6Issues;
  assert(JSON.stringify(issues.map((issue) => issue.issue)) === JSON.stringify([22, 23, 24, 25]), "Milestone 6 issue set or order changed");
  const expectedDependencies = { 22: [21], 23: [22], 24: [22, 23], 25: [22, 24] };
  for (const issue of issues) {
    assert(JSON.stringify(issue.blockedBy) === JSON.stringify(expectedDependencies[issue.issue]), `Issue #${issue.issue} dependency order changed`);
    assert(issue.acceptedSources.some((source) => source.startsWith("ADR-")), `Issue #${issue.issue} lacks an accepted ADR`);
    assert(issue.acceptedSources.includes("ACCESSIBILITY.md") && issue.acceptedSources.includes("SECURITY-PRIVACY.md"), `Issue #${issue.issue} lacks required accessibility/security sources`);
    assert(issue.requiredConformance.includes("gamebook-0.5.3-and-version-1-regression"), `Issue #${issue.issue} lacks baseline compatibility conformance`);
    assert(issue.requiredConformance.some((entry) => entry.includes("keyboard") || entry.includes("semantic")), `Issue #${issue.issue} lacks accessibility conformance`);
  }

  assert(report.accessibility.allAcceptedAdrsHaveAccessibilitySection && report.accessibility.nvdaRequired && report.accessibility.accessibilityInsightsRequired && report.accessibility.highContrastRequired && report.accessibility.reducedMotionRequired, "Accessibility closeout weakened");
  assert(report.accessibility.minimumViewport === "900x620" && JSON.stringify(report.accessibility.uiScale) === JSON.stringify([100, 150, 200]), "Accessibility viewport/scale changed");
  assert(report.securityAndPrivacy.localOnly && report.securityAndPrivacy.archiveInputUntrusted && !report.securityAndPrivacy.frontendUnrestrictedFilesystemPermission && !report.securityAndPrivacy.credentialsInSettingsAllowed && !report.securityAndPrivacy.automaticTrashDeletionAllowed && !report.securityAndPrivacy.diagnosticsContainPathsTokensOrMedia, "Security/privacy closeout weakened");
  assert(report.export.currentStaticExportPreserved && !report.export.milestone6AddsMultimediaExport && report.export.futureCompositionDecision === "ADR-0001" && report.export.futureTimingDecision === "ADR-0004" && report.export.futureSemanticRecordDecision === "ADR-0008", "Export boundary unresolved");
  assert(!report.compatibility.productionBehaviorChanged && !report.compatibility.productionSchemaChanged && !report.compatibility.screenshotBehaviorChanged && !report.compatibility.version1ProjectChanged && report.compatibility.futureImplementationStartsAtIssue === 22, "Current/future compatibility boundary changed");

  const [index, formatDoc, mediaDoc, architecture, qa, archiveDoc, packageJson] = await Promise.all([
    readText(rel("docs/INDEX.md")), readText(rel("docs/PROJECT-FORMAT-V2.md")), readText(rel("docs/VIDEO-EVIDENCE-ARCHITECTURE.md")),
    readText(rel("docs/ARCHITECTURE.md")), readText(rel("docs/QA.md")), readText(rel("docs/spikes/archive-gate.md")), readJson(rel("package.json")),
  ]);
  assert(index.includes("frozen by ADR-0001 through ADR-0009"), "Documentation index does not identify the frozen decisions");
  assert(
    formatDoc.includes("Status: Accepted architecture contract under dependency-ordered implementation")
      && formatDoc.includes("The production screenshot editor uses the version 2 archive")
      && formatDoc.includes("Video, research, settings, and Project Trash behavior remain assigned to later roadmap issues"),
    "Project-format current/future boundary changed",
  );
  assert(mediaDoc.includes("Status: Frozen architecture contract for future implementation") && mediaDoc.includes("None of these future features is implemented in Gamebook 0.5.3"), "Media architecture current/future boundary changed");
  assert(
    architecture.includes("Open accepts valid version 2 archives and Gzip or plain version 1 projects")
      && architecture.includes("Version 1 migration runs in an isolated workspace")
      && architecture.includes("Damaged version 2 input receives a read-only repair report"),
    "Current project architecture boundary changed",
  );
  assert(!qa.includes("Proposed rendering ADR") && qa.includes("accepted ADR-0001"), "QA retains obsolete rendering-decision guidance");
  assert(archiveDoc.includes("Status: Accepted feasibility evidence") && !archiveDoc.includes("ADR-0002](../decisions/0002-zip64-project-storage.md) remains Proposed"), "Archive gate retains obsolete current decision status");
  for (const script of ["native-media-contract:verify", "placement-viewport-contract:verify", "archive-gate:verify", "project-format-contract:verify", "architecture-readiness:verify"])
    assert(packageJson.scripts[script], `Missing package verifier script: ${script}`);
}

async function assertRejects(action, label) {
  let rejected = false;
  try { await action(); } catch { rejected = true; }
  assert(rejected, `Self-test did not reject ${label}`);
}

async function runSelfTest(report, sources) {
  const missingDecision = clone(report); missingDecision.acceptedAdrs.pop();
  await assertRejects(() => verifyReadiness(missingDecision, sources), "missing accepted decision");
  const blocker = clone(report); blocker.blockingDecisions.push("unresolved-save-choice");
  await assertRejects(() => verifyReadiness(blocker, sources), "blocking decision");
  const traceability = clone(report); traceability.milestone6Issues[0].acceptedSources = traceability.milestone6Issues[0].acceptedSources.filter((source) => source !== "ACCESSIBILITY.md");
  await assertRejects(() => verifyReadiness(traceability, sources), "weakened downstream traceability");
  const threshold = clone(report); threshold.frozenThresholds.minimumRenderedFps = 54;
  await assertRejects(() => verifyReadiness(threshold, sources), "threshold drift");
  await assertRejects(() => verifyMarkdownLinks([{ file: rel("docs/__readiness-self-test__.md"), text: "[missing](definitely-not-present.md)" }]), "broken documentation link");
  console.log("Architecture readiness self-test passed (5 negative cases).");
}

async function main() {
  const selfTest = process.argv.includes("--self-test");
  const referenceIndex = process.argv.indexOf("--reference");
  assert(selfTest || referenceIndex >= 0, "Use --self-test or --reference PATH");
  const reportPath = selfTest ? rel("docs/spikes/architecture-readiness-reference-report.json") : path.resolve(root, process.argv[referenceIndex + 1]);
  const report = await readJson(reportPath);
  const sources = await loadSources(report);
  await verifyReadiness(report, sources);
  if (selfTest) return runSelfTest(report, sources);
  const documentCount = await verifyMarkdownLinks();
  console.log(`Architecture readiness verification passed (${report.acceptedAdrs.length} ADRs, ${report.milestone6Issues.length} downstream issues, ${documentCount} Markdown documents).`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
