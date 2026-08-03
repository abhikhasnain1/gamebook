import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_REFERENCE = resolve(root, "docs/spikes/native-media-freeze-reference-report.json");
const CONTRACT_SCHEMA = "gamebook.native-media-contract-reference.v1";

const expectedSources = [
  {
    issue: 6,
    document: "native-capture-h264.md",
    sourceRevision: "fd166f796a4f5411919798495a8e7b7b11c0dc33",
    outcome: "windows-capture-integrated-path-rejected",
  },
  {
    issue: 7,
    document: "wasapi-av-sync.md",
    sourceRevision: "43d3f2d15338b75263f4e69985af5ce5b3e4baa1",
    binarySha256: "0FA775A6A61F8E49E9F04451B27637DCB0FAABBD04C3572E96FF8A811EB0EB8F",
    reportCount: 9,
    outcome: "passed",
  },
  {
    issue: 8,
    document: "native-decode-color.md",
    sourceRevision: "eb9cba1efee25f5e3249e6236e9ea7c295c05463",
    binarySha256: "8CE0DC2EE94CB5A22BA9F63684ACC0D89E0D162F4EF58C3B595AFE243CA484DC",
    reportCount: 11,
    outcome: "passed",
  },
  {
    issue: 9,
    document: "direct-capture-stack.md",
    sourceRevision: "f615378cb003b1a7e832ab601d59c56352658928",
    binarySha256: "CF3E208FF67641E0D7CA93238DF7E7EACF274776F556ED2DFD5EF772EF5B5CD9",
    reportCount: 29,
    outcome: "direct-windows-stack-selected",
  },
];

const expectedAdrs = new Map([
  ["ADR-0003", ["0003-direct-windows-media-capture.md", "95 percent", "30 FPS", "WDA_EXCLUDEFROMCAPTURE"]],
  ["ADR-0004", ["0004-source-timing-and-exact-decode.md", "100-nanosecond", "decodedSampleIndex", "Source Reader"]],
  ["ADR-0005", ["0005-system-audio-loopback.md", "whole-output-device", "shared QPC", "microphone"]],
  ["ADR-0006", ["0006-sdr-color-and-logical-aperture.md", "BT.709", "blocked before output", "logical width and height"]],
  ["ADR-0007", ["0007-interrupted-recording-recovery.md", "recoverable draft", "quarantined", "idempotent"]],
]);

const expectedPerformance = [
  ["1080p60-monitor-1", 1651, 1710, -16.4501, 37.4444],
  ["1080p60-monitor-2", 1648, 1710, 0.2499, 36.8513],
  ["1440p60-monitor-1", 1641, 1710, -1.2334, 31.6845],
  ["1440p60-monitor-2", 1641, 1710, -1.2334, 27.4024],
  ["selected-window-1", 1621, 1710, 4.8332, 31.8227],
  ["selected-window-2", 1621, 1710, 4.7999, 31.9638],
].map(([role, submittedFrames, requiredFrames, durationErrorMs, finalizationMs]) => ({
  role,
  submittedFrames,
  requiredFrames,
  durationErrorMs,
  finalizationMs,
  throughputPassed: false,
}));

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
        console.log("verify-native-media-contract --reference REFERENCE");
        console.log("verify-native-media-contract --self-test");
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

function assertEqual(actual, expected, label) {
  assert.deepEqual(actual, expected, `contract:${label} mismatch`);
}

function assertContains(text, token, label) {
  assert.ok(text.includes(token), `${label}: missing ${token}`);
}

function verifySourceTraceability(reference) {
  assertEqual(reference.sources, expectedSources, "sources");
  const countTokens = new Map([[7, "nine"], [8, "eleven"], [9, "29"]]);
  for (const source of reference.sources) {
    const path = resolve(root, "docs/spikes", source.document);
    const text = readFileSync(path, "utf8");
    assertContains(text, source.sourceRevision, `source #${source.issue}`);
    if (source.binarySha256) {
      assertContains(text, source.binarySha256, `source #${source.issue}`);
      assertContains(text, countTokens.get(source.issue), `source #${source.issue} report count`);
    }
  }

  const security = readFileSync(resolve(root, "docs/SECURITY-PRIVACY.md"), "utf8");
  for (const token of ["256-bit cryptographically random token", "expire ten minutes", "only `GET` and `HEAD`", "Microphone capture is a separate setting", "never silently deletes interrupted footage"]) {
    assertContains(security, token, "security specification");
  }
  const accessibility = readFileSync(resolve(root, "docs/ACCESSIBILITY.md"), "utf8");
  for (const token of ["Complete keyboard operation", "Status and error announcements", "High Contrast", "reduced motion", "900 by 620", "100%, 150%, and 200%", "NVDA"]) {
    assertContains(accessibility, token, "accessibility specification");
  }
  const product = readFileSync(resolve(root, "docs/PRODUCT-SPEC.md"), "utf8");
  for (const token of ["up to 60 FPS, subject to hardware capability", "whole-output-device WASAPI loopback", "can never be enabled implicitly", "must never silently create washed-out or clipped evidence"]) {
    assertContains(product, token, "product specification");
  }
}

function verifyAdrs(reference) {
  assertEqual(reference.acceptedAdrs, [...expectedAdrs.keys()], "acceptedAdrs");
  const requiredSections = [
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

  for (const [id, [filename, ...tokens]] of expectedAdrs) {
    const text = readFileSync(resolve(root, "docs/decisions", filename), "utf8");
    assertContains(text, `# ${id}:`, id);
    assertContains(text, "- Status: Accepted", id);
    assertContains(text, "- Date: 2026-08-03", id);
    assertContains(text, "- Governing issue: #18", id);
    assertContains(text, "- Roadmap milestone: Milestone 5", id);
    for (const section of requiredSections) assertContains(text, section, id);
    for (const token of tokens) assertContains(text, token, id);
    assertNoPrivateOrUnresolvedMarkers(text, id);
  }
}

function verifyFieldTraceability(reference) {
  assertEqual(reference.fieldTraceability, {
    "capture.*": {
      sourceIssues: [6, 9],
      plannedConformance: ["capture-target-resolution", "capture-30fps-baseline", "capture-60fps-qualification", "duration-and-finalization", "hud-protected-content-and-source-lifecycle"],
    },
    "timingAndDecode.*": {
      sourceIssues: [8, 9],
      plannedConformance: ["exact-cfr-vfr-decode", "duration-and-finalization"],
    },
    "audio.*": {
      sourceIssues: [7, 9],
      requiredSpecifications: ["PRODUCT-SPEC.md", "SECURITY-PRIVACY.md"],
      plannedConformance: ["audio-drift-duration-endpoint-and-failure", "privacy-redaction-local-only-and-no-project-reference-before-probe"],
    },
    "colorAndAperture.*": {
      sourceIssues: [8, 9],
      plannedConformance: ["sdr-color-hdr-blocking-and-aperture"],
    },
    "recovery.*": {
      sourceIssues: [9],
      requiredSpecifications: ["SECURITY-PRIVACY.md"],
      plannedConformance: ["cancellation-failure-interruption-recovery-and-quarantine", "privacy-redaction-local-only-and-no-project-reference-before-probe"],
    },
    "accessibility.*": {
      sourceIssues: [6, 7, 8, 9],
      requiredSpecifications: ["ACCESSIBILITY.md", "PRODUCT-SPEC.md"],
      plannedConformance: ["keyboard-focus-announcements-high-contrast-reduced-motion-and-scale"],
    },
    "securityAndPrivacy.*": {
      sourceIssues: [6, 7, 8, 9],
      requiredSpecifications: ["SECURITY-PRIVACY.md"],
      plannedConformance: ["privacy-redaction-local-only-and-no-project-reference-before-probe", "token-and-native-identifier-boundaries"],
    },
    "compatibility.*": {
      currentBehaviorSources: ["README.md", "ARCHITECTURE.md", "QA.md"],
      plannedConformance: ["gamebook-0.5.3-and-version-1-regression"],
    },
  }, "fieldTraceability");

  const planned = new Set(reference.plannedConformance);
  for (const [fieldFamily, trace] of Object.entries(reference.fieldTraceability)) {
    assert.ok(trace.sourceIssues?.length || trace.requiredSpecifications?.length || trace.currentBehaviorSources?.length, `contract:${fieldFamily} has no authority`);
    for (const test of trace.plannedConformance) assert.ok(planned.has(test), `contract:${fieldFamily} references missing conformance ${test}`);
  }
}

function verifyCapture(reference) {
  assertEqual(reference.capture, {
    runtimeOwner: "rust-native",
    graphicsCapture: "direct-windows-graphics-capture",
    graphicsDevice: "direct-d3d11",
    videoEncoder: "direct-media-foundation-h264-nv12",
    videoDecoder: "direct-media-foundation-source-reader-nv12",
    integratedWindowsCaptureCrateRecordingAdopted: false,
    ffmpegExecutableBundled: false,
    supportedTargets: ["monitor-under-pointer", "selected-monitor", "selected-window"],
    systemPickerRequired: false,
    frameRateRequestValues: [30, 60],
    sustainedFrameQualificationRatio: 0.95,
    unqualifiedFallbackFps: 30,
    encoderInitializationQualifiesThroughput: false,
    fourK60Evidence: "encoder-initialization-only",
    referencePerformance: expectedPerformance,
    hudExclusion: {
      monitorCaptureVerified: true,
      selectedWindowProtectionClaimed: false,
      fallback: "textual-nonvisual-recording-status",
    },
    sourceClose: {
      wgcClosedEventRequired: false,
      explicitSourceLifecycleFallbackRequired: true,
    },
  }, "capture");
  assert.ok(reference.capture.referencePerformance.every((row) => row.submittedFrames < row.requiredFrames), "contract: 60 FPS misses must remain explicit");
}

function verifyTimingAudioAndColor(reference) {
  assertEqual(reference.timingAndDecode, {
    nativeTimebase: "100ns-media-foundation-ticks",
    frameIdentity: ["decoded-sample-index", "source-presentation-timestamp-100ns"],
    uiAndClipTimebase: "integer-microseconds-derived-from-source-time",
    decodedPresentationTimestampsExact: true,
    decoderDurationNormalizationTolerance100ns: 1,
    cfr30Exact: true,
    cfr60Exact: true,
    vfrExact: true,
    directNv12Required: true,
    rgbSinkWriterConversionAllowedForExactEvidence: false,
    requestedFrameRequiresSampleIndexAndTimestamp: true,
    repeatedPlaybackUpdatesThrottledForAssistiveTechnology: true,
  }, "timingAndDecode");

  assertEqual(reference.audio, {
    captureMode: "wasapi-shared-loopback-default-render-multimedia",
    capturesCompleteOutputDeviceMix: true,
    perProcessAudioClaimed: false,
    acceptedInput: ["mono-44100", "stereo-44100", "mono-48000", "stereo-48000"],
    acceptedSampleKinds: ["pcm", "float"],
    encoderInput: "pcm16",
    encoder: "media-foundation-aac",
    clock: "shared-qpc",
    maximumDriftMsAfter30Seconds: 50,
    maximumMeasuredAbsoluteDriftMs: 22.28,
    encodedDurationTolerance: "one-endpoint-buffer",
    referenceEndpointBufferMs: 100,
    finalizationLimitMs: 5000,
    maximumMeasuredFinalizationMs: 3,
    endpointPinnedForRecording: true,
    defaultEndpointChangeDetectedAndRecorded: true,
    silentAutomaticEndpointSwitchAllowed: false,
    postStartAudioFailure: "video-continues-with-discontinuity-and-warning",
    systemAudioFirstUseDisclosureRequired: true,
    microphoneDefault: "off",
    microphoneConsentSeparate: true,
    microphoneImplicitEnableAllowed: false,
  }, "audio");

  assertEqual(reference.colorAndAperture, {
    encodedVideo: "8-bit-h264-sdr-rec709-full-range",
    primaries: "bt709",
    transfer: "bt709",
    matrix: "bt709",
    nominalRange: "full",
    sdrPatchTolerancePerChannel: 24,
    maximumMeasuredPatchError: 1,
    pqBt2020: "blocked-before-output",
    hlgBt2020: "blocked-before-output",
    toneMappingAccepted: false,
    maximumPaddingRightPixels: 1,
    maximumPaddingBottomPixels: 1,
    paddingMode: "replicated-edge",
    logicalDimensionsTrustedOutsideMp4: true,
    containerApertureTrusted: false,
    decodedPngColor: "srgb",
    decodedPngRestoresLogicalDimensions: true,
  }, "colorAndAperture");
}

function verifyRecoveryAndCrossCutting(reference) {
  assertEqual(reference.recovery, {
    states: ["idle", "preparing", "recording", "finalizing", "completed", "failed", "cancelled"],
    stagingMediaAndJournalUntilProbe: true,
    projectReferenceBeforeProbeAllowed: false,
    playableFinalizedUnpromoted: "recoverable-draft",
    unplayableInterrupted: "quarantined",
    automaticDeletionAllowed: false,
    automaticProjectPromotionAllowed: false,
    diagnosticsIncludeMediaByDefault: false,
    userActions: ["retry-probe", "recover-draft", "reveal", "delete"],
    cancellationIdempotent: true,
    lateEventsRequireCurrentRecordingId: true,
    partialGeneratedAssetsRemainUnreferenced: true,
    failureBoundaries: ["initialization", "encoder", "decoder", "gpu", "storage", "finalization", "device-loss", "source-close", "protected-content"],
  }, "recovery");

  assertEqual(reference.accessibility, {
    keyboardOperations: ["start", "stop", "cancel", "target-selection", "disclosure", "failure-review", "recovery", "quarantine"],
    announcedStates: ["preparing", "recording", "elapsed", "remaining", "stopping", "finalizing", "completed", "cancelled", "failed", "source-closed"],
    textualIndependentStates: ["video", "system-audio", "microphone"],
    warnings: ["hud-fallback", "protected-content", "hdr-blocked", "device-loss", "audio-failure", "quarantine"],
    visibleFocus: true,
    highContrast: true,
    reducedMotion: true,
    minimumViewport: "900x620",
    uiScale: [100, 150, 200],
    screenReaderUpdatesThrottled: true,
  }, "accessibility");

  assertEqual(reference.securityAndPrivacy, {
    localOnly: true,
    networkAccessRequired: false,
    gameInjection: false,
    gameMemoryInspection: false,
    windowsPrivacySettingMutation: false,
    deviceDestructionForFailureTesting: false,
    frontendUnrestrictedFilesystemPermission: false,
    nativeTargetAndEndpointIdsInProjectRecords: false,
    mediaTokenBits: 256,
    mediaTokenBinding: ["application-instance", "workspace", "asset-digest", "allowed-operation"],
    mediaTokenContainsPathOrReadableMetadata: false,
    mediaTokenPersisted: false,
    mediaTokenIdleExpiryMinutes: 10,
    mediaTokenRevokedOn: ["project-close", "asset-eviction", "application-exit"],
    mediaProtocolMethods: ["GET", "HEAD"],
    mediaProtocolValidatedByteRanges: true,
    mediaProtocolDirectoryListing: false,
    pathsTitlesDeviceIdsAndMediaExcludedFromDiagnostics: true,
    quarantinedMediaUserControlled: true,
    quarantinedMediaUnreferenced: true,
    quarantinedMediaExcludedFromDiagnosticsByDefault: true,
  }, "securityAndPrivacy");

  assertEqual(reference.compatibility, {
    productionCommandsChanged: false,
    productionSchemaChanged: false,
    screenshotBehaviorChanged: false,
    version1ProjectChanged: false,
  }, "compatibility");

  assertEqual(reference.plannedConformance, [
    "capture-target-resolution",
    "capture-30fps-baseline",
    "capture-60fps-qualification",
    "duration-and-finalization",
    "exact-cfr-vfr-decode",
    "audio-drift-duration-endpoint-and-failure",
    "sdr-color-hdr-blocking-and-aperture",
    "hud-protected-content-and-source-lifecycle",
    "cancellation-failure-interruption-recovery-and-quarantine",
    "keyboard-focus-announcements-high-contrast-reduced-motion-and-scale",
    "privacy-redaction-local-only-and-no-project-reference-before-probe",
    "token-and-native-identifier-boundaries",
    "gamebook-0.5.3-and-version-1-regression",
  ], "plannedConformance");
}

function verifyDependentDocs() {
  const freeze = readFileSync(resolve(root, "docs/spikes/native-media-freeze.md"), "utf8");
  const architecture = readFileSync(resolve(root, "docs/VIDEO-EVIDENCE-ARCHITECTURE.md"), "utf8");
  const decisions = readFileSync(resolve(root, "docs/decisions/README.md"), "utf8");
  const qa = readFileSync(resolve(root, "docs/QA.md"), "utf8");
  for (const [id, [filename]] of expectedAdrs) {
    assertContains(freeze, filename, "freeze narrative");
    assertContains(architecture, filename, "architecture");
    assertContains(decisions, filename, "decision index");
    assertContains(decisions, `[${id}]`, "decision index");
  }
  assertContains(architecture, "Status: Mixed", "architecture status");
  assertContains(architecture, "sourceTimestamp100ns", "architecture timing");
  assertContains(architecture, "uses 30 FPS", "architecture fallback");
  assertContains(architecture, "blocked before output", "architecture HDR policy");
  assertContains(architecture, "recoverable drafts", "architecture recovery");
  assertContains(qa, "native-media-contract:verify", "QA command");
  assertNoPrivateOrUnresolvedMarkers(`${freeze}\n${architecture}\n${decisions}\n${qa}`, "dependent docs");
}

function assertNoPrivateOrUnresolvedMarkers(text, label) {
  const lower = text.toLowerCase();
  for (const marker of ["\\users\\", "file://", ":\\", "todo", "tbd", "pending decision"]) {
    assert.equal(lower.includes(marker), false, `${label}: private or unresolved marker ${marker}`);
  }
}

function verifyContract(reference, options = { dependentDocs: true, sourceDocs: true, adrs: true }) {
  assert.equal(reference.schema, CONTRACT_SCHEMA, "contract: schema mismatch");
  assert.equal(reference.status, "accepted", "contract: status mismatch");
  assert.equal(reference.governingIssue, 18, "contract: governing issue mismatch");
  assert.ok(Number.isFinite(Date.parse(reference.generatedAt)), "contract: generatedAt must be ISO-8601");
  assert.ok(Date.parse(reference.generatedAt) <= Date.now(), "contract: generatedAt cannot be in the future");
  if (options.sourceDocs) verifySourceTraceability(reference);
  if (options.adrs) verifyAdrs(reference);
  verifyFieldTraceability(reference);
  verifyCapture(reference);
  verifyTimingAudioAndColor(reference);
  verifyRecoveryAndCrossCutting(reference);
  if (options.dependentDocs) verifyDependentDocs();
  assertNoPrivateOrUnresolvedMarkers(JSON.stringify(reference), "contract report");
}

function verifyReference(referencePath) {
  const reference = loadJson(resolve(referencePath));
  verifyContract(reference);
  return reference;
}

function runSelfTest() {
  const reference = loadJson(DEFAULT_REFERENCE);
  verifyContract(reference);
  const badFallback = structuredClone(reference);
  badFallback.capture.unqualifiedFallbackFps = 60;
  assert.throws(() => verifyContract(badFallback, { dependentDocs: false, sourceDocs: false, adrs: false }), /capture mismatch/);
  const badHdr = structuredClone(reference);
  badHdr.colorAndAperture.pqBt2020 = "tone-mapped";
  assert.throws(() => verifyContract(badHdr, { dependentDocs: false, sourceDocs: false, adrs: false }), /colorAndAperture mismatch/);
  const badToken = structuredClone(reference);
  badToken.securityAndPrivacy.mediaTokenBits = 128;
  assert.throws(() => verifyContract(badToken, { dependentDocs: false, sourceDocs: false, adrs: false }), /securityAndPrivacy mismatch/);
  const badRecovery = structuredClone(reference);
  badRecovery.recovery.automaticDeletionAllowed = true;
  assert.throws(() => verifyContract(badRecovery, { dependentDocs: false, sourceDocs: false, adrs: false }), /recovery mismatch/);
  console.log("native media contract verifier self-test passed");
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.selfTest) {
    runSelfTest();
    return;
  }
  assert.ok(options.reference, "--reference is required. Use --help for usage.");
  verifyReference(options.reference);
  console.log(`Verified native media contract: ${options.reference}`);
}

main();
