import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_REFERENCE = resolve(root, "docs/spikes/placement-viewport-freeze-reference-report.json");
const CONTRACT_SCHEMA = "gamebook.placement-viewport-contract-reference.v1";

const expectedSources = [
  { issue: 10, path: "media-placement-geometry-reference-report.json", schema: "gamebook.media-placement-geometry.v1", buildRevision: "c6c25c37603cd93b004c56b9705cf6a378e74919", checkCount: 10 },
  { issue: 11, path: "media-playback-reference-report.json", schema: "gamebook.media-playback.v1", buildRevision: "5f2c32fb7d56baf56ceb975ec51c74ee2cf84aa1", checkCount: 11 },
  { issue: 12, path: "viewport-reference-report.json", schema: "gamebook.viewport-spike.v1", buildRevision: "42a574a4599820f34c34a38dae1cf57a5665f0e7", checkCount: 11, pathCount: 14 },
  { issue: 13, path: "media-rendering-comparison-reference-report.json", schema: "gamebook.media-rendering-comparison.v1", buildRevision: "4f63b5e00d793c4d90e212f6f9aa1e7bde05264c", runCount: 3, manualAccessibilityRevision: "274a53ea94c5b79631f5b8cf0454b9aa5938a6b7" },
];

const plannedConformance = [
  "placement-schema-round-trip-and-malformed-fields",
  "geometry-crop-layer-connector-history-and-page-switch",
  "playback-exact-poster-timed-annotation-and-one-active",
  "lifecycle-token-failure-and-late-callback-cleanup",
  "composition-layering-and-connector-identity",
  "static-export-and-thumbnail-equivalence",
  "fit-zoom-reset-pan-resize-and-malformed-view",
  "viewport-serialization-history-connector-and-pixel-invariants",
  "representative-rendering-performance-and-memory",
  "ten-loop-runtime-cleanup",
  "outline-keyboard-focus-announcements-and-semantic-alternatives",
  "minimum-viewport-scale-forced-colors-reduced-motion-and-assistive-technology",
  "runtime-reference-token-path-byte-and-diagnostic-boundaries",
  "gamebook-0.5.3-and-version-1-regression",
];

function parseArgs(args) {
  const options = { reference: undefined, selfTest: false };
  for (let index = 0; index < args.length; index += 1) {
    switch (args[index]) {
      case "--reference": options.reference = args[++index]; break;
      case "--self-test": options.selfTest = true; break;
      case "--help":
      case "-h":
        console.log("verify-placement-viewport-contract --reference REFERENCE");
        console.log("verify-placement-viewport-contract --self-test");
        process.exit(0);
        break;
      default: assert.fail(`Unknown option: ${args[index]}`);
    }
  }
  return options;
}

function loadJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function assertEqual(actual, expected, label) {
  assert.deepEqual(actual, expected, `contract:${label} mismatch`);
}

function assertContains(text, token, label) {
  assert.ok(text.includes(token), `${label}: missing ${token}`);
}

function loadAndVerifySources(referencePath, reference) {
  assertEqual(reference.sources, expectedSources, "sources");
  const base = dirname(resolve(referencePath));
  const reports = new Map();
  for (const source of reference.sources) {
    const report = loadJson(resolve(base, source.path));
    assert.equal(report.schema, source.schema, `source #${source.issue}: schema mismatch`);
    assert.ok(["passed", "performance-passed"].includes(report.status), `source #${source.issue}: source did not pass`);
    assert.equal(report.buildRevision, source.buildRevision, `source #${source.issue}: revision mismatch`);
    if (source.checkCount) {
      assert.equal(report.checks?.length, source.checkCount, `source #${source.issue}: check count mismatch`);
      assert.ok(report.checks.every((check) => check.passed), `source #${source.issue}: failed check retained`);
    }
    if (source.pathCount) assert.equal(report.paths?.length, source.pathCount, `source #${source.issue}: path count mismatch`);
    if (source.runCount) assert.equal(report.runs?.length, source.runCount, `source #${source.issue}: run count mismatch`);
    reports.set(source.issue, report);
  }

  assertEqual(reports.get(10).serializedKeys, ["angle", "evidenceId", "id", "left", "placementVersion", "posterTimestampUs", "scaleX", "scaleY", "top", "type", "zIndex"], "source10.serializedKeys");
  assertEqual(reports.get(11).cleanup.map(({ reason, activeCallbacks, liveSources }) => ({ reason, activeCallbacks, liveSources })), [
    { reason: "pause", activeCallbacks: 0, liveSources: 0 },
    { reason: "page-switch", activeCallbacks: 0, liveSources: 0 },
    { reason: "export", activeCallbacks: 0, liveSources: 0 },
    { reason: "minimize", activeCallbacks: 0, liveSources: 0 },
    { reason: "deletion", activeCallbacks: 0, liveSources: 0 },
    { reason: "disposal", activeCallbacks: 0, liveSources: 0 },
  ], "source11.cleanup");
  const viewport = reports.get(12);
  assertEqual(viewport.logicalPage, { width: 1600, height: 900 }, "source12.logicalPage");
  assertEqual(viewport.supportedZoomPercents, [25, 50, 100, 200], "source12.zoom");
  assert.ok(viewport.paths.every((path) => path.pageStateStable && path.historyStable && path.connectorsStable), "source #12: viewport changed logical state");
  assert.ok(viewport.paths.every((path) => path.exportSha256 === viewport.baseline.exportSha256 && path.thumbnailSha256 === viewport.baseline.thumbnailSha256), "source #12: viewport changed pixels");
  const rendering = reports.get(13);
  assert.equal(rendering.selectedProposal, "fabric-offscreen-surface", "source #13: proposal mismatch");
  assert.equal(rendering.fallback, "layered-dom-video", "source #13: fallback mismatch");
  assert.ok(rendering.runs.every((run) => run.gatePassed && run.cleanupPassed && run.visualPassed), "source #13: retained run did not pass");

  const methodology = readFileSync(resolve(root, "docs/spikes/media-rendering-performance.md"), "utf8");
  for (const token of [source13(reference).manualAccessibilityRevision, "NVDA 2026.1.1 completed", "100%, 150%, and 200%", "forced-colors"]) {
    assertContains(methodology, token, "manual accessibility evidence");
  }
  return reports;
}

function source13(reference) {
  return reference.sources.find((source) => source.issue === 13);
}

function verifyTraceability(reference) {
  assertEqual(reference.fieldTraceability, {
    "placement.*": { sourceIssues: [10, 11], plannedConformance: [plannedConformance[0], plannedConformance[1]] },
    "playback.*": { sourceIssues: [11, 13], acceptedDependencies: ["ADR-0004"], plannedConformance: [plannedConformance[2], plannedConformance[3]] },
    "compositionAndExport.*": { sourceIssues: [10, 11, 12, 13], plannedConformance: [plannedConformance[4], plannedConformance[5]] },
    "viewport.*": { sourceIssues: [12], plannedConformance: [plannedConformance[6], plannedConformance[7]] },
    "performance.*": { sourceIssues: [13], plannedConformance: [plannedConformance[8], plannedConformance[9]] },
    "accessibility.*": { sourceIssues: [10, 11, 12, 13], requiredSpecifications: ["ACCESSIBILITY.md", "PRODUCT-SPEC.md"], plannedConformance: [plannedConformance[10], plannedConformance[11]] },
    "securityAndPrivacy.*": { sourceIssues: [10, 11, 12, 13], requiredSpecifications: ["SECURITY-PRIVACY.md"], plannedConformance: [plannedConformance[12], plannedConformance[3]] },
    "compatibility.*": { currentBehaviorSources: ["README.md", "ARCHITECTURE.md", "QA.md"], plannedConformance: [plannedConformance[13]] },
  }, "fieldTraceability");
  const planned = new Set(reference.plannedConformance);
  for (const [family, trace] of Object.entries(reference.fieldTraceability)) {
    assert.ok(trace.sourceIssues?.length || trace.requiredSpecifications?.length || trace.currentBehaviorSources?.length, `${family}: missing authority`);
    for (const test of trace.plannedConformance) assert.ok(planned.has(test), `${family}: missing conformance ${test}`);
  }
}

function verifyPlacementPlaybackAndComposition(reference) {
  assertEqual(reference.placement, {
    recordFields: ["type", "placementVersion", "id", "evidenceId", "left", "top", "scaleX", "scaleY", "angle", "crop", "posterTimestampUs", "zIndex"],
    type: "MediaPlacement",
    placementVersion: 1,
    idsOpaque: true,
    positionFinite: true,
    scalePositive: true,
    angleNormalizedDegrees: true,
    cropOptionalAndPositive: true,
    posterTimestampOptionalNonnegativeIntegerMicroseconds: true,
    zIndexInteger: true,
    geometryEditsInProjectHistory: true,
    fabricRoundTripRequired: true,
    runtimeFieldsAllowed: false,
  }, "placement");

  assertEqual(reference.playback, {
    renderingApproach: "fabric-offscreen-surface",
    fallback: "layered-dom-video",
    normalPlaybackSource: "hidden-video-to-offscreen-surface-via-video-frame-callback",
    oneDrawAndOneFabricRenderPerPresentedFrame: true,
    exactAndPosterUseSameSurfaceAndGeometry: true,
    exactFrameIdentity: ["decoded-sample-index", "source-presentation-timestamp-100ns"],
    uiSourceTime: "integer-microseconds-derived-from-source-time",
    exactMismatch: "restore-poster-and-textual-error",
    oneActivePlacement: true,
    autoplayWhenReducedMotion: false,
    timedAnnotationRange: "inclusive-source-time",
    runtimeStateInProjectHistory: false,
    lifecycleBoundaries: ["pause", "page-switch", "export", "minimize", "deletion", "disposal", "failure"],
    cleanup: ["cancel-callbacks", "pause-and-release-source", "clear-runtime-token", "release-decoded-frame", "remove-video-element", "restore-poster-when-placement-remains"],
    lateCallbacksRequireCurrentGeneration: true,
  }, "playback");

  assertEqual(reference.compositionAndExport, {
    mediaOrder: "z-index-then-stable-id",
    annotationsAboveMedia: true,
    connectorsAboveMedia: true,
    connectorIdentity: ["stable-placement-id", "named-anchor"],
    connectorDependsOnCurrentFrame: false,
    connectorDependsOnViewport: false,
    staticLogicalPage: "1600x900",
    staticExportSuspendsPlayback: true,
    staticExportUsesConfiguredPosterIdentity: true,
    viewportStateAffectsStaticPixels: false,
    semanticRepresentationOutsideCanvas: true,
  }, "compositionAndExport");
}

function verifyViewport(reference) {
  assertEqual(reference.viewport, {
    logicalPage: { width: 1600, height: 900 },
    defaultMode: "fit",
    fitMaximumInsetScreenPixels: 24,
    zoomPercentMinimum: 25,
    zoomPercentMaximum: 200,
    zoomPreservesSceneCenter: true,
    resetPercent: 100,
    keyboardPanScreenPixels: 24,
    panPaths: ["dedicated-controls", "space-arrow", "space-primary-drag", "middle-button-drag"],
    objectArrowLogicalPixels: 1,
    objectShiftArrowLogicalPixels: 10,
    minimumReachablePageEdgeScreenPixels: 80,
    ephemeralFields: ["mode", "zoom", "viewport-transform", "scene-center"],
    projectSerializationChanged: false,
    projectHistoryChanged: false,
    connectorSceneCoordinatesChanged: false,
    thumbnailPixelsChanged: false,
    staticExportPixelsChanged: false,
    invalidInput: "preserve-prior-view",
  }, "viewport");
}

function performanceFromSource(report) {
  const summarize = (run) => ({
    renderedFps: run.sources.map((source) => source.renderedFps),
    transformP95Ms: run.sources.map((source) => source.transformP95Ms),
    privateMemoryDeltaBytes: run.privateMemoryDeltaBytes,
    droppedRenderCallbacks: run.sources.map((source) => source.droppedRenderCallbacks),
  });
  return {
    sourceClasses: ["1080p60", "1440p60"],
    durationSeconds: 30,
    submittedFramesPerFixture: 1800,
    minimumRenderedFps: 55,
    maximumTransformP95MsExclusive: 50,
    maximumPrivateMemoryReturnBytes: 104857600,
    lifecycleLoops: 10,
    fabricPrimary: summarize(report.runs[0]),
    fabricRepeat: summarize(report.runs[1]),
    layeredDomFallback: summarize(report.runs[2]),
    allRunsZeroRuntimeLeaks: true,
    revisitOnAnyGateFailure: true,
  };
}

function verifyPerformanceAndCrossCutting(reference, reports) {
  assertEqual(reference.performance, performanceFromSource(reports.get(13)), "performance");
  for (const run of [reference.performance.fabricPrimary, reference.performance.fabricRepeat, reference.performance.layeredDomFallback]) {
    assert.ok(run.renderedFps.every((fps) => fps >= reference.performance.minimumRenderedFps), "contract: rendered FPS gate failed");
    assert.ok(run.transformP95Ms.every((ms) => ms < reference.performance.maximumTransformP95MsExclusive), "contract: latency gate failed");
    assert.ok(run.privateMemoryDeltaBytes <= reference.performance.maximumPrivateMemoryReturnBytes, "contract: memory gate failed");
    assert.ok(run.droppedRenderCallbacks.every((count) => count === 0), "contract: dropped callback gate failed");
  }

  assertEqual(reference.accessibility, {
    semanticOutlineSynchronizedWithCanvas: true,
    outlineDoesNotStealFocus: true,
    numericGeometryControls: ["x", "y", "scale-x", "scale-y", "rotation", "layer", "poster-time", "crop-x", "crop-y", "crop-width", "crop-height"],
    keyboardPlaybackControls: ["placement-selection", "play-pause", "seek", "previous-frame", "next-frame", "restore-poster"],
    keyboardViewportControls: ["fit", "zoom", "reset", "pan-up", "pan-left", "pan-right", "pan-down"],
    visibleAndRestoredFocus: true,
    screenReaderUpdatesThrottled: true,
    errorsAssertiveAndActionable: true,
    axeSeriousOrCriticalViolations: 0,
    minimumViewport: "900x620",
    uiScale: [100, 150, 200],
    forcedColorsPassed: true,
    reducedMotionPassed: true,
    accessibilityInsightsPassed: true,
    nvdaVersion: "2026.1.1",
    nvdaPassed: true,
  }, "accessibility");

  assertEqual(reference.securityAndPrivacy, {
    stableRecordsExclude: ["filesystem-paths", "runtime-urls", "media-tokens", "dom-elements", "video-elements", "callbacks", "decoded-frames", "frame-bitmaps", "media-bytes", "viewport-state"],
    frontendUnrestrictedFilesystemPermission: false,
    genericTokenFailure: true,
    tokenFailureRestoresPoster: true,
    diagnosticsContainPathsTokensOrMedia: false,
    networkAccessRequired: false,
    projectWritesBySpike: false,
    disposalMutatesProject: false,
  }, "securityAndPrivacy");

  assertEqual(reference.compatibility, {
    productionCommandsChanged: false,
    productionSchemaChanged: false,
    screenshotBehaviorChanged: false,
    version1ProjectChanged: false,
  }, "compatibility");
  assertEqual(reference.plannedConformance, plannedConformance, "plannedConformance");
}

function verifyAdrsAndDocs() {
  const adr = readFileSync(resolve(root, "docs/decisions/0001-media-placement-rendering.md"), "utf8");
  for (const token of ["- Status: Accepted", "- Governing issue: #19", "- Roadmap milestone: Milestone 5", "Fabric offscreen-surface", "source PTS", "25 through 200 percent", "NVDA 2026.1.1"]) assertContains(adr, token, "ADR-0001");
  for (const section of ["## Context", "## Decision drivers", "## Options considered", "## Decision", "## Consequences", "## Compatibility and migration", "## Accessibility", "## Security and privacy", "## Validation", "## Documentation impact"]) assertContains(adr, section, "ADR-0001");

  const architecture = readFileSync(resolve(root, "docs/VIDEO-EVIDENCE-ARCHITECTURE.md"), "utf8");
  for (const token of ["ADR-0001 freezes", "placementVersion: 1", "selected production design", "24 screen pixels", "at least 80 screen pixels", "trusted timeline"]) assertContains(architecture, token, "architecture");
  const decisions = readFileSync(resolve(root, "docs/decisions/README.md"), "utf8");
  assertContains(decisions, "| [ADR-0001](0001-media-placement-rendering.md) | Accepted |", "decision index");
  const qa = readFileSync(resolve(root, "docs/QA.md"), "utf8");
  assertContains(qa, "placement-viewport-contract:verify", "QA");
  const freeze = readFileSync(resolve(root, "docs/spikes/placement-viewport-freeze.md"), "utf8");
  for (const token of ["ADR-0001", "placement schema version", "100-nanosecond source PTS", "fourteen viewport paths", "Accessibility Insights", "Issue #20"]) assertContains(freeze, token, "freeze narrative");

  const accessibility = readFileSync(resolve(root, "docs/ACCESSIBILITY.md"), "utf8");
  for (const token of ["Outline selection and canvas selection", "Complete keyboard operation", "Visible and correctly restored focus", "200% UI scaling", "900 by 620", "NVDA"]) assertContains(accessibility, token, "accessibility specification");
  const security = readFileSync(resolve(root, "docs/SECURITY-PRIVACY.md"), "utf8");
  for (const token of ["opaque IDs", "never receives unrestricted filesystem permissions", "Tokens are never persisted", "Logs must not contain"]) assertContains(security, token, "security specification");
  assertNoPrivateOrUnresolvedMarkers(`${adr}\n${architecture}\n${decisions}\n${qa}\n${freeze}`, "dependent docs");
}

function assertNoPrivateOrUnresolvedMarkers(text, label) {
  const lower = text.toLowerCase();
  for (const marker of ["\\users\\", "file://", ":\\", "todo", "tbd", "pending decision"]) {
    assert.equal(lower.includes(marker), false, `${label}: private or unresolved marker ${marker}`);
  }
}

function verifyContract(reference, reports, options = { dependentDocs: true }) {
  assert.equal(reference.schema, CONTRACT_SCHEMA, "contract: schema mismatch");
  assert.equal(reference.status, "accepted", "contract: status mismatch");
  assert.equal(reference.governingIssue, 19, "contract: governing issue mismatch");
  assert.equal(reference.acceptedAdr, "ADR-0001", "contract: ADR mismatch");
  assert.ok(Number.isFinite(Date.parse(reference.generatedAt)), "contract: generatedAt must be ISO-8601");
  assert.ok(Date.parse(reference.generatedAt) <= Date.now(), "contract: generatedAt cannot be in the future");
  verifyTraceability(reference);
  verifyPlacementPlaybackAndComposition(reference);
  verifyViewport(reference);
  verifyPerformanceAndCrossCutting(reference, reports);
  if (options.dependentDocs) verifyAdrsAndDocs();
  assertNoPrivateOrUnresolvedMarkers(JSON.stringify(reference), "contract report");
}

function verifyReference(path) {
  const absolute = resolve(path);
  const reference = loadJson(absolute);
  const reports = loadAndVerifySources(absolute, reference);
  verifyContract(reference, reports);
  return { reference, reports };
}

function runSelfTest() {
  const { reference, reports } = verifyReference(DEFAULT_REFERENCE);
  const persistedRuntime = structuredClone(reference);
  persistedRuntime.placement.runtimeFieldsAllowed = true;
  assert.throws(() => verifyContract(persistedRuntime, reports, { dependentDocs: false }), /placement mismatch/);
  const persistedViewport = structuredClone(reference);
  persistedViewport.viewport.projectSerializationChanged = true;
  assert.throws(() => verifyContract(persistedViewport, reports, { dependentDocs: false }), /viewport mismatch/);
  const softPerformance = structuredClone(reference);
  softPerformance.performance.minimumRenderedFps = 54;
  assert.throws(() => verifyContract(softPerformance, reports, { dependentDocs: false }), /performance mismatch/);
  const weakCleanup = structuredClone(reference);
  weakCleanup.playback.cleanup.shift();
  assert.throws(() => verifyContract(weakCleanup, reports, { dependentDocs: false }), /playback mismatch/);
  const weakAccessibility = structuredClone(reference);
  weakAccessibility.accessibility.nvdaPassed = false;
  assert.throws(() => verifyContract(weakAccessibility, reports, { dependentDocs: false }), /accessibility mismatch/);
  console.log("placement and viewport contract verifier self-test passed");
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.selfTest) {
    runSelfTest();
    return;
  }
  assert.ok(options.reference, "--reference is required. Use --help for usage.");
  verifyReference(options.reference);
  console.log(`Verified placement and viewport contract: ${options.reference}`);
}

main();
