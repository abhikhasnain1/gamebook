import {
  Check,
  ChevronDown,
  Download,
  FolderOpen,
  HardDrive,
  LoaderCircle,
  Minus,
  Redo2,
  Save,
  Settings,
  Undo2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { CanvasEditor, type CanvasEditorHandle } from "./components/CanvasEditor";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { ExportMenu, type ExportKind } from "./components/ExportMenu";
import { PageStrip } from "./components/PageStrip";
import { ProjectReportDialog } from "./components/ProjectReportDialog";
import { ProjectStorageDialog } from "./components/ProjectStorageDialog";
import { SettingsDialog } from "./components/SettingsDialog";
import { SaveConflictDialog } from "./components/SaveConflictDialog";
import { TrashImpactDialog } from "./components/TrashImpactDialog";
import { TooltipLayer } from "./components/TooltipLayer";
import { ToolRail } from "./components/ToolRail";
import { useProjectV2 } from "./hooks/useProjectV2";
import { useGlobalSettings } from "./hooks/useGlobalSettings";
import { pageImagesToPdf, sessionToText } from "./lib/exporters";
import {
  hideOverlay,
  onRecordingHudFallback,
  previewRecordingHud,
  quitApp,
  saveBinary,
  saveMarkdown,
  saveText,
  setGlobalShortcutsSuspended,
  type TrashImpact,
} from "./lib/native";
import type { EditorProject } from "./types/projectV2";
import type { ToolId } from "./types/session";

export default function App() {
  const [tool, setTool] = useState<ToolId>("select");
  const [color, setColor] = useState("#ef4444");
  const [strokeWidth, setStrokeWidth] = useState(6);
  const [saved, setSaved] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [quitOpen, setQuitOpen] = useState(false);
  const [saveConflictOpen, setSaveConflictOpen] = useState(false);
  const [storageOpen, setStorageOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [trashImpact, setTrashImpact] = useState<TrashImpact | null>(null);
  const [emptyTrashMode, setEmptyTrashMode] = useState<"eligible" | "all" | null>(null);
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const editorRef = useRef<CanvasEditorHandle>(null);
  const storageButtonRef = useRef<HTMLButtonElement>(null);

  const showError = useCallback((message: string) => {
    setBusyLabel(null);
    setToast(message.replace(/^Error:\s*/, ""));
  }, []);

  const globalSettings = useGlobalSettings(showError);

  useEffect(() => {
    let disposed = false;
    let unlisten: () => void = () => undefined;
    void onRecordingHudFallback((result) => {
      if (!disposed) setToast(result.message);
    }).then((dispose) => {
      if (disposed) dispose();
      else unlisten = dispose;
    });
    return () => {
      disposed = true;
      unlisten();
    };
  }, []);

  useEffect(() => {
    let suspended = false;
    const sync = () => {
      const active = document.activeElement;
      const next = document.hasFocus() && active instanceof HTMLElement && (
        active.matches("input, textarea, [contenteditable='true']")
        || active.getAttribute("role") === "textbox"
      );
      if (next === suspended) return;
      suspended = next;
      void setGlobalShortcutsSuspended(next);
    };
    const deferSync = () => window.setTimeout(sync, 0);
    document.addEventListener("focusin", sync);
    document.addEventListener("focusout", deferSync);
    window.addEventListener("focus", sync);
    window.addEventListener("blur", sync);
    sync();
    return () => {
      document.removeEventListener("focusin", sync);
      document.removeEventListener("focusout", deferSync);
      window.removeEventListener("focus", sync);
      window.removeEventListener("blur", sync);
      void setGlobalShortcutsSuspended(false);
    };
  }, []);

  const {
    project,
    setProject,
    activePage,
    setActivePage,
    updatePage,
    duplicatePage,
    reorderPage,
    hydrated,
    openProject,
    recoverProject,
    cleanCache,
    saveProject,
    autosaveProject,
    materializePageForUse,
    report,
    dismissReport,
    recovery,
    trash,
    refreshTrash,
    operationActive,
    cancelOperation,
    reviewPageDeletion,
    commitTrash,
    restoreTrash,
    emptyTrash,
  } = useProjectV2(showError);

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(null), 4200);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  useEffect(() => {
    setSaved(false);
  }, [project.manifest.updatedAt]);

  function preparedProject(): EditorProject {
    const patch = editorRef.current?.flush();
    if (!patch || !activePage) return project;
    const updatedAt = new Date().toISOString();
    const prepared = {
      ...project,
      manifest: { ...project.manifest, updatedAt },
      pages: project.pages.map((page) =>
        page.id === activePage.id ? { ...page, ...patch, updatedAt } : page,
      ),
    };
    setProject(prepared);
    return prepared;
  }

  async function handleSave() {
    try {
      const current = preparedProject();
      setBusyLabel("Saving");
      const result = await saveProject(current);
      if (result) {
        setSaved(true);
        setToast("Project saved");
      }
    } catch (error) {
      const message = String(error);
      if (message.includes("external-source-changed")) {
        setSaveConflictOpen(true);
      } else if (message.includes("operation-cancelled")) {
        setToast("Save cancelled");
      } else {
        showError(message);
      }
    } finally {
      setBusyLabel(null);
    }
  }

  async function resolveSaveConflict(saveAs: boolean, replaceExternal: boolean) {
    setSaveConflictOpen(false);
    try {
      const current = preparedProject();
      setBusyLabel(saveAs ? "Saving a copy" : "Replacing changed project");
      const result = await saveProject(current, saveAs, replaceExternal);
      if (result) {
        setSaved(true);
        setToast(saveAs ? "Project saved to a new file" : "Changed project replaced");
      }
    } catch (error) {
      const message = String(error);
      if (message.includes("operation-cancelled")) setToast("Save cancelled");
      else showError(message);
    } finally {
      setBusyLabel(null);
    }
  }

  async function handleOpen() {
    try {
      setBusyLabel("Opening project");
      const result = await openProject();
      if (result?.outcome === "opened" || result?.outcome === "migrated") {
        setSaved(result.outcome === "opened");
        setToast(result.outcome === "migrated" ? "Project migrated" : "Project opened");
      }
    } catch (error) {
      showError(String(error));
    } finally {
      setBusyLabel(null);
    }
  }

  async function handleRecover(workspaceId: string) {
    setStorageOpen(false);
    try {
      setBusyLabel("Recovering project");
      if (await recoverProject(workspaceId)) {
        setSaved(false);
        setToast("Project workspace recovered");
      }
    } catch (error) {
      showError(String(error));
    } finally {
      setBusyLabel(null);
    }
  }

  async function handleCleanCache() {
    setStorageOpen(false);
    try {
      setBusyLabel("Cleaning cache");
      const result = await cleanCache();
      if (result) {
        if (result.cancelled) {
          setToast("Cache cleanup cancelled");
        } else {
          const removed = Math.max(0, result.bytesBefore - result.bytesAfter);
          setToast(`Clean cache cleared (${formatBytes(removed)})`);
        }
      }
    } catch (error) {
      const message = String(error);
      if (message.includes("operation-cancelled")) setToast("Cache cleanup cancelled");
      else showError(message);
    } finally {
      setBusyLabel(null);
    }
  }

  async function handleOpenStorage() {
    setStorageOpen(true);
    try {
      setBusyLabel("Refreshing Project storage");
      await refreshTrash();
    } catch (error) {
      showError(String(error));
    } finally {
      setBusyLabel(null);
    }
  }

  async function handleReviewPageDeletion(pageId: string) {
    try {
      setBusyLabel("Reviewing Trash impact");
      const impact = await reviewPageDeletion(pageId);
      if (impact) setTrashImpact(impact);
    } catch (error) {
      showError(String(error));
    } finally {
      setBusyLabel(null);
    }
  }

  async function handleCommitTrash() {
    const impact = trashImpact;
    if (!impact || impact.blocked) return;
    setTrashImpact(null);
    try {
      setBusyLabel("Moving records to Project Trash");
      if (await commitTrash(impact.targets, globalSettings.settings.trash.retentionDays)) {
        setToast("Moved to Project Trash");
      }
    } catch (error) {
      showError(String(error));
    } finally {
      setBusyLabel(null);
      window.requestAnimationFrame(() => storageButtonRef.current?.focus({ preventScroll: true }));
    }
  }

  async function handleRestoreTrash(transactionId: string) {
    setStorageOpen(false);
    try {
      setBusyLabel("Restoring Project Trash");
      if (await restoreTrash(transactionId)) setToast("Trash transaction restored");
    } catch (error) {
      showError(String(error));
    } finally {
      setBusyLabel(null);
      window.requestAnimationFrame(() => storageButtonRef.current?.focus({ preventScroll: true }));
    }
  }

  async function handleEmptyTrash() {
    const mode = emptyTrashMode;
    if (!mode) return;
    setEmptyTrashMode(null);
    setStorageOpen(false);
    try {
      setBusyLabel("Emptying Project Trash");
      if (await emptyTrash(mode === "eligible")) {
        setToast(mode === "eligible" ? "Eligible Trash emptied" : "Project Trash emptied");
      }
    } catch (error) {
      showError(String(error));
    } finally {
      setBusyLabel(null);
    }
  }

  async function handleMinimize() {
    try {
      await hideOverlay();
    } catch (error) {
      showError(String(error));
      return;
    }

    // Let the native window disappear before thumbnail generation and project
    // serialization occupy the WebView thread.
    window.setTimeout(() => {
      try {
        const current = preparedProject();
        void autosaveProject(current).catch((error: unknown) => showError(String(error)));
      } catch (error) {
        showError(String(error));
      }
    }, 0);
  }

  async function handleQuit() {
    setQuitOpen(false);
    try {
      const current = preparedProject();
      await autosaveProject(current);
      await quitApp();
    } catch (error) {
      showError(String(error));
    }
  }

  function handleSelectPage(pageId: string) {
    editorRef.current?.flush();
    setActivePage(pageId);
    setTool("select");
  }

  async function renderAllPages(current: EditorProject, multiplier: number) {
    const images: string[] = [];
    for (let index = 0; index < current.pages.length; index += 1) {
      setBusyLabel(`Rendering ${index + 1} of ${current.pages.length}`);
      const page = await materializePageForUse(current.pages[index].id);
      if (!page) throw new Error("A page could not be loaded for export.");
      images.push(await editorRef.current!.renderPage(page, multiplier));
    }
    return images;
  }

  async function handleExport(kind: ExportKind) {
    setExportOpen(false);
    const current = preparedProject();
    if (!current.pages.length || !activePage) return;
    try {
      if (kind === "png") {
        setBusyLabel("Rendering PNG");
        const currentPage = await materializePageForUse(activePage.id);
        if (!currentPage) throw new Error("The current page could not be loaded for export.");
        const image = await editorRef.current!.renderPage(currentPage, 2);
        const path = await saveBinary(image, "png", "PNG image", currentPage.title);
        if (path) setToast("PNG exported");
      } else if (kind === "pdf") {
        const images = await renderAllPages(current, 1.6);
        setBusyLabel("Building PDF");
        const pdf = await pageImagesToPdf(images);
        const path = await saveBinary(
          pdf,
          "pdf",
          "PDF document",
          current.manifest.title,
        );
        if (path) setToast(`${current.pages.length}-page PDF exported`);
      } else if (kind === "markdown") {
        const images = await renderAllPages(current, 1.25);
        const pages = current.pages.map((page, index) => ({
          title: page.title,
          text: page.extractedText || "_No text notes._",
          imageDataUrl: images[index],
        }));
        const path = await saveMarkdown(current.manifest.title, pages);
        if (path) setToast("Markdown document exported");
      } else {
        const path = await saveText(
          sessionToText({ title: current.manifest.title, pages: current.pages }),
          "txt",
          "Text document",
          current.manifest.title,
        );
        if (path) setToast("Text notes exported");
      }
    } catch (error) {
      showError(String(error));
    } finally {
      setBusyLabel(null);
    }
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target.matches("input, textarea, [contenteditable='true']")) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void handleSave();
        return;
      }
      if (editorRef.current?.isTextEditing()) return;
      const shortcuts: Record<string, ToolId> = {
        v: "select",
        p: "pen",
        a: "arrow",
        k: "callout",
        l: "line",
        r: "box",
        o: "circle",
        c: "crop",
        t: "text",
      };
      const next = shortcuts[event.key.toLowerCase()];
      if (next && activePage) setTool(next);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activePage, project]);

  if (!hydrated || !globalSettings.loaded) {
    return <div className="loading-screen"><LoaderCircle /></div>;
  }

  return (
    <main className="app-shell" onClick={() => exportOpen && setExportOpen(false)}>
      <header className="topbar" data-tauri-drag-region>
        <div className="brand-mark" aria-label="Gamebook">G</div>
        <input
          className="session-title"
          value={project.manifest.title}
          aria-label="Project title"
          data-tooltip="Project name"
          data-tooltip-side="bottom"
          spellCheck={false}
          onChange={(event) =>
            setProject((current) => ({
              ...current,
              manifest: {
                ...current.manifest,
                title: event.target.value,
                updatedAt: new Date().toISOString(),
              },
            }))
          }
        />
        <div className="topbar-spacer" data-tauri-drag-region />
        {saved && <span className="saved-state"><Check /> Saved</span>}
        <button type="button" className="icon-command" data-tooltip="Open project" data-tooltip-side="bottom" aria-label="Open project" onClick={() => void handleOpen()}>
          <FolderOpen />
        </button>
        <button ref={storageButtonRef} type="button" className="icon-command" data-tooltip="Project storage" data-tooltip-side="bottom" aria-label="Project storage" onClick={() => void handleOpenStorage()}>
          <HardDrive />
        </button>
        <button type="button" className="icon-command" data-tooltip="Settings" data-tooltip-side="bottom" aria-label="Settings" onClick={() => setSettingsOpen(true)}>
          <Settings />
        </button>
        <button type="button" className="command-button" data-tooltip="Save project (Ctrl+S)" data-tooltip-side="bottom" onClick={() => void handleSave()} disabled={!project.pages.length}>
          <Save /> Save
        </button>
        <div className="export-control" onClick={(event) => event.stopPropagation()}>
          <button
            type="button"
            className="command-button"
            data-tooltip="Export pages and notes"
            data-tooltip-side="bottom"
            onClick={() => setExportOpen((value) => !value)}
            disabled={!project.pages.length}
            aria-expanded={exportOpen}
          >
            <Download /> Export <ChevronDown className="chevron" />
          </button>
          <ExportMenu open={exportOpen} onExport={(kind) => void handleExport(kind)} />
        </div>
        <button type="button" className="close-button" data-tooltip="Minimize to game (Esc)" data-tooltip-side="bottom" aria-label="Minimize to game" onClick={() => void handleMinimize()}>
          <Minus />
        </button>
        <button type="button" className="close-button quit-button" data-tooltip="Quit Gamebook" data-tooltip-side="bottom" aria-label="Quit Gamebook" onClick={() => setQuitOpen(true)}>
          <X />
        </button>
      </header>

      <section className="workspace">
        {activePage ? (
          <>
            <ToolRail
              tool={tool}
              color={color}
              strokeWidth={strokeWidth}
              pageBackgroundColor={activePage.backgroundColor}
              onToolChange={setTool}
              onColorChange={setColor}
              onWidthChange={setStrokeWidth}
              onPageBackgroundChange={(backgroundColor) =>
                updatePage(activePage.id, { backgroundColor })
              }
            />
            <CanvasEditor
              ref={editorRef}
              page={activePage}
              tool={tool}
              color={color}
              strokeWidth={strokeWidth}
              onToolChange={setTool}
              onPageChange={updatePage}
              onClose={() => void handleMinimize()}
              onError={showError}
            />
          </>
        ) : (
          <div className="empty-state">
            <div className="empty-mark">G</div>
            <p>No pages</p>
          </div>
        )}
      </section>

      {recovery.length > 0 && (
        <div className="recovery-banner" role="status">
          <span>{recovery.length} recoverable project workspace{recovery.length === 1 ? "" : "s"} available.</span>
          {recovery.map((summary, index) =>
            summary.protectedClasses?.includes("unsaved") ? (
              <button
                key={summary.workspaceId}
                type="button"
                onClick={() => void handleRecover(summary.workspaceId)}
              >
                Recover unsaved project {index + 1}
              </button>
            ) : (
              <button
                key={summary.workspaceId}
                type="button"
                onClick={() => void handleOpen()}
              >
                Open saved project {index + 1}
              </button>
            ),
          )}
        </div>
      )}

      {project.pages.length > 0 && (
        <PageStrip
          pages={project.pages}
          activePageId={project.manifest.activePageId}
          onSelect={handleSelectPage}
          onRemove={(pageId) => {
            editorRef.current?.flush();
            void handleReviewPageDeletion(pageId);
          }}
          onDuplicate={(pageId) => {
            editorRef.current?.flush();
            duplicatePage(pageId);
            setTool("select");
          }}
          onReorder={(sourcePageId, targetPageId) => {
            editorRef.current?.flush();
            reorderPage(sourcePageId, targetPageId);
          }}
        />
      )}

      <div className="history-controls">
        <button type="button" data-tooltip="Undo (Ctrl+Z)" data-tooltip-side="top" aria-label="Undo" onClick={() => editorRef.current?.undo()} disabled={!activePage}><Undo2 /></button>
        <button type="button" data-tooltip="Redo (Ctrl+Y)" data-tooltip-side="top" aria-label="Redo" onClick={() => editorRef.current?.redo()} disabled={!activePage}><Redo2 /></button>
      </div>

      {busyLabel && (
        <div className="busy-overlay" role="status" aria-live="polite">
          <LoaderCircle />
          <span>{busyLabel}</span>
          {operationActive && (
            <button type="button" onClick={() => void cancelOperation()}>Cancel</button>
          )}
        </div>
      )}
      {toast && <div className="toast" role="status">{toast}</div>}
      {quitOpen && (
        <ConfirmDialog
          title="Quit Gamebook?"
          description="Gamebook will stop running in the background, and Ctrl+Shift+F12 will no longer capture until you open it again. Your current project will be autosaved before quitting."
          confirmLabel="Quit Gamebook"
          onCancel={() => setQuitOpen(false)}
          onConfirm={() => void handleQuit()}
        />
      )}
      {report && <ProjectReportDialog state={report} onClose={dismissReport} />}
      {storageOpen && (
        <ProjectStorageDialog
          recovery={recovery}
          trash={trash}
          onRecover={(workspaceId) => void handleRecover(workspaceId)}
          onOpenSaved={() => {
            setStorageOpen(false);
            void handleOpen();
          }}
          onCleanCache={() => void handleCleanCache()}
          onRestoreTrash={(transactionId) => void handleRestoreTrash(transactionId)}
          onEmptyEligibleTrash={() => {
            setStorageOpen(false);
            setEmptyTrashMode("eligible");
          }}
          onEmptyAllTrash={() => {
            setStorageOpen(false);
            setEmptyTrashMode("all");
          }}
          onClose={() => setStorageOpen(false)}
        />
      )}
      {settingsOpen && (
        <SettingsDialog
          settings={globalSettings.settings}
          notices={globalSettings.notices}
          writeProtected={globalSettings.writeProtected}
          onSave={(settings) => {
            void globalSettings.save(settings)
              .then(() => {
                setSettingsOpen(false);
                setToast("Settings saved");
              })
              .catch((error: unknown) => showError(String(error)));
          }}
          onImport={() => {
            void globalSettings.importFile()
              .then((imported) => {
                if (imported) {
                  setSettingsOpen(false);
                  setToast("Settings imported");
                }
              })
              .catch((error: unknown) => showError(String(error)));
          }}
          onExport={() => {
            void globalSettings.exportFile()
              .then((exported) => exported && setToast("Settings exported"))
              .catch((error: unknown) => showError(String(error)));
          }}
          onReset={() => {
            void globalSettings.reset()
              .then(() => {
                setSettingsOpen(false);
                setToast("Settings reset");
              })
              .catch((error: unknown) => showError(String(error)));
          }}
          onPreviewHud={async (capture) => {
            setBusyLabel("Previewing recording HUD");
            try {
              const result = await previewRecordingHud(capture);
              return result.message;
            } finally {
              setBusyLabel(null);
            }
          }}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      {trashImpact && (
        <TrashImpactDialog
          impact={trashImpact}
          onCancel={() => setTrashImpact(null)}
          onConfirm={() => void handleCommitTrash()}
        />
      )}
      {emptyTrashMode && (
        <ConfirmDialog
          title={emptyTrashMode === "eligible" ? "Empty eligible Trash?" : "Empty all Project Trash?"}
          description={emptyTrashMode === "eligible"
            ? "Eligible records will be permanently removed from the next successful project Save."
            : "All trashed records will be permanently removed from the next successful project Save, including records still inside their retention period."}
          confirmLabel={emptyTrashMode === "eligible" ? "Empty eligible" : "Empty all"}
          restoreFocusTo={storageButtonRef}
          onCancel={() => setEmptyTrashMode(null)}
          onConfirm={() => void handleEmptyTrash()}
        />
      )}
      {saveConflictOpen && (
        <SaveConflictDialog
          onCancel={() => setSaveConflictOpen(false)}
          onSaveAs={() => void resolveSaveConflict(true, false)}
          onReplace={() => void resolveSaveConflict(false, true)}
        />
      )}
      <TooltipLayer />
    </main>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
