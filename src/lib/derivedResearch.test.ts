import { describe, expect, it } from "vitest";
import { buildDerivedResearchIndex, usableDerivedPreviews } from "./derivedResearch";
import type {
  ProjectV2CanonicalRecord,
  ProjectV2Manifest,
  ProjectV2ScreenshotEvidenceRecord,
} from "../types/projectV2";

describe("derived research caches", () => {
  it("rebuilds searchable text from canonical records without indexing Trash", () => {
    const finding = {
      recordType: "finding",
      recordVersion: 1,
      id: "finding-one",
      createdAt: "2026-08-03T00:00:00Z",
      updatedAt: "2026-08-03T00:00:00Z",
      observation: "Door timing changed",
      interpretation: "Latency increased",
      hypothesis: "Animation blocks input",
      followUp: "Compare another build",
      status: "open",
      confidence: 0.7,
      evidenceReferences: [],
      tagIds: [],
      revision: 1,
    } satisfies ProjectV2CanonicalRecord;
    const trash = {
      recordType: "trash",
      recordVersion: 1,
      id: "trash-one",
      originalRecord: finding,
    } as ProjectV2CanonicalRecord;
    const index = buildDerivedResearchIndex({
      "finding:finding-one": finding,
      "trash:trash-one": trash,
    });
    expect(index).toEqual({
      cacheVersion: 1,
      entries: [
        expect.objectContaining({
          recordType: "finding",
          recordId: "finding-one",
          searchText: expect.stringContaining("door timing changed"),
        }),
      ],
    });
    expect(JSON.stringify(index)).not.toContain("originalRecord");
  });

  it("ignores stale preview hints and accepts a matching rebuildable hint", () => {
    const digest = "a".repeat(64);
    const previewDigest = "b".repeat(64);
    const evidence = {
      recordType: "evidence",
      recordVersion: 1,
      id: "evidence-one",
      title: "Screenshot",
      createdAt: "2026-08-03T00:00:00Z",
      updatedAt: "2026-08-03T00:00:00Z",
      kind: "screenshot",
      sessionId: null,
      tagIds: [],
      provenance: {
        origin: "capture",
        parentEvidenceIds: [],
        importedAt: null,
        originalFilename: null,
      },
      assetDigest: digest,
      image: { width: 1600, height: 900, colorSpace: "srgb", monitorLabel: null },
    } satisfies ProjectV2ScreenshotEvidenceRecord;
    const manifest = {
      derivedPreviews: [
        {
          evidenceId: evidence.id,
          kind: "thumbnail",
          sourceDigest: "c".repeat(64),
          previewDigest,
        },
        {
          evidenceId: evidence.id,
          kind: "poster",
          sourceDigest: digest,
          previewDigest,
        },
      ],
    } as ProjectV2Manifest;
    expect(usableDerivedPreviews(manifest, { [evidence.id]: evidence })).toEqual([
      manifest.derivedPreviews?.[1],
    ]);
  });
});
