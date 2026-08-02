import { useEffect, useId, useRef, useState } from "react";
import { Archive, Check, CircleAlert, FolderOpen, RotateCcw, Square } from "lucide-react";

type ArchiveCondition = "valid" | "traversal" | "malformed";
type MaterializationCondition = "valid" | "digest";
type Phase = "idle" | "open" | "materializing" | "complete" | "error" | "cancelled" | "recovery";

const STATUS_BY_PHASE: Record<Phase, string> = {
  idle: "Ready to open a synthetic project.",
  open: "Archive metadata opened. Four entries found. No media extracted.",
  materializing: "Materializing the selected asset. 50 percent complete.",
  complete: "Selected asset verified and made available. The unselected asset remained in the archive.",
  error: "The operation stopped before changing the project.",
  cancelled: "Materialization cancelled. The temporary output is isolated for safe cleanup.",
  recovery: "Recovery details opened.",
};

export function ArchiveMaterializationHarness() {
  const archiveConditionId = useId();
  const materializationConditionId = useId();
  const [archiveCondition, setArchiveCondition] = useState<ArchiveCondition>("valid");
  const [materializationCondition, setMaterializationCondition] = useState<MaterializationCondition>("valid");
  const [phase, setPhase] = useState<Phase>("idle");
  const [errorMessage, setErrorMessage] = useState("");
  const errorRef = useRef<HTMLDivElement>(null);
  const recoveryHeadingRef = useRef<HTMLHeadingElement>(null);
  const materializeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (phase === "error") errorRef.current?.focus();
    if (phase === "recovery") recoveryHeadingRef.current?.focus();
  }, [phase]);

  const archiveIsOpen = ["open", "materializing", "complete", "cancelled", "recovery"].includes(phase);

  function openArchive() {
    if (archiveCondition === "traversal") {
      setErrorMessage("Archive not opened. An entry uses an unsafe parent path. The existing project is unchanged.");
      setPhase("error");
      return;
    }
    if (archiveCondition === "malformed") {
      setErrorMessage("Archive not opened. The central directory is malformed. The existing project is unchanged.");
      setPhase("error");
      return;
    }
    setErrorMessage("");
    setPhase("open");
  }

  function continueMaterialization() {
    if (materializationCondition === "digest") {
      setErrorMessage("Asset not made available. SHA-256 verification failed. The temporary output can be removed safely.");
      setPhase("error");
      return;
    }
    setPhase("complete");
  }

  function cleanRecovery() {
    setErrorMessage("");
    setPhase("open");
    requestAnimationFrame(() => materializeRef.current?.focus());
  }

  return (
    <div className="archive-shell">
      <header>
        <div>
          <p>ZIP64 feasibility</p>
          <h1>Archive materialization</h1>
        </div>
        <div className="archive-badge" aria-label="Project size 5 gigabytes">
          <Archive aria-hidden="true" />
          <span>5 GB synthetic project</span>
        </div>
      </header>

      <main>
        <section className="archive-controls" aria-labelledby="archive-controls-heading">
          <h2 id="archive-controls-heading">Operation</h2>
          <div className="archive-fields">
            <label htmlFor={archiveConditionId}>
              Archive condition
              <select
                id={archiveConditionId}
                value={archiveCondition}
                onChange={(event) => {
                  setArchiveCondition(event.target.value as ArchiveCondition);
                  setPhase("idle");
                  setErrorMessage("");
                }}
              >
                <option value="valid">Valid ZIP64 project</option>
                <option value="traversal">Unsafe parent path</option>
                <option value="malformed">Malformed central directory</option>
              </select>
            </label>
            <label htmlFor={materializationConditionId}>
              Asset verification
              <select
                id={materializationConditionId}
                value={materializationCondition}
                disabled={!archiveIsOpen}
                onChange={(event) => setMaterializationCondition(event.target.value as MaterializationCondition)}
              >
                <option value="valid">Matching SHA-256</option>
                <option value="digest">Digest mismatch</option>
              </select>
            </label>
          </div>

          <div className="archive-actions">
            <button type="button" onClick={openArchive} disabled={phase === "materializing"}>
              <FolderOpen aria-hidden="true" />
              Open archive
            </button>
            <button
              ref={materializeRef}
              type="button"
              onClick={() => setPhase("materializing")}
              disabled={phase !== "open" && phase !== "complete"}
            >
              <Archive aria-hidden="true" />
              Materialize selected asset
            </button>
          </div>

          {phase === "materializing" && (
            <div className="archive-progress-block">
              <div
                className="archive-progress"
                role="progressbar"
                aria-label="Selected asset materialization"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={50}
                aria-valuetext="50 percent, 2 of 4 megabytes"
              >
                <span />
              </div>
              <p>2 of 4 MB verified</p>
              <div className="archive-actions">
                <button type="button" onClick={continueMaterialization}>
                  <Check aria-hidden="true" />
                  Continue
                </button>
                <button type="button" onClick={() => setPhase("cancelled")}>
                  <Square aria-hidden="true" />
                  Cancel
                </button>
              </div>
            </div>
          )}

          {phase === "complete" && (
            <div className="archive-result" aria-label="Materialization result">
              <Check aria-hidden="true" />
              <div>
                <strong>Selected asset available</strong>
                <span>4 MB verified. One opaque access token issued.</span>
              </div>
            </div>
          )}

          {phase === "error" && (
            <div ref={errorRef} className="archive-error" role="alert" tabIndex={-1}>
              <CircleAlert aria-hidden="true" />
              <div>
                <strong>Action required</strong>
                <span>{errorMessage}</span>
                <button type="button" onClick={() => setPhase("recovery")}>Review recovery</button>
              </div>
            </div>
          )}

          {phase === "cancelled" && (
            <div className="archive-warning">
              <CircleAlert aria-hidden="true" />
              <div>
                <strong>Materialization cancelled</strong>
                <span>No asset was added to the project.</span>
                <button type="button" onClick={() => setPhase("recovery")}>Review recovery</button>
              </div>
            </div>
          )}

          {phase === "recovery" && (
            <section className="archive-recovery" aria-labelledby="archive-recovery-heading">
              <h3 ref={recoveryHeadingRef} id="archive-recovery-heading" tabIndex={-1}>Recovery</h3>
              <dl>
                <div><dt>Saved project</dt><dd>Unchanged</dd></div>
                <div><dt>Canonical records</dt><dd>Unchanged</dd></div>
                <div><dt>Temporary output</dt><dd>Unreferenced</dd></div>
              </dl>
              <button type="button" onClick={cleanRecovery}>
                <RotateCcw aria-hidden="true" />
                Remove temporary output
              </button>
            </section>
          )}
        </section>

        <aside aria-labelledby="archive-summary-heading">
          <h2 id="archive-summary-heading">Validation summary</h2>
          <dl>
            <div><dt>Entries</dt><dd>{archiveIsOpen ? "4" : "Not read"}</dd></div>
            <div><dt>Metadata memory</dt><dd>{archiveIsOpen ? "32 KB" : "Not measured"}</dd></div>
            <div><dt>Media extracted</dt><dd>{archiveIsOpen ? "None" : "Not read"}</dd></div>
            <div><dt>Selected asset</dt><dd>{phase === "complete" ? "Verified" : "Not available"}</dd></div>
            <div><dt>Large asset</dt><dd>{archiveIsOpen ? "In archive" : "Not read"}</dd></div>
          </dl>
          <p className="archive-boundary">No project path, media bytes, or access token is shown in this surface.</p>
        </aside>
      </main>

      <footer>
        <p role="status" aria-live="polite" aria-atomic="true">{STATUS_BY_PHASE[phase]}</p>
      </footer>
    </div>
  );
}
