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
  listProjectV2Trash,
  listProjectV2Recovery,
  materializeProjectV2Asset,
  onCaptureError,
  onScreenshotCapture,
  openProjectForEditor,
  projectV2MediaUrl,
  readProjectV2Record,
  recoverProjectV2Workspace,
  restoreProjectV2Trash,
  reviewProjectV2TrashImpact,
  saveProjectV2,
  stageProjectV2Document,
  trashProjectV2Records,
  emptyProjectV2Trash,
  type EditorProjectOpenOutcome,
  type ProjectV1MigrationReport,
  type ProjectV2OpenResult,
  type ProjectV2CacheResult,
  type ProjectV2RecoverySummary,
  type ProjectV2RepairReport,
  type ProjectV2SaveResult,
  type ScreenshotCaptureEvent,
  type TrashImpact,
  type TrashMutationResult,
  type TrashState,
  type TrashTarget,
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
  trash: TrashState;
  refreshTrash: () => Promise<TrashState>;
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
  reviewPageDeletion: (pageId: string) => Promise<TrashImpact | null>;
  commitTrash: (targets: TrashTarget[], retentionDays: number) => Promise<boolean>;
  restoreTrash: (transactionId: string) => Promise<boolean>;
  emptyTrash: (eligibleOnly: boolean) => Promise<boolean>;
}

export function useProjectV2(onError: (message: string) => void): ProjectV2State {
  const [project, setProjectState] = useState<EditorProject>(() =>
    browserProject(isTauri ? PENDING_WORKSPACE_ID : "browser-workspace"),
  );
  const [hydrated, setHydrated] = useState(false);
  const [report, setReport] = useState<ProjectReportState | null>(null);
  const [recovery, setRecovery] = useState<ProjectV2RecoverySummary[]>([]);
  const [trash, setTrash] = useState<TrashState>(emptyTrashState);
  const [activeOperationId, setActiveOperationId] = useState<string | null>(null);
  const projectRef = useRef(project);
  const captureWorkspacePromiseRef = useRef<Promise<EditorProject> | null>(null);
  const captureQueueRef = useRef<Promise<void>>(Promise.resolve());
  const workspaceMutationQueueRef = useRef<Promise<void>>(Promise.resolve());
  const workspaceSynchronizationBlockedRef = useRef(false);
  const projectWriteBarrierRef = useRef(false);
  const pendingProjectUpdatesRef = useRef<Array<(current: EditorProject) => EditorProject>>([]);

  const serializeWorkspaceMutation = useCallback(
    <T,>(operation: () => Promise<T>): Promise<T> => {
      const result = workspaceMutationQueueRef.current.then(operation, operation);
      workspaceMutationQueueRef.current = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
    [],
  );

  const publishProject = useCallback((next: EditorProject) => {
    projectRef.current = next;
    setProjectState(next);
  }, []);

  const setProject = useCallback<Dispatch<SetStateAction<EditorProject>>>((update) => {
    if (projectWriteBarrierRef.current) {
      const resolve = typeof update === "function"
        ? update
        : (current: EditorProject) => rebaseProjectValue(current, update);
      pendingProjectUpdatesRef.current.push(resolve);
      return;
    }
    publishProject(
      typeof update === "function" ? update(projectRef.current) : update,
    );
  }, [publishProject]);

  const releaseProjectWrites = useCallback((base: EditorProject): EditorProject => {
    projectWriteBarrierRef.current = false;
    const pending = pendingProjectUpdatesRef.current.splice(0);
    const next = pending.reduce(
      (current, update) => update(current),
      base,
    );
    publishProject(next);
    return next;
  }, [publishProject]);

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
        recordOrder: Record<string, string[]>;
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
      const recordTypes = [
        ["page", "pages"],
        ["evidence", "evidence"],
      ] as const;
      const missing = recordTypes
        .flatMap(([type, list]) =>
          (manifest.recordOrder[list] ?? []).map((id) => [type, id] as const),
        )
        .filter(([type, id]) => !loaded.has(`${type}:${id}`));
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

  const readTrashState = useCallback(async (): Promise<TrashState> => {
    const current = projectRef.current;
    if (!isTauri || current.workspaceId === PENDING_WORKSPACE_ID) {
      const state = emptyTrashState();
      setTrash(state);
      return state;
    }
    const state = await listProjectV2Trash(current.workspaceId);
    if (projectRef.current.workspaceId !== current.workspaceId) {
      throw new Error("The project changed while Project Trash was refreshing. Try again.");
    }
    setTrash(state);
    return state;
  }, []);

  const refreshTrash = useCallback(
    (): Promise<TrashState> => serializeWorkspaceMutation(readTrashState),
    [readTrashState, serializeWorkspaceMutation],
  );

  const applyTrashMutation = useCallback(
    async (result: TrashMutationResult) => {
      const current = projectRef.current;
      if (result.project.workspaceId !== current.workspaceId) {
        if (projectWriteBarrierRef.current) releaseProjectWrites(current);
        return false;
      }
      workspaceSynchronizationBlockedRef.current = true;
      setTrash(result.state);
      let authoritative: EditorProject;
      try {
        authoritative = editorProjectFromNative(
          result.project,
          current.requiresSaveAs,
        );
      } catch (error) {
        releaseProjectWrites(current);
        throw error;
      }
      const reconciled = releaseProjectWrites(authoritative);
      workspaceSynchronizationBlockedRef.current = false;
      const activePageId = reconciled.manifest.activePageId;
      if (!activePageId) return true;
      const loaded = await materializePage(reconciled, activePageId);
      if (projectRef.current.workspaceId !== reconciled.workspaceId) return false;
      const sourceUrl = loaded.pages.find((page) => page.id === activePageId)?.sourceUrl;
      if (sourceUrl) {
        setProject((latest) => ({
          ...latest,
          pages: latest.pages.map((page) =>
            page.id === activePageId ? { ...page, sourceUrl } : page,
          ),
        }));
      }
      return true;
    },
    [materializePage, releaseProjectWrites, setProject],
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
    async (capture: ScreenshotCaptureEvent) =>
      serializeWorkspaceMutation(async () => {
        assertWorkspaceSynchronized(workspaceSynchronizationBlockedRef);
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
      }),
    [ensureCaptureWorkspace, serializeWorkspaceMutation],
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
        void serializeWorkspaceMutation(() => {
          assertWorkspaceSynchronized(workspaceSynchronizationBlockedRef);
          return stageAndAutosave(projectRef.current);
        })
          .catch((error: unknown) => onError(String(error)));
      }, { timeout: 4000 });
    }, 4000);
    return () => {
      window.clearTimeout(timeout);
      if (idleHandle !== null) window.cancelIdleCallback(idleHandle);
    };
  }, [hydrated, onError, project.manifest.updatedAt, serializeWorkspaceMutation]);

  useEffect(() => {
    if (!hydrated || project.workspaceId === PENDING_WORKSPACE_ID) return;
    let cancelled = false;
    void refreshTrash()
      .catch((error: unknown) => {
        if (!cancelled) onError(String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [hydrated, onError, project.workspaceId, refreshTrash]);

  const openProject = useCallback(
    () => serializeWorkspaceMutation(async () => {
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
      workspaceSynchronizationBlockedRef.current = false;
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
    }),
    [loadNativeProject, serializeWorkspaceMutation, setProject],
  );

  const recoverProject = useCallback(
    (workspaceId: string) => serializeWorkspaceMutation(async () => {
      const result = await recoverProjectV2Workspace(workspaceId);
      if (!result) return false;
      const previousWorkspace = projectRef.current.workspaceId;
      const loaded = await loadNativeProject(result, true);
      setProject(loaded);
      workspaceSynchronizationBlockedRef.current = false;
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
    }),
    [loadNativeProject, serializeWorkspaceMutation, setProject],
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
    ) =>
      serializeWorkspaceMutation(async () => {
        assertWorkspaceSynchronized(workspaceSynchronizationBlockedRef);
        const current = latestWorkspaceProject(projectOverride, projectRef.current);
        await stageProject(current);
        const operationId = crypto.randomUUID();
        setActiveOperationId(operationId);
        let result: ProjectV2SaveResult | null;
        try {
          result = await saveProjectV2(
            current.workspaceId,
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
      }),
    [serializeWorkspaceMutation],
  );

  const setActivePage = useCallback(
    (pageId: string) => serializeWorkspaceMutation(async () => {
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
    }),
    [materializePage, serializeWorkspaceMutation],
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
        canonicalPage: undefined,
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

  const reviewPageDeletion = useCallback(
    (pageId: string) =>
      serializeWorkspaceMutation(async () => {
        assertWorkspaceSynchronized(workspaceSynchronizationBlockedRef);
        const currentTrash = await readTrashState();
        let current = projectRef.current;
        let page = current.pages.find((candidate) => candidate.id === pageId);
        if (!page) return null;
        const alreadyTrashed = currentTrash.transactions.some((transaction) =>
          transaction.records.some(
            (record) =>
              record.originalRecordType === "page" &&
              record.originalRecordId === pageId,
          ),
        );
        if (alreadyTrashed) {
          throw new Error(
            "This page is already in Project Trash. Open Project storage to restore it.",
          );
        }
        current = await stageStableProject(() => projectRef.current);
        page = current.pages.find((candidate) => candidate.id === pageId);
        if (!page) return null;
        const targets: TrashTarget[] = [{ recordType: "page", recordId: page.id }];
        if (!current.pages.some(
          (candidate) =>
            candidate.id !== page.id && candidate.evidenceId === page.evidenceId,
        )) {
          targets.push({ recordType: "evidence", recordId: page.evidenceId });
        }
        return reviewProjectV2TrashImpact(current.workspaceId, targets);
      }),
    [readTrashState, serializeWorkspaceMutation],
  );

  const commitTrash = useCallback(
    (targets: TrashTarget[], retentionDays: number) =>
      serializeWorkspaceMutation(async () => {
        assertWorkspaceSynchronized(workspaceSynchronizationBlockedRef);
        const current = await stageStableProject(() => projectRef.current);
        projectWriteBarrierRef.current = true;
        let result: TrashMutationResult | null;
        try {
          result = await trashProjectV2Records(
            current.workspaceId,
            targets,
            retentionDays,
          );
        } catch (error) {
          releaseProjectWrites(current);
          throw error;
        }
        if (result) return applyTrashMutation(result);
        releaseProjectWrites(current);
        for (const target of targets) {
          if (target.recordType === "page") removePage(target.recordId);
        }
        return true;
      }),
    [applyTrashMutation, releaseProjectWrites, removePage, serializeWorkspaceMutation],
  );

  const restoreTrash = useCallback(
    (transactionId: string) =>
      serializeWorkspaceMutation(async () => {
        const current = projectRef.current;
        projectWriteBarrierRef.current = true;
        let result: TrashMutationResult | null;
        try {
          result = await restoreProjectV2Trash(current.workspaceId, transactionId);
        } catch (error) {
          releaseProjectWrites(current);
          throw error;
        }
        if (result) return applyTrashMutation(result);
        releaseProjectWrites(current);
        return false;
      }),
    [applyTrashMutation, releaseProjectWrites, serializeWorkspaceMutation],
  );

  const emptyTrash = useCallback(
    (eligibleOnly: boolean) =>
      serializeWorkspaceMutation(async () => {
        assertWorkspaceSynchronized(workspaceSynchronizationBlockedRef);
        const current = projectRef.current;
        projectWriteBarrierRef.current = true;
        let result: TrashMutationResult | null;
        try {
          result = await emptyProjectV2Trash(
            current.workspaceId,
            null,
            eligibleOnly,
          );
        } catch (error) {
          releaseProjectWrites(current);
          throw error;
        }
        if (result) return applyTrashMutation(result);
        releaseProjectWrites(current);
        return false;
      }),
    [applyTrashMutation, releaseProjectWrites, serializeWorkspaceMutation],
  );

  return {
    project,
    setProject,
    activePage:
      project.pages.find((page) => page.id === project.manifest.activePageId) ?? null,
    hydrated,
    report,
    dismissReport: () => setReport(null),
    recovery,
    trash,
    refreshTrash,
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
      serializeWorkspaceMutation(() => {
        assertWorkspaceSynchronized(workspaceSynchronizationBlockedRef);
        return stageAndAutosave(latestWorkspaceProject(projectOverride, projectRef.current));
      }),
    setActivePage,
    materializePageForUse,
    updatePage,
    removePage,
    duplicatePage,
    reorderPage,
    reviewPageDeletion,
    commitTrash,
    restoreTrash,
    emptyTrash,
  };
}

function assertWorkspaceSynchronized(blocked: { current: boolean }): void {
  if (blocked.current) {
    throw new Error(
      "Project synchronization is incomplete. Open Project storage and restore the committed Trash transaction before continuing.",
    );
  }
}

function latestWorkspaceProject(
  requested: EditorProject,
  current: EditorProject,
): EditorProject {
  if (requested.workspaceId !== current.workspaceId) {
    throw new Error("The project changed before the workspace operation started. Try again.");
  }
  return current;
}

function rebaseProjectValue(
  current: EditorProject,
  update: EditorProject,
): EditorProject {
  if (current.workspaceId !== update.workspaceId) return current;
  const pendingPages = new Map(update.pages.map((page) => [page.id, page]));
  const evidence = Object.fromEntries(
    Object.entries(current.evidence).map(([id, record]) => [
      id,
      update.evidence[id] ?? record,
    ]),
  );
  return {
    ...current,
    requiresSaveAs: update.requiresSaveAs,
    manifest: {
      ...current.manifest,
      title: update.manifest.title,
      updatedAt: update.manifest.updatedAt,
    },
    pages: current.pages.map((page) => pendingPages.get(page.id) ?? page),
    evidence,
  };
}

async function stageStableProject(
  currentProject: () => EditorProject,
): Promise<EditorProject> {
  let current = currentProject();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const staged = current;
    await stageProject(staged);
    if (currentProject() === staged) return staged;
    if (currentProject().workspaceId !== staged.workspaceId) {
      throw new Error("The project changed while workspace data was being prepared. Try again.");
    }
    current = currentProject();
  }
  throw new Error("The project kept changing while workspace data was being prepared. Try again.");
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
    canonicalRecords: {},
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

function emptyTrashState(): TrashState {
  return {
    transactions: [],
    totalRecords: 0,
    eligibleTransactions: 0,
    retainedAssetBytes: 0,
  };
}
