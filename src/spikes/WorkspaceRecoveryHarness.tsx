import { useEffect, useId, useRef, useState } from "react";
import { ArchiveRestore, Check, Copy, FolderOpen, HardDrive, ShieldAlert, Square } from "lucide-react";

type WorkspaceCondition = "same" | "copy" | "stale" | "external";
type Phase = "idle" | "open" | "recovery" | "external" | "cache" | "complete" | "cancelled";

function statusFor(phase: Phase, condition: WorkspaceCondition, cleanCacheMb: number) {
  switch (phase) {
    case "idle":
      return "Ready to open a synthetic project.";
    case "open":
      if (condition === "copy") return "Copied project opened in a separate workspace.";
      if (condition === "external") return "Workspace opened. The source will be checked before Save.";
      return "Existing workspace activated for the same source.";
    case "recovery":
      return "The previous process is absent and its heartbeat expired. Recovery review is required.";
    case "external":
      return "Save paused because the source changed outside Gamebook.";
    case "cache":
      return "Cache cleanup review opened. Unsaved and interrupted work is protected.";
    case "complete":
      return cleanCacheMb === 2
        ? "Four megabytes of clean cache removed. Protected work was retained."
        : "Workspace operation completed without deleting recoverable work.";
    case "cancelled":
      return "Operation cancelled. Project and workspace data remain unchanged.";
  }
}

export function WorkspaceRecoveryHarness() {
  const conditionId = useId();
  const [condition, setCondition] = useState<WorkspaceCondition>("same");
  const [phase, setPhase] = useState<Phase>("idle");
  const [cleanCacheMb, setCleanCacheMb] = useState(6);
  const recoveryHeadingRef = useRef<HTMLHeadingElement>(null);
  const externalAlertRef = useRef<HTMLDivElement>(null);
  const cacheHeadingRef = useRef<HTMLHeadingElement>(null);
  const openRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (phase === "recovery") recoveryHeadingRef.current?.focus();
    if (phase === "external") externalAlertRef.current?.focus();
    if (phase === "cache") cacheHeadingRef.current?.focus();
    if (phase === "complete" || phase === "cancelled") openRef.current?.focus();
  }, [phase]);

  function openProject() {
    if (condition === "stale") {
      setPhase("recovery");
      return;
    }
    setPhase("open");
  }

  function finish(messagePhase: Phase = "complete") {
    setPhase(messagePhase);
  }

  const workspaceOpen = phase === "open" || phase === "complete";

  return (
    <div className="workspace-shell">
      <header>
        <div>
          <p>ZIP64 feasibility</p>
          <h1>Workspace recovery</h1>
        </div>
        <div className="workspace-badge" aria-label="Current user workspace policy">
          <HardDrive aria-hidden="true" />
          <span>Local workspace</span>
        </div>
      </header>

      <main>
        <section className="workspace-controls" aria-labelledby="workspace-controls-heading">
          <h2 id="workspace-controls-heading">Operation</h2>
          <label htmlFor={conditionId}>
            Workspace condition
            <select
              id={conditionId}
              value={condition}
              onChange={(event) => {
                setCondition(event.target.value as WorkspaceCondition);
                setPhase("idle");
                setCleanCacheMb(6);
              }}
            >
              <option value="same">Same source opened again</option>
              <option value="copy">Byte-identical copied project</option>
              <option value="stale">Expired lock from absent process</option>
              <option value="external">Source changed outside Gamebook</option>
            </select>
          </label>

          <div className="workspace-actions">
            <button ref={openRef} type="button" onClick={openProject} disabled={["recovery", "external", "cache"].includes(phase)}>
              <FolderOpen aria-hidden="true" />
              Open project
            </button>
            <button type="button" onClick={() => setPhase("cache")} disabled={!workspaceOpen}>
              <HardDrive aria-hidden="true" />
              Review cache cleanup
            </button>
            {condition === "external" && workspaceOpen && (
              <button type="button" onClick={() => setPhase("external")}>
                <ShieldAlert aria-hidden="true" />
                Check source before Save
              </button>
            )}
          </div>

          {workspaceOpen && (
            <div className="workspace-result" aria-label="Workspace result">
              {condition === "copy" ? <Copy aria-hidden="true" /> : <Check aria-hidden="true" />}
              <div>
                <strong>{condition === "copy" ? "Separate workspace created" : "Existing workspace activated"}</strong>
                <span>
                  {condition === "copy"
                    ? "Matching project bytes were detected at a different source location."
                    : "The same source fingerprint reused its current workspace."}
                </span>
              </div>
            </div>
          )}

          {phase === "recovery" && (
            <section className="workspace-recovery" aria-labelledby="workspace-recovery-heading">
              <ShieldAlert aria-hidden="true" />
              <div>
                <h3 ref={recoveryHeadingRef} id="workspace-recovery-heading" tabIndex={-1}>Recovery required</h3>
                <p>The owning process is absent and the heartbeat has expired. No workspace data was deleted.</p>
                <dl>
                  <div><dt>Recovery journal</dt><dd>Retained</dd></div>
                  <div><dt>Interrupted work</dt><dd>Retained</dd></div>
                  <div><dt>Saved project</dt><dd>Unchanged</dd></div>
                </dl>
                <div className="workspace-actions">
                  <button type="button" onClick={() => finish()}>
                    <ArchiveRestore aria-hidden="true" />
                    Recover workspace
                  </button>
                  <button type="button" onClick={() => finish("cancelled")}>
                    <Square aria-hidden="true" />
                    Cancel open
                  </button>
                </div>
              </div>
            </section>
          )}

          {phase === "external" && (
            <div ref={externalAlertRef} className="workspace-alert" role="alert" tabIndex={-1}>
              <ShieldAlert aria-hidden="true" />
              <div>
                <strong>Source changed outside Gamebook</strong>
                <span>Save is paused. The previous saved project has not been replaced.</span>
                <div className="workspace-actions">
                  <button type="button" onClick={() => finish()}>Save as new project</button>
                  <button type="button" onClick={() => finish()}>Replace changed source</button>
                  <button type="button" onClick={() => finish("cancelled")}>Cancel Save</button>
                </div>
              </div>
            </div>
          )}

          {phase === "cache" && (
            <section className="workspace-cache" aria-labelledby="workspace-cache-heading">
              <h3 ref={cacheHeadingRef} id="workspace-cache-heading" tabIndex={-1}>Cache cleanup</h3>
              <dl>
                <div><dt>Verified clean cache</dt><dd>6 MB</dd></div>
                <div><dt>After cleanup</dt><dd>2 MB</dd></div>
                <div><dt>Unsaved work</dt><dd>Retained</dd></div>
                <div><dt>Interrupted recording</dt><dd>Retained</dd></div>
                <div><dt>Recovery and Project Trash</dt><dd>Retained</dd></div>
              </dl>
              <div className="workspace-actions">
                <button type="button" onClick={() => { setCleanCacheMb(2); finish(); }}>
                  <HardDrive aria-hidden="true" />
                  Remove 4 MB clean cache
                </button>
                <button type="button" onClick={() => finish("cancelled")}>
                  <Square aria-hidden="true" />
                  Cancel cleanup
                </button>
              </div>
            </section>
          )}
        </section>

        <aside aria-labelledby="workspace-summary-heading">
          <h2 id="workspace-summary-heading">Storage summary</h2>
          <dl>
            <div><dt>Workspace identity</dt><dd>{condition === "copy" && workspaceOpen ? "Separate" : workspaceOpen ? "Reused" : "Not opened"}</dd></div>
            <div><dt>Saved project</dt><dd>Unchanged</dd></div>
            <div><dt>Clean cache</dt><dd>{cleanCacheMb} MB</dd></div>
            <div><dt>Recoverable work</dt><dd>Protected</dd></div>
            <div><dt>Private paths</dt><dd>Hidden</dd></div>
          </dl>
          <p className="workspace-boundary">Only generic labels, storage estimates, and recovery outcomes appear in this surface.</p>
        </aside>
      </main>

      <footer>
        <p role="status" aria-live="polite" aria-atomic="true">{statusFor(phase, condition, cleanCacheMb)}</p>
      </footer>
    </div>
  );
}
