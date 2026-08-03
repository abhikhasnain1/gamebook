import { describe, expect, it } from "vitest";
import {
  editorProjectDocuments,
  editorProjectFromNative,
  normalizePlacement,
  type ProjectV2Manifest,
  type ProjectV2PageRecord,
  type ProjectV2ScreenshotEvidenceRecord,
} from "./projectV2";

const manifest: ProjectV2Manifest = {
  formatVersion: 2,
  minimumReaderVersion: 2,
  projectId: "project-alpha",
  title: "Screenshot notes",
  createdAt: "2026-08-03T00:00:00Z",
  updatedAt: "2026-08-03T00:00:00Z",
  activePageId: "page-alpha",
  recordOrder: {
    pages: ["page-alpha"],
    evidence: ["evidence-alpha"],
    timelines: [],
    findings: [],
    tags: [],
    collections: [],
    relationships: [],
    sessions: [],
    trash: [],
  },
  assets: [
    {
      digest: "a".repeat(64),
      byteLength: 32,
      mediaClass: "image",
      mimeType: "image/png",
      extension: "png",
      storageMethod: "stored",
    },
  ],
};

const evidence = {
  recordType: "evidence",
  recordVersion: 1,
  id: "evidence-alpha",
  title: "Screenshot 1",
  createdAt: manifest.createdAt,
  updatedAt: manifest.updatedAt,
  kind: "screenshot",
  sessionId: null,
  tagIds: [],
  provenance: {
    origin: "migration",
    parentEvidenceIds: [],
    importedAt: null,
    originalFilename: null,
  },
  assetDigest: "a".repeat(64),
  image: { width: 1600, height: 900, colorSpace: "srgb", monitorLabel: "Display" },
} satisfies ProjectV2ScreenshotEvidenceRecord;

const page = {
  recordType: "page",
  recordVersion: 1,
  id: "page-alpha",
  title: "1",
  createdAt: manifest.createdAt,
  updatedAt: manifest.updatedAt,
  primaryEvidenceId: "evidence-alpha",
  backgroundColor: "#f7f7f5",
  placements: [
    {
      type: "MediaPlacement",
      placementVersion: 1,
      id: "placement-alpha",
      evidenceId: "evidence-alpha",
      left: 68,
      top: 112,
      scaleX: 0.5,
      scaleY: 0.5,
      angle: 0,
      zIndex: 0,
    },
  ],
  annotations: [
    {
      id: "annotation-alpha",
      kind: "box",
      scope: { kind: "page" },
      semanticText: "",
      fabricObject: {
        type: "Rect",
        left: 20,
        top: 30,
        data: { id: "annotation-alpha", kind: "box", role: "annotation" },
      },
    },
  ],
  annotationOrder: ["annotation-alpha"],
  connectors: [],
  notes: "Fixture note",
} satisfies ProjectV2PageRecord;

describe("canonical version 2 editor model", () => {
  it("adapts native records and emits stable canonical documents", () => {
    const project = editorProjectFromNative({
      workspaceId: "workspace-alpha",
      projectId: "project-alpha",
      manifest,
      records: [evidence, page],
    });

    expect(project.pages[0]).toMatchObject({
      id: "page-alpha",
      evidenceId: "evidence-alpha",
      sourceUrl: null,
      placement: { type: "MediaPlacement", placementVersion: 1, id: "placement-alpha" },
    });
    const serialized = JSON.stringify(editorProjectDocuments(project));
    expect(serialized).not.toMatch(/assetToken|sourceUrl|thumbnailUrl|gamebook-media|base64/i);
    expect(editorProjectDocuments(project)).toEqual([manifest, evidence, page]);
  });

  it("strips runtime crop sources while preserving crop metadata", () => {
    const project = editorProjectFromNative({
      workspaceId: "workspace-alpha",
      projectId: "project-alpha",
      manifest,
      records: [
        evidence,
        {
          ...page,
          annotations: [
            {
              id: "crop-alpha",
              kind: "box",
              scope: { kind: "page" },
              semanticText: "",
              fabricObject: {
                type: "Image",
                src: "gamebook-media://asset/runtime-token",
                cropX: 10,
                cropY: 20,
                width: 100,
                height: 80,
                data: { id: "crop-alpha", kind: "crop", role: "annotation" },
              },
            },
          ],
          annotationOrder: ["crop-alpha"],
        },
      ],
    });

    const documents = editorProjectDocuments(project);
    const serialized = JSON.stringify(documents);
    expect(serialized).not.toMatch(/gamebook-media|crossOrigin/);
    expect((documents[2] as typeof page).annotations[0].fabricObject).toMatchObject({
      cropX: 10,
      cropY: 20,
      data: { kind: "crop" },
    });
  });

  it("normalizes placement geometry and rejects runtime fields", () => {
    expect(
      normalizePlacement({
        ...page.placements[0],
        type: "MediaPlacement",
        placementVersion: 1,
        angle: -10,
      }),
    ).toMatchObject({ angle: 350 });
    expect(() =>
      normalizePlacement({ ...page.placements[0], scaleX: 0 }),
    ).toThrow("scaleX must be positive");
  });
});
