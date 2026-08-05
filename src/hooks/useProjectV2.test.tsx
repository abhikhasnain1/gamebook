import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  autosaveProjectV2Workspace: vi.fn(),
  cancelProjectV2Operation: vi.fn(),
  claimScreenshotCapture: vi.fn(),
  closeProjectV2Workspace: vi.fn(),
  createProjectV2: vi.fn(),
  evictProjectV2CleanCache: vi.fn(),
  listProjectV2Recovery: vi.fn(),
  listProjectV2Trash: vi.fn(),
  materializeProjectV2Asset: vi.fn(),
  onCaptureError: vi.fn(),
  onScreenshotCapture: vi.fn(),
  openProjectForEditor: vi.fn(),
  readProjectV2Record: vi.fn(),
  recoverProjectV2Workspace: vi.fn(),
  restoreProjectV2Trash: vi.fn(),
  reviewProjectV2TrashImpact: vi.fn(),
  saveProjectV2: vi.fn(),
  stageProjectV2Document: vi.fn(),
  trashProjectV2Records: vi.fn(),
  emptyProjectV2Trash: vi.fn(),
}));

vi.mock("../lib/native", () => ({
  ...native,
  isTauri: true,
  projectV2MediaUrl: (token: string) => `http://gamebook-media.localhost/${token}`,
}));

import { useProjectV2 } from "./useProjectV2";

let captureListener:
  | ((capture: {
      captureId: string;
      capturedAt: string;
      monitorName: string;
      width: number;
      height: number;
      monitorX: number;
      monitorY: number;
    }) => void)
  | null = null;

describe("useProjectV2 production workspace flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    captureListener = null;
    native.listProjectV2Recovery.mockResolvedValue([]);
    native.listProjectV2Trash.mockResolvedValue({
      transactions: [],
      totalRecords: 0,
      eligibleTransactions: 0,
      retainedAssetBytes: 0,
    });
    native.onScreenshotCapture.mockImplementation(async (listener) => {
      captureListener = listener;
      return () => undefined;
    });
    native.onCaptureError.mockResolvedValue(() => undefined);
    native.closeProjectV2Workspace.mockResolvedValue(undefined);
  });

  it("does not create an empty native workspace on launch", async () => {
    const onError = vi.fn();
    const { result } = renderHook(() => useProjectV2(onError));

    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.project.workspaceId).toBe("pending-native-workspace");
    expect(native.createProjectV2).not.toHaveBeenCalled();
    expect(native.listProjectV2Recovery).toHaveBeenCalledOnce();
  });

  it("creates one workspace on first capture and claims bytes by opaque id", async () => {
    native.createProjectV2.mockResolvedValue(emptyNativeProject("workspace-alpha"));
    native.claimScreenshotCapture.mockResolvedValue({
      token: "a".repeat(64),
      digest: "b".repeat(64),
      mimeType: "image/png",
      byteLength: 42,
      expiresAfterSeconds: 600,
    });
    const onError = vi.fn();
    const { result } = renderHook(() => useProjectV2(onError));
    await waitFor(() => expect(result.current.hydrated).toBe(true));

    captureListener?.({
      captureId: "c".repeat(64),
      capturedAt: "2026-08-03T00:00:00Z",
      monitorName: "Display 1",
      width: 1920,
      height: 1080,
      monitorX: 0,
      monitorY: 0,
    });
    await waitFor(() => expect(result.current.project.pages).toHaveLength(1));

    expect(native.createProjectV2).toHaveBeenCalledOnce();
    expect(native.claimScreenshotCapture).toHaveBeenCalledWith(
      "workspace-alpha",
      "c".repeat(64),
    );
    expect(result.current.activePage).toMatchObject({
      sourceUrl: `http://gamebook-media.localhost/${"a".repeat(64)}`,
      assetDigest: "b".repeat(64),
    });
    expect(JSON.stringify(native.claimScreenshotCapture.mock.calls)).not.toMatch(
      /base64|data:image|pngBytes/i,
    );
  });

  it("serializes rapid captures through one adopted workspace", async () => {
    let resolveWorkspace: ((value: NativeProjectFixture) => void) | null = null;
    native.createProjectV2.mockReturnValue(
      new Promise<NativeProjectFixture>((resolve) => {
        resolveWorkspace = resolve;
      }),
    );
    native.claimScreenshotCapture.mockImplementation(async (_workspaceId, captureId) => ({
      token: captureId,
      digest: captureId === "1".repeat(64) ? "a".repeat(64) : "b".repeat(64),
      mimeType: "image/png",
      byteLength: 42,
      expiresAfterSeconds: 600,
    }));
    const onError = vi.fn();
    const { result } = renderHook(() => useProjectV2(onError));
    await waitFor(() => expect(result.current.hydrated).toBe(true));

    act(() => {
      captureListener?.({
        captureId: "1".repeat(64),
        capturedAt: "2026-08-03T00:00:01Z",
        monitorName: "Display 1",
        width: 1920,
        height: 1080,
        monitorX: 0,
        monitorY: 0,
      });
      captureListener?.({
        captureId: "2".repeat(64),
        capturedAt: "2026-08-03T00:00:02Z",
        monitorName: "Display 2",
        width: 2560,
        height: 1440,
        monitorX: 1920,
        monitorY: 0,
      });
    });
    await waitFor(() => expect(native.createProjectV2).toHaveBeenCalledOnce());
    await act(async () => {
      resolveWorkspace?.(emptyNativeProject("workspace-rapid"));
    });
    await waitFor(() => expect(result.current.project.pages).toHaveLength(2));

    expect(native.createProjectV2).toHaveBeenCalledOnce();
    expect(native.claimScreenshotCapture.mock.calls).toEqual([
      ["workspace-rapid", "1".repeat(64)],
      ["workspace-rapid", "2".repeat(64)],
    ]);
    expect(result.current.project.pages.map((page) => page.title)).toEqual(["1", "2"]);
    expect(native.closeProjectV2Workspace).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("opens a migrated project, materializes its active screenshot, and saves canonical documents", async () => {
    native.openProjectForEditor.mockResolvedValue({
      outcome: "migrated",
      project: {
        ...populatedNativeProject("workspace-migrated"),
        sourceFormat: "gzip-json-v1",
        report: migrationReport(),
      },
    });
    native.materializeProjectV2Asset.mockResolvedValue({
      token: "a".repeat(64),
      digest: "b".repeat(64),
      mimeType: "image/png",
      byteLength: 42,
      expiresAfterSeconds: 600,
    });
    native.saveProjectV2.mockResolvedValue({
      operationId: "save-migrated",
      saveId: "save-id",
      replacedExisting: false,
      directoryFlushSupported: false,
      visibleArchiveReopened: true,
      version1BackupCreated: false,
    });
    const onError = vi.fn();
    const { result } = renderHook(() => useProjectV2(onError));
    await waitFor(() => expect(result.current.hydrated).toBe(true));

    await act(async () => {
      await result.current.openProject();
    });
    expect(result.current.project.workspaceId).toBe("workspace-migrated");
    expect(result.current.project.requiresSaveAs).toBe(true);
    expect(result.current.activePage?.sourceUrl).toBe(
      `http://gamebook-media.localhost/${"a".repeat(64)}`,
    );
    expect(result.current.report?.kind).toBe("migration");
    expect(native.materializeProjectV2Asset).toHaveBeenCalledWith(
      "workspace-migrated",
      "b".repeat(64),
      expect.any(String),
    );

    act(() => {
      result.current.setProject((current) => ({
        ...current,
        manifest: { ...current.manifest, title: "Saved immediately" },
      }));
    });
    await act(async () => {
      await result.current.saveProject();
    });

    const stagedDocuments = native.stageProjectV2Document.mock.calls.map(
      ([, document]) => document,
    );
    expect(stagedDocuments).toContainEqual(
      expect.objectContaining({ formatVersion: 2, title: "Saved immediately" }),
    );
    expect(JSON.stringify(stagedDocuments)).not.toMatch(
      /gamebook-media|sourceUrl|token|data:image|base64/i,
    );
    expect(native.saveProjectV2).toHaveBeenCalledWith(
      "workspace-migrated",
      true,
      "cancel",
      expect.any(String),
    );
    expect(result.current.project.requiresSaveAs).toBe(false);
  });

  it("does not eagerly read canonical research records during initial open", async () => {
    const project = populatedNativeProject("workspace-lazy");
    project.manifest.recordOrder.findings = ["finding-lazy"];
    native.openProjectForEditor.mockResolvedValue({ outcome: "opened", project });
    native.materializeProjectV2Asset.mockResolvedValue({
      token: "a".repeat(64),
      digest: "b".repeat(64),
      mimeType: "image/png",
      byteLength: 42,
      expiresAfterSeconds: 600,
    });
    const onError = vi.fn();
    const { result } = renderHook(() => useProjectV2(onError));
    await waitFor(() => expect(result.current.hydrated).toBe(true));

    await act(async () => {
      await result.current.openProject();
    });

    expect(native.readProjectV2Record).not.toHaveBeenCalledWith(
      "workspace-lazy",
      "finding",
      "finding-lazy",
    );
    expect(onError).not.toHaveBeenCalled();
  });

  it("preserves edits made while a page asset is being renewed", async () => {
    native.openProjectForEditor.mockResolvedValue({
      outcome: "opened",
      project: populatedNativeProject("workspace-open"),
    });
    native.materializeProjectV2Asset.mockResolvedValue({
      token: "a".repeat(64),
      digest: "b".repeat(64),
      mimeType: "image/png",
      byteLength: 42,
      expiresAfterSeconds: 600,
    });
    const onError = vi.fn();
    const { result } = renderHook(() => useProjectV2(onError));
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    await act(async () => {
      await result.current.openProject();
    });

    let resolveMaterialization:
      | ((value: {
          token: string;
          digest: string;
          mimeType: string;
          byteLength: number;
          expiresAfterSeconds: number;
        }) => void)
      | null = null;
    native.materializeProjectV2Asset.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveMaterialization = resolve;
      }),
    );
    let selection: Promise<void> | undefined;
    act(() => {
      selection = result.current.setActivePage("page-primary");
    });
    act(() => {
      result.current.updatePage("page-primary", { extractedText: "edit during renewal" });
    });
    await act(async () => {
      resolveMaterialization?.({
        token: "c".repeat(64),
        digest: "b".repeat(64),
        mimeType: "image/png",
        byteLength: 42,
        expiresAfterSeconds: 600,
      });
      await selection;
    });

    expect(result.current.activePage).toMatchObject({
      extractedText: "edit during renewal",
      sourceUrl: `http://gamebook-media.localhost/${"c".repeat(64)}`,
    });
    expect(onError).not.toHaveBeenCalled();
  });

  it("recovers a protected workspace through its opaque id", async () => {
    native.listProjectV2Recovery.mockResolvedValue([
      {
        workspaceId: "workspace-recovery",
        projectId: "project-alpha",
        state: "dirty",
        protectedClasses: ["unsaved"],
      },
    ]);
    native.recoverProjectV2Workspace.mockResolvedValue(
      populatedNativeProject("workspace-recovery"),
    );
    native.materializeProjectV2Asset.mockResolvedValue({
      token: "d".repeat(64),
      digest: "b".repeat(64),
      mimeType: "image/png",
      byteLength: 42,
      expiresAfterSeconds: 600,
    });
    const onError = vi.fn();
    const { result } = renderHook(() => useProjectV2(onError));
    await waitFor(() => expect(result.current.recovery).toHaveLength(1));

    await act(async () => {
      expect(await result.current.recoverProject("workspace-recovery")).toBe(true);
    });

    expect(native.recoverProjectV2Workspace).toHaveBeenCalledWith(
      "workspace-recovery",
    );
    expect(result.current.project.workspaceId).toBe("workspace-recovery");
    expect(result.current.project.requiresSaveAs).toBe(true);
    expect(result.current.recovery).toEqual([]);
    expect(native.closeProjectV2Workspace).not.toHaveBeenCalled();
  });
});

interface NativeProjectFixture {
  workspaceId: string;
  projectId: string;
  manifest: {
    formatVersion: number;
    minimumReaderVersion: number;
    projectId: string;
    title: string;
    createdAt: string;
    updatedAt: string;
    activePageId: string | null;
    recordOrder: Record<string, string[]> & {
      pages: string[];
      evidence: string[];
    };
    assets: unknown[];
  };
  records: unknown[];
  reusedWorkspace: boolean;
  copyDetected: boolean;
  recoveryRequired: boolean;
}

function emptyNativeProject(workspaceId: string): NativeProjectFixture {
  const now = "2026-08-03T00:00:00Z";
  return {
    workspaceId,
    projectId: "project-alpha",
    manifest: {
      formatVersion: 2,
      minimumReaderVersion: 2,
      projectId: "project-alpha",
      title: "Untitled gamebook",
      createdAt: now,
      updatedAt: now,
      activePageId: null,
      recordOrder: {
        pages: [],
        evidence: [],
        timelines: [],
        findings: [],
        tags: [],
        collections: [],
        relationships: [],
        sessions: [],
        trash: [],
      },
      assets: [],
    },
    records: [],
    reusedWorkspace: false,
    copyDetected: false,
    recoveryRequired: false,
  };
}

function populatedNativeProject(workspaceId: string) {
  const project = emptyNativeProject(workspaceId);
  project.manifest.activePageId = "page-primary";
  project.manifest.recordOrder.pages = ["page-primary"];
  project.manifest.recordOrder.evidence = ["evidence-primary"];
  project.manifest.assets = [
    {
      digest: "b".repeat(64),
      byteLength: 42,
      mediaClass: "image",
      mimeType: "image/png",
      extension: "png",
      storageMethod: "stored",
    },
  ];
  project.records = [
    {
      recordType: "evidence",
      recordVersion: 1,
      id: "evidence-primary",
      title: "Screenshot",
      createdAt: "2026-08-03T00:00:00Z",
      updatedAt: "2026-08-03T00:00:00Z",
      kind: "screenshot",
      sessionId: null,
      tagIds: [],
      provenance: {
        origin: "migration",
        parentEvidenceIds: [],
        importedAt: null,
        originalFilename: null,
      },
      assetDigest: "b".repeat(64),
      image: {
        width: 1600,
        height: 900,
        colorSpace: "srgb",
        monitorLabel: "Display 1",
      },
    },
    {
      recordType: "page",
      recordVersion: 1,
      id: "page-primary",
      title: "1",
      createdAt: "2026-08-03T00:00:00Z",
      updatedAt: "2026-08-03T00:00:00Z",
      primaryEvidenceId: "evidence-primary",
      backgroundColor: "#f7f7f5",
      placements: [
        {
          type: "MediaPlacement",
          placementVersion: 1,
          id: "placement-primary",
          evidenceId: "evidence-primary",
          left: 68,
          top: 112,
          scaleX: 0.75,
          scaleY: 0.75,
          angle: 0,
          zIndex: 0,
        },
      ],
      annotations: [],
      annotationOrder: [],
      connectors: [],
      notes: "",
    },
  ];
  return project;
}

function migrationReport() {
  return {
    recordType: "migration-report",
    reportVersion: 1,
    migrationId: "migration-primary",
    sourceFormat: "gzip-json-v1",
    targetFormat: "zip64-v2",
    sourceSha256: "e".repeat(64),
    status: "passed",
    startedAt: "2026-08-03T00:00:00Z",
    completedAt: "2026-08-03T00:00:01Z",
    idMappings: [],
    assetResults: [],
    pageResults: [],
    renderDiff: {
      width: 1600,
      height: 900,
      perChannelThreshold: 8,
      pixelsOverThresholdRatio: 0,
      maximumAllowedRatio: 0.001,
      passed: true,
    },
    messages: [],
    sourceMutated: false,
  };
}
