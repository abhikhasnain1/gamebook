import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { createDemoCapture } from "../lib/demoCapture";
import {
  autosaveProjectV2Workspace,
  cancelProjectV2Operation,
  claimScreenshotCapture,
  closeProjectV2Workspace,
  createProjectV2,
  evictProjectV2CleanCache,
  isTauri,
  listProjectV2Recovery,
  materializeProjectV2Asset,
  onCaptureError,
  onScreenshotCapture,
  openProjectForEditor,
  projectV2MediaUrl,
  readProjectV2Record,
  recoverProjectV2Workspace,
  saveProjectV2,
  stageProjectV2Document,
  type EditorProjectOpenOutcome,
  type ProjectV1MigrationReport,
  type ProjectV2OpenResult,
  type ProjectV2CacheResult,
  type ProjectV2RecoverySummary,
  type ProjectV2RepairReport,
  type ProjectV2SaveResult,
  type ScreenshotCaptureEvent,
} from "../lib/native";
import {
  editorProjectDocuments,
  editorProjectFromNative,
  type EditorPage,
  type EditorProject,
  type ProjectV2ScreenshotEvidenceRecord,
} from "../types/projectV2";
import { defaultScreenshotLayout } from "../types/session";

export type ProjectReportState =
  | { kind: "migration"; report: ProjectV1MigrationReport }
  | { kind: "repair"; report: ProjectV2RepairReport }
  | { kind: "future-version" };

const PENDING_WORKSPACE_ID = "pending-native-workspace";

interface ProjectV2State {
  project: EditorProject;
  setProject: Dispatch<SetStateAction<EditorProject>>;
  activePage: EditorPage | null;
  hydrated: boolean;
  report: ProjectReportState | null;
  dismissReport: () => void;
  recovery: ProjectV2RecoverySummary[];
  operationActive: boolean;
  cancelOperation: () => Promise<boolean>;
  openProject: () => Promise<EditorProjectOpenOutcome | null>;
  recoverProject: (workspaceId: string) => Promise<boolean>;
  cleanCache: () => Promise<ProjectV2CacheResult | null>;
  saveProject: (
    projectOverride?: EditorProject,
    saveAs?: boolean,
    replaceExternal?: boolean,
  ) => Promise<ProjectV2SaveResult | null>;
  autosaveProject: (projectOverride?: EditorProject) => Promise<void>;
  setActivePage: (pageId: string) => Promise<void>;
  materializePageForUse: (pageId: string) => Promise<EditorPage | null>;
  updatePage: (pageId: string, patch: Partial<EditorPage>) => void;
  removePage: (pageId: string) => void;
  duplicatePage: (pageId: string) => void;
  reorderPage: (sourcePageId: string, targetPageId: string) => void;
}

export function useProjectV2(onError: (message: string) => void): ProjectV2State {
  const [project, setProjectState] = useState<EditorProject>(() =>
    browserProject(isTauri ? PENDING_WORKSPACE_ID : "browser-workspace"),
  );
  const [hydrated, setHydrated] = useState(false);
  const [report, setReport] = useState<ProjectReportState | null>(null);
  const [recovery, setRecovery] = useState<ProjectV2RecoverySummary[]>([]);
  const [activeOperationId, setActiveOperationId] = useState<string | null>(null);
  const projectRef = useRef(project);
  const captureWorkspacePromiseRef = useRef<Promise<EditorProject> | null>(null);
  const captureQueueRef = useRef<Promise<void>>(Promise.resolve());

  const setProject = useCallback<Dispatch<SetStateAction<EditorProject>>>((update) => {
    const next =
      typeof update === "function"
        ? update(projectRef.current)
        : update;
    projectRef.current = next;
    setProjectState(next);
  }, []);

  const materializePage = useCallback(
    async (current: EditorProject, pageId: string): Promise<EditorProject> => {
      const page = current.pages.find((candidate) => candidate.id === pageId);
      if (!page || !isTauri) return current;
      const asset = await materializeProjectV2Asset(
        current.workspaceId,
        page.assetDigest,
        crypto.randomUUID(),
      );
      if (!asset) return current;
      const sourceUrl = projectV2MediaUrl(asset.token);
      return {
        ...current,
        pages: current.pages.map((candidate) =>
          candidate.id === pageId ? { ...candidate, sourceUrl } : candidate,
        ),
      };
    },
    [],
  );

  const loadNativeProject = useCallback(
    async (
      result: ProjectV2OpenResult,
      requiresSaveAs: boolean,
    ): Promise<EditorProject> => {
      const manifest = result.manifest as {
        activePageId: string | null;
        recordOrder: { pages: string[]; evidence: string[] };
      };
      const records = [...result.records];
      const loaded = new Set(
        records.flatMap((value) => {
          const record = value as { recordType?: string; id?: string };
          return record.recordType && record.id
            ? [`${record.recordType}:${record.id}`]
            : [];
        }),
      );
      const missing = [
        ...manifest.recordOrder.pages.map((id) => ["page", id] as const),
        ...manifest.recordOrder.evidence.map((id) => ["evidence", id] as const),
      ].filter(([type, id]) => !loaded.has(`${type}:${id}`));
      records.push(
        ...(await Promise.all(
          missing.map(([type, id]) =>
            readProjectV2Record(result.workspaceId, type, id),
          ),
        )),
      );
      let loadedProject = editorProjectFromNative(
        { ...result, records },
        requiresSaveAs,
      );
      if (manifest.activePageId) {
        loadedProject = await materializePage(loadedProject, manifest.activePageId);
      }
      return loadedProject;
    },
    [materializePage],
  );

  const ensureCaptureWorkspace = useCallback(async (): Promise<EditorProject> => {
    if (projectRef.current.workspaceId !== PENDING_WORKSPACE_ID) {
      return projectRef.current;
    }
    const existing = captureWorkspacePromiseRef.current;
    if (existing) return existing;

    const pending = createProjectV2()
      .then(async (created) => {
        if (!created) throw new Error("Could not create an unsaved project workspace.");
        const project = editorProjectFromNative(created, true);
        if (projectRef.current.workspaceId !== PENDING_WORKSPACE_ID) {
          await closeProjectV2Workspace(project.workspaceId);
          return projectRef.current;
        }
        setProject(project);
        return project;
      })
      .finally(() => {
        if (captureWorkspacePromiseRef.current === pending) {
          captureWorkspacePromiseRef.current = null;
        }
      });
    captureWorkspacePromiseRef.current = pending;
    return pending;
  }, [setProject]);

  const addCapture = useCallback(
    async (capture: ScreenshotCaptureEvent) => {
      const current = await ensureCaptureWorkspace();
      const asset = await claimScreenshotCapture(current.workspaceId, capture.captureId);
      if (!asset) return;
      const now = capture.capturedAt;
      const evidenceId = crypto.randomUUID();
      const pageId = crypto.randomUUID();
      const placementId = crypto.randomUUID();
      const evidence: ProjectV2ScreenshotEvidenceRecord = {
        recordType: "evidence",
        recordVersion: 1,
        id: evidenceId,
        title: `Screenshot ${current.pages.length + 1}`,
        createdAt: now,
        updatedAt: now,
        kind: "screenshot",
        sessionId: null,
        tagIds: [],
        provenance: {
          origin: "capture",
          parentEvidenceIds: [],
          importedAt: null,
          originalFilename: null,
        },
        assetDigest: asset.digest,
        image: {
          width: capture.width,
          height: capture.height,
          colorSpace: "srgb",
          monitorLabel: capture.monitorName || null,
        },
      };
      const layout = defaultScreenshotLayout(capture.width, capture.height);
      const page: EditorPage = {
        id: pageId,
        title: String(current.pages.length + 1),
        createdAt: now,
        updatedAt: now,
        evidenceId,
        assetDigest: asset.digest,
        monitorName: capture.monitorName || "Display",
        sourceWidth: capture.width,
        sourceHeight: capture.height,
        sourceUrl: projectV2MediaUrl(asset.token),
        thumbnailUrl: null,
        placement: {
          type: "MediaPlacement",
          placementVersion: 1,
          id: placementId,
          evidenceId,
          ...layout,
          zIndex: 0,
        },
        annotations: { objects: [] },
        extractedText: "",
        backgroundColor: "#f7f7f5",
      };
      setProject((value) => {
        const updatedAt = new Date().toISOString();
        const next: EditorProject = {
          ...value,
          manifest: {
            ...value.manifest,
            updatedAt,
            activePageId: pageId,
            recordOrder: {
              ...value.manifest.recordOrder,
              pages: [...value.manifest.recordOrder.pages, pageId],
              evidence: [...value.manifest.recordOrder.evidence, evidenceId],
            },
            assets: [
              ...value.manifest.assets,
              {
                digest: asset.digest,
                byteLength: asset.byteLength,
                mediaClass: "image",
                mimeType: "image/png",
                extension: "png",
                storageMethod: "stored",
              },
            ],
          },
          pages: [...value.pages, page],
          evidence: { ...value.evidence, [evidenceId]: evidence },
        };
        projectRef.current = next;
        return next;
      });
    },
    [ensureCaptureWorkspace],
  );

  useEffect(() => {
    let cancelled = false;
    const cleanups: Array<() => void> = [];
    const initialize = async () => {
      if (isTauri) {
        const summaries = await listProjectV2Recovery();
        if (!cancelled) setRecovery(summaries);
      } else if (
        import.meta.env.DEV &&
        new URLSearchParams(window.location.search).has("demo")
      ) {
        const demo = browserProject();
        const capture = createDemoCapture();
        const first = browserCapturePage(capture.dataUrl, 1, capture.width, capture.height);
        const second = browserCapturePage(capture.dataUrl, 2, capture.width, capture.height);
        demo.pages = [first, second];
        demo.evidence = Object.fromEntries(
          demo.pages.map((page) => [page.evidenceId, browserEvidence(page)]),
        );
        demo.manifest.activePageId = first.id;
        demo.manifest.recordOrder.pages = demo.pages.map((page) => page.id);
        demo.manifest.recordOrder.evidence = demo.pages.map((page) => page.evidenceId);
        setProject(demo);
        projectRef.current = demo;
      }
      if (!cancelled) setHydrated(true);
    };
    void initialize().catch((error: unknown) => onError(String(error)));
    void onScreenshotCapture((capture) => {
      captureQueueRef.current = captureQueueRef.current
        .then(() => addCapture(capture))
        .catch((error: unknown) => onError(String(error)));
    }).then((cleanup) => cleanups.push(cleanup));
    void onCaptureError(onError).then((cleanup) => cleanups.push(cleanup));
    return () => {
      cancelled = true;
      cleanups.forEach((cleanup) => cleanup());
    };
  }, [addCapture, onError]);

  useEffect(() => {
    if (
      !hydrated ||
      !isTauri ||
      project.workspaceId === PENDING_WORKSPACE_ID
    ) return;
    let idleHandle: number | null = null;
    const timeout = window.setTimeout(() => {
      idleHandle = window.requestIdleCallback(() => {
        idleHandle = null;
        void stageAndAutosave(projectRef.current).catch((error: unknown) =>
          onError(String(error)),
        );
      }, { timeout: 4000 });
    }, 4000);
    return () => {
      window.clearTimeout(timeout);
      if (idleHandle !== null) window.cancelIdleCallback(idleHandle);
    };
  }, [hydrated, onError, project.manifest.updatedAt]);

  const openProject = useCallback(async () => {
    const operationId = crypto.randomUUID();
    setActiveOperationId(operationId);
    let outcome: EditorProjectOpenOutcome | null;
    try {
      outcome = await openProjectForEditor(operationId);
    } finally {
      setActiveOperationId(null);
    }
    if (!outcome) return null;
    if (outcome.outcome === "repair") {
      setReport({ kind: "repair", report: outcome.report });
      return outcome;
    }
    if (outcome.outcome === "future-version-rejected") {
      setReport({ kind: "future-version" });
      return outcome;
    }
    const previousWorkspace = projectRef.current.workspaceId;
    const loaded = await loadNativeProject(
      outcome.project,
      outcome.outcome === "migrated",
    );
    setProject(loaded);
    projectRef.current = loaded;
    if (outcome.outcome === "migrated") {
      setReport({ kind: "migration", report: outcome.project.report });
    }
    if (
      isTauri &&
      previousWorkspace !== PENDING_WORKSPACE_ID &&
      previousWorkspace !== loaded.workspaceId
    ) {
      await closeProjectV2Workspace(previousWorkspace);
    }
    return outcome;
  }, [loadNativeProject]);

  const recoverProject = useCallback(
    async (workspaceId: string) => {
      const result = await recoverProjectV2Workspace(workspaceId);
      if (!result) return false;
      const previousWorkspace = projectRef.current.workspaceId;
      const loaded = await loadNativeProject(result, true);
      setProject(loaded);
      projectRef.current = loaded;
      setRecovery((current) =>
        current.filter((summary) => summary.workspaceId !== workspaceId),
      );
      if (
        isTauri &&
        previousWorkspace !== PENDING_WORKSPACE_ID &&
        previousWorkspace !== loaded.workspaceId
      ) {
        await closeProjectV2Workspace(previousWorkspace);
      }
      return true;
    },
    [loadNativeProject],
  );

  const cleanCache = useCallback(async () => {
    const operationId = crypto.randomUUID();
    setActiveOperationId(operationId);
    try {
      return await evictProjectV2CleanCache(0, operationId);
    } finally {
      setActiveOperationId(null);
    }
  }, []);

  const saveProject = useCallback(
    async (
      projectOverride = projectRef.current,
      saveAs = projectOverride.requiresSaveAs,
      replaceExternal = false,
    ) => {
      await stageProject(projectOverride);
      const operationId = crypto.randomUUID();
      setActiveOperationId(operationId);
      let result: ProjectV2SaveResult | null;
      try {
        result = await saveProjectV2(
          projectOverride.workspaceId,
          saveAs,
          replaceExternal ? "replace" : "cancel",
          operationId,
        );
      } finally {
        setActiveOperationId(null);
      }
      if (result) {
        setProject((current) => {
          const next = { ...current, requiresSaveAs: false };
          projectRef.current = next;
          return next;
        });
      }
      return result;
    },
    [],
  );

  const setActivePage = useCallback(
    async (pageId: string) => {
      const starting = projectRef.current;
      if (!starting.pages.some((page) => page.id === pageId)) return;
      const loaded = await materializePage(starting, pageId);
      if (projectRef.current.workspaceId !== starting.workspaceId) return;
      const sourceUrl = loaded.pages.find((page) => page.id === pageId)?.sourceUrl;
      const updatedAt = new Date().toISOString();
      setProject((current) => ({
        ...current,
        manifest: { ...current.manifest, activePageId: pageId, updatedAt },
        pages: current.pages.map((page) =>
          page.id === pageId && sourceUrl ? { ...page, sourceUrl } : page,
        ),
      }));
    },
    [materializePage],
  );

  const materializePageForUse = useCallback(
    async (pageId: string) => {
      const starting = projectRef.current;
      if (!starting.pages.some((page) => page.id === pageId)) return null;
      const loaded = await materializePage(starting, pageId);
      if (projectRef.current.workspaceId !== starting.workspaceId) return null;
      const sourceUrl = loaded.pages.find((page) => page.id === pageId)?.sourceUrl;
      if (sourceUrl) {
        setProject((current) => ({
          ...current,
          pages: current.pages.map((page) =>
            page.id === pageId ? { ...page, sourceUrl } : page,
          ),
        }));
      }
      return projectRef.current.pages.find((page) => page.id === pageId) ?? null;
    },
    [materializePage],
  );

  const updatePage = useCallback((pageId: string, patch: Partial<EditorPage>) => {
    setProject((current) => {
      const updatedAt = new Date().toISOString();
      const next = {
        ...current,
        manifest: { ...current.manifest, updatedAt },
        pages: current.pages.map((page) =>
          page.id === pageId ? { ...page, ...patch, updatedAt } : page,
        ),
      };
      projectRef.current = next;
      return next;
    });
  }, []);

  const removePage = useCallback((pageId: string) => {
    setProject((current) => {
      const index = current.pages.findIndex((page) => page.id === pageId);
      const removed = current.pages[index];
      if (!removed) return current;
      const remaining = numberEditorPages(
        current.pages.filter((page) => page.id !== pageId),
      );
      const evidenceStillUsed = remaining.some(
        (page) => page.evidenceId === removed.evidenceId,
      );
      const evidence = { ...current.evidence };
      if (!evidenceStillUsed) delete evidence[removed.evidenceId];
      const referencedDigests = new Set(
        Object.values(evidence).map((record) => record.assetDigest),
      );
      const fallback = remaining[Math.min(index, remaining.length - 1)] ?? null;
      const updatedAt = new Date().toISOString();
      const next = {
        ...current,
        manifest: {
          ...current.manifest,
          updatedAt,
          activePageId:
            current.manifest.activePageId === pageId
              ? fallback?.id ?? null
              : current.manifest.activePageId,
          recordOrder: {
            ...current.manifest.recordOrder,
            pages: remaining.map((page) => page.id),
            evidence: current.manifest.recordOrder.evidence.filter(
              (id) => id !== removed.evidenceId || evidenceStillUsed,
            ),
          },
          assets: current.manifest.assets.filter((asset) =>
            referencedDigests.has(asset.digest),
          ),
        },
        pages: remaining,
        evidence,
      };
      projectRef.current = next;
      return next;
    });
  }, []);

  const duplicatePage = useCallback((pageId: string) => {
    setProject((current) => {
      const sourceIndex = current.pages.findIndex((page) => page.id === pageId);
      const source = current.pages[sourceIndex];
      if (!source) return current;
      const now = new Date().toISOString();
      const duplicate: EditorPage = {
        ...source,
        id: crypto.randomUUID(),
        title: String(sourceIndex + 2),
        createdAt: now,
        updatedAt: now,
        placement: { ...source.placement, id: crypto.randomUUID() },
        annotations: { objects: [] },
        extractedText: "",
        thumbnailUrl: source.sourceUrl,
      };
      const pages = [...current.pages];
      pages.splice(sourceIndex + 1, 0, duplicate);
      const numbered = numberEditorPages(pages);
      const next = {
        ...current,
        manifest: {
          ...current.manifest,
          updatedAt: now,
          activePageId: duplicate.id,
          recordOrder: {
            ...current.manifest.recordOrder,
            pages: numbered.map((page) => page.id),
          },
        },
        pages: numbered,
      };
      projectRef.current = next;
      return next;
    });
  }, []);

  const reorderPage = useCallback((sourcePageId: string, targetPageId: string) => {
    if (sourcePageId === targetPageId) return;
    setProject((current) => {
      const sourceIndex = current.pages.findIndex((page) => page.id === sourcePageId);
      const targetIndex = current.pages.findIndex((page) => page.id === targetPageId);
      if (sourceIndex < 0 || targetIndex < 0) return current;
      const pages = [...current.pages];
      const [moved] = pages.splice(sourceIndex, 1);
      pages.splice(targetIndex, 0, moved);
      const numbered = numberEditorPages(pages);
      const updatedAt = new Date().toISOString();
      const next = {
        ...current,
        manifest: {
          ...current.manifest,
          updatedAt,
          recordOrder: {
            ...current.manifest.recordOrder,
            pages: numbered.map((page) => page.id),
          },
        },
        pages: numbered,
      };
      projectRef.current = next;
      return next;
    });
  }, []);

  return {
    project,
    setProject,
    activePage:
      project.pages.find((page) => page.id === project.manifest.activePageId) ?? null,
    hydrated,
    report,
    dismissReport: () => setReport(null),
    recovery,
    operationActive: activeOperationId !== null,
    cancelOperation: () =>
      activeOperationId
        ? cancelProjectV2Operation(activeOperationId)
        : Promise.resolve(false),
    openProject,
    recoverProject,
    cleanCache,
    saveProject,
    autosaveProject: (projectOverride = projectRef.current) =>
      stageAndAutosave(projectOverride),
    setActivePage,
    materializePageForUse,
    updatePage,
    removePage,
    duplicatePage,
    reorderPage,
  };
}

async function stageProject(project: EditorProject): Promise<void> {
  if (!isTauri || project.workspaceId === PENDING_WORKSPACE_ID) return;
  const [manifest, ...records] = editorProjectDocuments(project);
  for (const document of records) {
    await stageProjectV2Document(project.workspaceId, document);
  }
  await stageProjectV2Document(project.workspaceId, manifest);
}

async function stageAndAutosave(project: EditorProject): Promise<void> {
  if (project.workspaceId === PENDING_WORKSPACE_ID) return;
  await stageProject(project);
  await autosaveProjectV2Workspace(project.workspaceId);
}

function numberEditorPages(pages: EditorPage[]): EditorPage[] {
  return pages.map((page, index) => ({ ...page, title: String(index + 1) }));
}

function browserProject(workspaceId = "browser-workspace"): EditorProject {
  const now = new Date().toISOString();
  return {
    formatVersion: 2,
    workspaceId,
    requiresSaveAs: true,
    manifest: {
      formatVersion: 2,
      minimumReaderVersion: 2,
      projectId: "browser-project",
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
    pages: [],
    evidence: {},
  };
}

function browserCapturePage(
  sourceUrl: string,
  pageNumber: number,
  width: number,
  height: number,
): EditorPage {
  const now = new Date().toISOString();
  const evidenceId = crypto.randomUUID();
  return {
    id: crypto.randomUUID(),
    title: String(pageNumber),
    createdAt: now,
    updatedAt: now,
    evidenceId,
    assetDigest: "d".repeat(64),
    monitorName: "Demo display",
    sourceWidth: width,
    sourceHeight: height,
    sourceUrl,
    thumbnailUrl: sourceUrl,
    placement: {
      type: "MediaPlacement",
      placementVersion: 1,
      id: crypto.randomUUID(),
      evidenceId,
      ...defaultScreenshotLayout(width, height),
      zIndex: 0,
    },
    annotations: { objects: [] },
    extractedText: "",
    backgroundColor: "#f7f7f5",
  };
}

function browserEvidence(page: EditorPage): ProjectV2ScreenshotEvidenceRecord {
  return {
    recordType: "evidence",
    recordVersion: 1,
    id: page.evidenceId,
    title: `Screenshot ${page.title}`,
    createdAt: page.createdAt,
    updatedAt: page.updatedAt,
    kind: "screenshot",
    sessionId: null,
    tagIds: [],
    provenance: {
      origin: "capture",
      parentEvidenceIds: [],
      importedAt: null,
      originalFilename: null,
    },
    assetDigest: page.assetDigest,
    image: {
      width: page.sourceWidth,
      height: page.sourceHeight,
      colorSpace: "srgb",
      monitorLabel: page.monitorName,
    },
  };
}
