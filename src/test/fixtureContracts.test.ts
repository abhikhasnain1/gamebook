import { describe, expect, it } from "vitest";
import fixtureExpectation from "./fixtures/projects/version1/basic-screenshot.expected.json";
import fixtureManifest from "./fixtures/manifest.json";

describe("deterministic fixture contracts", () => {
  it("documents every screenshot-regression fixture needed by the version 1 baseline", () => {
    const fixtures = fixtureManifest.fixtures;
    const version1Project = fixtures.find(
      (fixture) => fixture.path === "projects/version1/basic-screenshot.gamebook.fixture",
    );
    const version1Expectation = fixtures.find(
      (fixture) => fixture.path === "projects/version1/basic-screenshot.expected.json",
    );

    expect(fixtureManifest.provenance).toContain("Deterministic synthetic");
    expect(fixtureManifest.verification).toBe("npm.cmd run fixtures:verify");
    expect(version1Project).toMatchObject({
      type: "version1-project",
      description:
        "Gzip-compressed version 1 project containing one synthetic screenshot and two annotations.",
      accessibilityText:
        "Version 1 project fixture with one page, a rectangle annotation, and a note annotation.",
    });
    expect(version1Expectation).toMatchObject({
      type: "version1-project-metadata",
      accessibilityText:
        "JSON lists expected project identifiers, source hash, annotation identifiers, and extracted text.",
    });
    expect(version1Project?.metadata).toMatchObject({
      formatVersion: fixtureExpectation.expected.formatVersion,
      pageCount: fixtureExpectation.expected.pageCount,
      screenshotSha256: fixtureExpectation.expected.sourceImageSha256,
    });
    expect(fixtureExpectation.expected.annotationIds).toEqual([
      "fixture-box-1",
      "fixture-note-1",
    ]);
  });

  it("keeps numbered-frame identity and timestamps machine-verifiable", () => {
    const numberedFrames = fixtureManifest.fixtures.filter(
      (fixture) => fixture.type === "numbered-frame",
    );

    expect(numberedFrames).toHaveLength(6);
    expect(
      numberedFrames.map((fixture) => ({
        path: fixture.path,
        fps: fixture.metadata?.fps,
        sampleIndex: fixture.metadata?.sampleIndex,
        timestampUs: fixture.metadata?.timestampUs,
      })),
    ).toEqual([
      {
        path: "media/numbered-frames-30fps/frame-0000.png",
        fps: 30,
        sampleIndex: 0,
        timestampUs: 0,
      },
      {
        path: "media/numbered-frames-30fps/frame-0015.png",
        fps: 30,
        sampleIndex: 15,
        timestampUs: 500000,
      },
      {
        path: "media/numbered-frames-30fps/frame-0029.png",
        fps: 30,
        sampleIndex: 29,
        timestampUs: 966667,
      },
      {
        path: "media/numbered-frames-60fps/frame-0000.png",
        fps: 60,
        sampleIndex: 0,
        timestampUs: 0,
      },
      {
        path: "media/numbered-frames-60fps/frame-0030.png",
        fps: 60,
        sampleIndex: 30,
        timestampUs: 500000,
      },
      {
        path: "media/numbered-frames-60fps/frame-0059.png",
        fps: 60,
        sampleIndex: 59,
        timestampUs: 983333,
      },
    ]);
  });

  it("keeps malformed local-data boundaries explicit and non-visual", () => {
    const expectedFailures = fixtureManifest.fixtures
      .filter((fixture) => "expectedFailure" in fixture)
      .map((fixture) => fixture.expectedFailure)
      .sort();

    expect(expectedFailures).toEqual([
      "reject-absolute-path",
      "reject-before-project-mutation",
      "reject-before-project-mutation",
      "reject-case-duplicate",
      "reject-json-size-limit",
      "reject-nul-path",
      "reject-parent-traversal",
    ]);
    expect(
      fixtureManifest.fixtures
        .filter((fixture) => fixture.type !== undefined)
        .every((fixture) => typeof fixture.accessibilityText === "string"),
    ).toBe(true);
  });
});
