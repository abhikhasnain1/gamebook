# Workspace identity, recovery, and cache lifecycle spike

## Scope

Issue #15 evaluates source-bound workspace identity, copied-project separation, process and heartbeat locks, stale and malformed lock recovery, external source changes, clean close/reopen, cache eviction, cancellation, and reparse-point rejection. The harness is isolated from production Tauri commands and version 1 persistence. It does not freeze the version 2 workspace contract, implement archive Save, or authorize schema work.

The native example creates synthetic project files under the ignored spike-evidence directory and disposable workspace state under the current user's local application-data directory. Every report removes its fixture and complete run-specific workspace root before it becomes valid. Reports contain generic IDs, classifications, counts, and outcomes; they never contain a source path, workspace path, project title, or source bytes.

## Workspace identity

The spike hashes a canonical case-normalized source path with SHA-256. The persisted registry maps that fingerprint to an opaque generated workspace ID and a content digest; it does not persist the source path.

- Opening the same canonical source through an equivalent path activates the existing workspace and leaves one registry record.
- Opening byte-identical content from another canonical path creates a second workspace and reports that a copy was detected.
- Content equality alone never causes two source paths to share mutable state.
- Clean close removes the process lock but retains the recovery journal and registry record; reopening reloads the registry and activates the same workspace.

## Lock and recovery rules

Locks contain the process ID, application-instance ID, source fingerprint, and heartbeat time. The native harness queries Windows process state with `OpenProcess` and `GetExitCodeProcess` rather than trusting only a PID value.

- A live process activates the existing instance even when a heartbeat is old.
- An absent process with an unexpired heartbeat remains owned and waits rather than being stolen.
- Only an absent process with an expired heartbeat enters recovery.
- A malformed lock also enters recovery conservatively.

Stale and malformed locks remain available for review. Neither case deletes the workspace, lock evidence, recovery journal, interrupted data, or saved project.

## External changes and cache policy

The source baseline contains byte count, Windows last-write time, and SHA-256. A changed source pauses Save and exposes Save As, explicit replacement, and cancellation as separate outcomes. The spike verifies that no automatic replacement occurs and that the prior saved bytes and workspace remain intact.

Cache pressure uses physical synthetic entries with independent policy metadata. An entry is evictable only when it is a clean materialization, its digest was verified, it is recreatable from the archive, and its project is closed. Least-recently-used order removes only enough clean cache to meet the configured limit. Unsaved work, interrupted recordings, recovery-pending files, and Project Trash remain protected. Cancellation before removal leaves every entry unchanged.

## Security boundary

Each workspace run root must canonicalize beneath the current user's local application-data directory. The harness rejects any existing reparse point in the workspace ancestor chain. The escape scenario creates a real Windows directory link, verifies the reparse attribute, rejects child creation through it, removes only the link, and confirms that an outside sentinel remains intact.

The spike performs no network request and no production project write. Cleanup failures, path disclosure, source-byte disclosure, unexpected eviction, or a workspace outside the user-scoped root fail the report.

## Evidence roles

One release binary and exact source revision must produce independent reports for:

- same-source workspace reuse;
- copied-project separation;
- live lock with expired heartbeat;
- absent process with fresh heartbeat;
- stale-lock recovery;
- malformed-lock recovery;
- external source change;
- clean close and reopen;
- clean-cache eviction under pressure;
- eviction cancellation;
- reparse-point rejection.

The evidence manifest binds the release binary and all 11 reports to SHA-256. The verifier checks every scenario contract, security and privacy fields, cleanup, compatibility declarations, exact build identity, duplicate evidence, and negative self-tests.

```powershell
npm.cmd run workspace-lifecycle:verify -- --self-test
npm.cmd run workspace-lifecycle:run -- --build-id <exact-40-character-revision>
```

Raw reports, manifests, fixtures, workspaces, and release binaries remain outside the repository history.

## Reference results

The retained [reference report](workspace-lifecycle-reference-report.json) summarizes the complete release matrix from implementation revision `d7ef4ac2ffdc58df635f3a3e5ebc1cbebff147e7`. The 360,448-byte release binary has SHA-256 `DA5E9805E200E1DE66B8B0390BAFABA2C2A0D3396ACFB25B1CF43FCA2C867C9D`; the evidence manifest verified that binary and all 11 raw reports before cleanup.

Equivalent source paths reused one opaque workspace and one registry record in 14.132 ms. A byte-identical copy at another source path received a second workspace in 21.678 ms; its content digest matched while its source fingerprint and workspace ID remained distinct. Neither registry record contained a source path.

The live-process case activated the existing instance even with an expired heartbeat. An absent process with a fresh heartbeat waited for its owner. Only an absent process with an expired heartbeat entered recovery, while a malformed lock entered the same conservative recovery path. All four cases retained the lock evidence, recovery journal, and workspace without deletion.

External mutation changed both size and SHA-256, paused Save, exposed Save As, explicit replacement, and cancellation, and preserved the prior project and workspace. Clean close removed its lock; reopen loaded the registry from disk, reused the same workspace ID, and retained the recovery journal.

Cache pressure reduced 6,291,456 bytes of verified clean cache to the 2,097,152-byte limit by removing only the oldest 4,194,304-byte entry. Unsaved work, interrupted recording data, recovery-pending data, and Project Trash remained. Cancellation removed nothing. The real directory-link case was detected as a reparse point, rejected before child creation, and left its outside sentinel unchanged. Every run removed its fixture and user-scoped workspace root with zero partial output or protected-data deletion.

## Accessibility review surface

The native harness is noninteractive. A separate semantic surface exposes same-source reuse, copied-project separation, stale-lock recovery, external-change choices, cache estimates, protected data, cleanup, cancellation, and completion through ordinary labeled controls, focused recovery regions, alerts, summaries, and live status:

```text
http://127.0.0.1:1420/tools/spikes/workspace-recovery.html
```

The review covers keyboard operation, focus transfer and restoration, polite status, assertive external-change errors, forced colors, reduced motion, 100/150/200 percent UI scale, the 900 by 620 minimum window, axe, Accessibility Insights, and NVDA. The surface uses generic fixture labels and never displays a project path, workspace path, source bytes, or opaque identifier.

Four component tests passed with no serious or critical axe violations. Browser review at 900 by 620 passed at 100, 150, and 200 percent UI scale with no horizontal overflow or clipped control text. Keyboard workflows covered copied-project separation, stale-lock recovery, external-change cancellation, and protected cache cleanup. Recovery headings, external-change alerts, and cleanup headings received focus; completion and cancellation restored focus to the Open command. The forced-colors and reduced-motion rules are present. Accessibility Insights, manual Windows High Contrast, and NVDA spoken-output confirmation remain required before issue closeout.

## Compatibility and decision boundary

The spike changes no production command, project schema, screenshot workflow, recovery path, or export. Gamebook 0.5.3 behavior and version 1 project compatibility remain unchanged. Issue #15 unlocks streamed Save issue #16; ZIP64 remains provisional until issue #16 passes and issue #17 records the proposed storage decision for Milestone 5.
