# ZIP64 archive feasibility gate

## Scope

Issue #17 combines the independently reviewed evidence from the ZIP64 lazy-open and materialization spike (#14), workspace identity and lifecycle spike (#15), and streamed Save and replacement spike (#16). It selects the container that Milestone 5 may freeze; it does not freeze the version 2 schema, implement persistence, or change Gamebook 0.5.3 behavior.

The verifier-bound [reference report](archive-gate-reference-report.json) links the exact source revisions, release binary hashes, report schemas, scenario counts, thresholds, outcomes, and limitations from all three retained reports.

```powershell
npm.cmd run archive-gate:verify -- --self-test
npm.cmd run archive-gate:verify -- --reference docs/spikes/archive-gate-reference-report.json
```

## Gate results

Every documented ZIP64 threshold passed:

| Gate | Threshold | Measured result |
| --- | --- | --- |
| 5 GiB metadata open | Less than 256 MiB additional memory; no media extraction | 421,888 bytes additional memory, 8 ms, zero asset payload opens, zero extracted bytes |
| Selected materialization | Materialize only the requested asset and verify before visibility | One 4,194,304-byte asset; large asset untouched; SHA-256 passed before one scoped token was issued |
| 5 GiB Save | Less than 512 MiB additional memory | Maximum 1,523,712 additional private bytes |
| Temporary copies | No complete copy beyond the replacement archive | One complete replacement archive, zero extra complete copies |
| Replacement | Local NTFS and OneDrive-managed paths preserve prior data | Write-through first Save and replacement passed locally and in a OneDrive-managed directory |
| Recovery | Preserve prior project through all required failures | Cancellation, low space, write failure, checksum failure, corruption, and forced termination passed |
| Workspace lifecycle | Correct identity, locks, external changes, copies, recovery, and cache policy | All eleven lifecycle roles passed |

The 5 GiB first Save completed in 17.358 seconds, local replacement in 17.680 seconds, and OneDrive-managed replacement in 19.171 seconds. These measured latencies did not reveal the blocking behavior that would require a SQLite-container comparison. Raw stored-entry copy was supported and preserved the exact 5 GiB content-addressed media entry.

## Recommendation

Propose ZIP64 as Gamebook's version 2 self-contained project container for Milestone 5 acceptance. The native layer owns archive and workspace I/O. Media remains stored and content-addressed; JSON records remain separately compressed; initial open reads only the central directory, manifest, and required records; selected assets materialize into a user-scoped workspace only after size, CRC, and SHA-256 validation.

Manual Save creates one exclusive same-volume sibling replacement. It raw-copies unchanged stored media, streams changed records and new assets through bounded buffers, validates the complete archive before visibility, flushes the temporary file, and uses write-through `MoveFileExW` or `ReplaceFileW`. The workspace becomes clean only after the visible archive reopens successfully.

SQLite is retained as the documented fallback comparison, not selected as a second implementation path. A comparison becomes required if a revisit trigger fails during Milestone 5 contract work or production implementation.

## Measured limitation

`FlushFileBuffers` on the containing directory was attempted but unsupported on the reference Windows system. The contract, accepted later in ADR-0002, therefore requires the complete temporary-file flush, pre-visibility validation, same-volume sibling placement, and write-through Windows move or replacement. Implementations must record whether directory flush is supported and must never claim it occurred when Windows rejects the directory handle or flush.

This limitation does not fail a documented gate: the proposed format already requires directory flush only where supported, and every first Save, replacement, interruption, and recovery role preserved the prior valid project. Milestone 5 must keep the limitation visible in the accepted storage ADR and production validation plan.

## Required contract for Milestone 5

- Keep the archive self-contained and ZIP64-capable without loading complete assets or the complete project into memory.
- Treat archive metadata, names, sizes, compression, extra fields, records, and assets as untrusted.
- Reject unsafe paths, duplicate destinations, links, reparse escapes, oversized records, excessive entries, malformed compression, and digest failures before canonical state changes or output visibility.
- Address immutable assets by SHA-256 and expose them only through instance-, workspace-, digest-, operation-, and expiry-bound opaque tokens.
- Key workspaces by an opaque ID plus canonical source-path fingerprint; byte-identical copies at different paths receive separate mutable state.
- Consider a lock stale only when its process is absent and heartbeat expired. Malformed locks enter recovery and never trigger automatic deletion.
- Pause Save after an external source change and offer Save As, explicit replacement, or cancellation.
- Evict only verified recreatable materializations from closed clean projects. Protect unsaved work, recovery data, interrupted recordings, and Project Trash.
- Preserve the prior project and leave partial output unreferenced through cancellation, validation failure, insufficient space, forced termination, and write failure.
- Keep Save, materialization, recovery, lock, external-change, and cache flows keyboard operable, named, focus managed, announced, High Contrast safe, reduced-motion safe, and usable at 900 by 620 through 200 percent scale.
- Preserve version 1 projects and the verified screenshot workflow until a separate accepted Milestone 5 contract and Milestone 6 implementation perform migration.

## Revisit and fallback

Milestone 5 or implementation must reopen the container decision and compare SQLite when any gate reaches its documented memory limit, adds an extra complete copy, loses raw-copy support, cannot preserve prior data on local NTFS or OneDrive-managed storage, cannot enforce validation or workspace isolation, regresses accessibility or privacy, or encounters representative latency that blocks the workflow.

Dependency upgrades, archive-layout changes, and Windows replacement changes require the proportional regression matrix. A newer compatible ZIP library may be adopted only after the relevant malformed-input, ZIP64, raw-copy, memory, recovery, and replacement checks pass again.

## Compatibility and decision boundary

The three spikes use synthetic local data, produce redacted reports, and perform no production project writes or application network requests. Their semantic surfaces passed 13 component tests, axe, keyboard/focus checks, 100/150/200 percent scale, forced colors, reduced motion, Accessibility Insights, NVDA 2026.1.1, and Windows High Contrast.

Production commands, the version 1 Gzip JSON format, screenshot capture and editing, recovery, and exports remain unchanged. [ADR-0002](../decisions/0002-zip64-project-storage.md) remains Proposed until Milestone 5 accepts, revises, or rejects it.
