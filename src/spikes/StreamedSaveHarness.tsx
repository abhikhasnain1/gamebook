import { useEffect, useId, useRef, useState } from "react";
import { AlertTriangle, Check, FileArchive, HardDrive, Save, Square, Undo2 } from "lucide-react";

type SaveCondition = "normal" | "external" | "low-space" | "write-failure";
type SavePhase = "idle" | "saving" | "external" | "error" | "complete" | "cancelled";

function statusFor(phase: SavePhase, condition: SaveCondition) {
  switch (phase) {
    case "idle":
      return "Ready to save the synthetic project.";
    case "saving":
      return "Save in progress. Forty-eight percent complete. The prior project remains available.";
    case "external":
      return "Save paused because the destination changed outside Gamebook.";
    case "error":
      return condition === "low-space"
        ? "Save stopped before writing because temporary space is insufficient."
        : "Save failed while writing the replacement archive. The prior project is unchanged.";
    case "complete":
      return "Save completed. The replacement archive was validated before it became visible.";
    case "cancelled":
      return "Save cancelled. The prior project and recoverable work remain unchanged.";
  }
}

export function StreamedSaveHarness() {
  const conditionId = useId();
  const [condition, setCondition] = useState<SaveCondition>("normal");
  const [phase, setPhase] = useState<SavePhase>("idle");
  const saveButtonRef = useRef<HTMLButtonElement>(null);
  const externalHeadingRef = useRef<HTMLHeadingElement>(null);
  const errorHeadingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (phase === "external") externalHeadingRef.current?.focus();
    if (phase === "error") errorHeadingRef.current?.focus();
    if (phase === "complete" || phase === "cancelled") saveButtonRef.current?.focus();
  }, [phase]);

  function beginSave() {
    if (condition === "external") {
      setPhase("external");
      return;
    }
    if (condition === "low-space" || condition === "write-failure") {
      setPhase("error");
      return;
    }
    setPhase("saving");
  }

  return (
    <div className="save-shell">
      <header>
        <div>
          <p>ZIP64 feasibility</p>
          <h1>Streamed Save</h1>
        </div>
        <div className="save-badge" aria-label="Local project storage">
          <HardDrive aria-hidden="true" />
          <span>Local project</span>
        </div>
      </header>

      <main>
        <section className="save-operation" aria-labelledby="save-operation-heading">
          <h2 id="save-operation-heading">Operation</h2>
          <label htmlFor={conditionId}>
            Save condition
            <select
              id={conditionId}
              value={condition}
              onChange={(event) => {
                setCondition(event.target.value as SaveCondition);
                setPhase("idle");
              }}
            >
              <option value="normal">Normal replacement</option>
              <option value="external">Destination changed externally</option>
              <option value="low-space">Insufficient temporary space</option>
              <option value="write-failure">Write failure during replacement</option>
            </select>
          </label>

          <div className="save-actions">
            <button ref={saveButtonRef} type="button" onClick={beginSave} disabled={["saving", "external", "error"].includes(phase)}>
              <Save aria-hidden="true" />
              Save project
            </button>
            {phase === "saving" && (
              <>
                <button type="button" onClick={() => setPhase("complete")}>
                  <Check aria-hidden="true" />
                  Complete Save
                </button>
                <button type="button" onClick={() => setPhase("cancelled")}>
                  <Square aria-hidden="true" />
                  Cancel Save
                </button>
              </>
            )}
          </div>

          {phase === "saving" && (
            <section className="save-progress" aria-labelledby="save-progress-heading">
              <FileArchive aria-hidden="true" />
              <div>
                <h3 id="save-progress-heading">Writing replacement archive</h3>
                <progress value={48} max={100} aria-label="Save progress">48%</progress>
                <p>2.4 GB of 5.0 GB copied. Validation begins before replacement.</p>
              </div>
            </section>
          )}

          {phase === "external" && (
            <section className="save-alert" role="alert" aria-labelledby="save-external-heading">
              <AlertTriangle aria-hidden="true" />
              <div>
                <h3 ref={externalHeadingRef} id="save-external-heading" tabIndex={-1}>Destination changed outside Gamebook</h3>
                <p>The prior project has not been replaced. Choose how to continue.</p>
                <div className="save-actions">
                  <button type="button" onClick={() => setPhase("complete")}>Save as new project</button>
                  <button type="button" onClick={() => setPhase("complete")}>Replace changed destination</button>
                  <button type="button" onClick={() => setPhase("cancelled")}>Cancel Save</button>
                </div>
              </div>
            </section>
          )}

          {phase === "error" && (
            <section className="save-alert" role="alert" aria-labelledby="save-error-heading">
              <AlertTriangle aria-hidden="true" />
              <div>
                <h3 ref={errorHeadingRef} id="save-error-heading" tabIndex={-1}>
                  {condition === "low-space" ? "Insufficient temporary space" : "Replacement write failed"}
                </h3>
                <p>
                  {condition === "low-space"
                    ? "5.1 GB is required and 3.8 GB is available. No replacement archive was created."
                    : "The partial replacement remains unreferenced until cleanup. The prior project is unchanged."}
                </p>
                <div className="save-actions">
                  <button type="button" onClick={() => { setCondition("normal"); setPhase("idle"); }}>
                    <Undo2 aria-hidden="true" />
                    Review and retry
                  </button>
                  <button type="button" onClick={() => setPhase("cancelled")}>Keep prior project</button>
                </div>
              </div>
            </section>
          )}

          {phase === "complete" && (
            <div className="save-result" aria-label="Save result">
              <Check aria-hidden="true" />
              <div>
                <strong>Validated replacement complete</strong>
                <span>The new archive became visible only after references, sizes, and digests passed.</span>
              </div>
            </div>
          )}
        </section>

        <aside aria-labelledby="save-summary-heading">
          <h2 id="save-summary-heading">Save summary</h2>
          <dl>
            <div><dt>Project size</dt><dd>5.0 GB</dd></div>
            <div><dt>Temporary space</dt><dd>5.1 GB</dd></div>
            <div><dt>Prior project</dt><dd>{phase === "complete" ? "Replaced" : "Protected"}</dd></div>
            <div><dt>Replacement copies</dt><dd>One</dd></div>
            <div><dt>Private paths</dt><dd>Hidden</dd></div>
          </dl>
          <p>Only generic project labels, storage estimates, progress, and recovery outcomes appear here.</p>
        </aside>
      </main>

      <footer>
        <p role="status" aria-live="polite" aria-atomic="true">{statusFor(phase, condition)}</p>
      </footer>
    </div>
  );
}
