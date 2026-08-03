# ADR-0002: ZIP64 project storage

- Status: Accepted
- Date: 2026-08-03
- Governing issue: #20
- Roadmap milestone: Milestone 5
- Supersedes: None
- Superseded by: None

## Context

Gamebook needs a portable single-file project that can hold multi-gigabyte recordings without base64 serialization, eager extraction, whole-project memory loading, or autosave archive rebuilds. It must preserve the last valid project through interruption, isolate mutable workspace state by source path, support copied projects, and retain accessible recovery and storage controls.

Issues #14, #15, and #16 evaluated ZIP64 lazy open/materialization, workspace identity/locks/recovery/cache, and streamed Save/replacement. The combined [gate report](../spikes/archive-gate.md) and verifier-bound [reference data](../spikes/archive-gate-reference-report.json) retain the exact measured evidence. Issue #20 accepted this container and its workspace and replacement boundaries after the canonical record and migration contracts were frozen in ADR-0008 and ADR-0009.

## Decision drivers

- Keep one portable `.gamebook` file while supporting assets larger than classic ZIP limits.
- Open metadata with less than 256 MiB additional memory and no media extraction.
- Save a 5 GiB project with less than 512 MiB additional memory and no extra complete copy beyond the replacement archive.
- Materialize only selected assets and verify them before visibility.
- Preserve the prior project through cancellation, low space, checksum failure, corruption, write failure, and forced termination.
- Support local NTFS and OneDrive-managed replacement.
- Isolate workspaces, copied projects, locks, recovery, external changes, and protected cache classes.
- Enforce archive validation, path safety, local-data privacy, compatibility, and accessible recovery requirements.

## Options considered

### ZIP64 self-contained archive

ZIP64 keeps a familiar self-contained package with separate records and immutable stored media entries. Seek-based central-directory access opened the 5,372,904,638-byte fixture in 8 ms with 421,888 additional private bytes, no asset payload opens, and no media extraction. Selected materialization streamed and verified one 4 MiB asset without requesting the large asset.

The 5 GiB Save roles used at most 1,523,712 additional private bytes, raw-copied the unchanged 5 GiB stored media entry, stream-hashed the new asset, created one complete replacement archive, and created no extra complete copy. Local first Save, local replacement, and OneDrive-managed replacement completed in 17.358-19.171 seconds. All archive validation, workspace, cancellation, interruption, replacement, and recovery roles passed.

Its costs are central-directory validation, complete archive rebuild for manual Save, temporary space near the final archive size, and explicit Windows replacement logic. It also requires careful dependency regression because malformed archives and ZIP implementation behavior are security boundaries.

### SQLite container

A SQLite-backed container could provide transactional record updates and avoid rebuilding unchanged records. Large immutable media would require either SQLite BLOB streaming or a defined container/sidecar scheme, with corresponding portability, corruption, backup, compaction, and migration contracts. It would also require a separate feasibility matrix for large BLOB access, selective materialization, Windows and OneDrive replacement, recovery, and archive-like export portability.

The roadmap requires this comparison when ZIP64 misses a threshold, has unsupported raw-copy behavior, or shows unexpectedly poor latency. No such trigger occurred, so building a second spike would add a parallel storage design without resolving a failed requirement.

## Decision

Use ZIP64 as the version 2 `.gamebook` container.

The accepted contract is:

- Rust owns archive, workspace, validation, hashing, cache, and replacement operations. The WebView receives no path or broad filesystem capability.
- The archive contains separately compressed canonical records and stored immutable content-addressed assets. Initial open reads only the central directory, manifest, and required records.
- Archive names, metadata, sizes, compression, extra fields, record contents, and assets are untrusted and must pass the limits and path-safety rules in `SECURITY-PRIVACY.md`.
- Selected assets materialize through bounded streaming into an exclusive user-scoped workspace temporary, then become visible and token-addressable only after size, CRC, and SHA-256 verification.
- Workspace identity combines an opaque workspace ID with a canonical source-path fingerprint. Different source paths never share mutable state solely because their bytes match.
- Locks include process, application instance, source fingerprint, and heartbeat. Recovery requires an absent process plus expired heartbeat, or a malformed lock; neither condition deletes data automatically.
- Manual Save creates one exclusive same-volume sibling ZIP64 replacement, raw-copies unchanged stored entries, streams changed data, validates the complete result, flushes the temporary file, uses write-through Windows move/replacement, and marks the workspace clean only after the visible archive reopens.
- External source changes pause Save for Save As, explicit replacement, or cancellation. Failure and cancellation leave the prior project intact and partial output unreferenced.
- Cache eviction removes only verified recreatable materializations from closed clean projects. Unsaved work, recovery, interrupted recordings, and Project Trash are protected.

SQLite remains the fallback comparison if a revisit trigger fails. This decision freezes architecture only; production persistence begins in Milestone 6 and must conform to ADR-0008 and ADR-0009.

## Consequences

Gamebook retains one portable project file and avoids carrying two storage implementations. Large unchanged media can remain compressed as stored entries and move into a replacement archive without frontend transfer or whole-project memory loading. Autosave remains workspace-based rather than rebuilding the archive.

Manual Save requires temporary space approximately equal to the replacement archive and performs complete archive validation before replacement. The reference 5 GiB Save took 17.358-19.171 seconds, including 7.147-7.342 seconds of validation, so production needs bounded, cancellable, announced progress and a preflight space estimate.

The reference system rejected `FlushFileBuffers` on the containing directory. Production must retain complete temporary-file flush, same-volume sibling placement, pre-visibility validation, and write-through `MoveFileExW`/`ReplaceFileW`; it must record directory-flush support and never claim unsupported durability. This limitation is retested during Milestone 5 and production implementation.

## Compatibility and migration

This decision changes no production code or current project. Gamebook 0.5.3 version 1 Gzip JSON projects continue to open, edit, save, recover, and export unchanged.

ADR-0009 freezes deterministic version 1 migration and version 2 repair/future-version behavior. Migration runs in an isolated workspace, does not mutate the source, and preserves byte-identical screenshots, page order, transforms, annotations, connectors, text, backgrounds, and metadata. The first successful version 2 replacement retains a collision-safe version 1 backup. Failure leaves source and backup state unchanged.

Before production adoption, rollback is removal of implementation paths while preserving this decision and its evidence. Unsupported future major versions are rejected without workspace or source mutation.

## Accessibility

The container is not exposed as a visual-only concept. Open, materialization, Save, cancellation, lock and recovery review, external-change choice, cache estimates, cleanup, validation failure, and completion require semantic controls, keyboard operation, visible/restored focus, polite progress/status, assertive actionable errors, text not color alone, forced-colors support, reduced-motion behavior, and usable layout at 900 by 620 through 200 percent scale.

The three isolated surfaces passed 13 component tests with no serious or critical axe violations, keyboard/focus review, 100/150/200 percent scale, forced colors, reduced motion, Accessibility Insights, NVDA 2026.1.1, and Windows High Contrast. These outcomes are production acceptance requirements; the spike surfaces are not production UI.

## Security and privacy

All archive input is untrusted. Production must enforce relative POSIX names, case-insensitive destination uniqueness, declared and actual size limits, entry-count limits, checked totals, compression and extra-field policy, no links or reparse escapes, and SHA-256 before asset visibility. Workspaces remain under current-user application data with non-reparse ancestors.

Opaque media tokens bind application instance, workspace, digest, operation, and expiry and contain no path. Reports and diagnostics exclude paths, project titles, record text, tokens, and media bytes. Save/open/recovery require no network request. A OneDrive client may independently synchronize a user-selected managed location, but Gamebook does not upload or claim cloud storage behavior.

Only verified recreatable clean cache is evictable. Unsaved work, recovery journals, interrupted recordings, and Project Trash are not deleted automatically. Failure paths preserve the prior project and expose no partial archive or asset as canonical data.

## Validation

- `npm.cmd run archive-gate:verify -- --self-test`
- `npm.cmd run archive-gate:verify -- --reference docs/spikes/archive-gate-reference-report.json`
- Issue #14: 11-role release matrix for 1 GiB/5 GiB metadata open, selected materialization, cancellation, digest/CRC failure, malformed input, path safety, duplicates, and record limits.
- Issue #15: 11-role release matrix for source identity, copied projects, live/fresh/stale/malformed locks, external changes, close/reopen, cache eviction/cancellation, and reparse rejection.
- Issue #16: 8-role release matrix for local/OneDrive 5 GiB Save and replacement, cancellation, low space, write failure, corruption, and process termination.
- Existing frontend, fixture, production build, Rust test/check, accessibility, compatibility, and publication gates remain required for acceptance.
- `npm.cmd run project-format-contract:verify -- --reference docs/spikes/project-format-freeze-reference-report.json`

Revisit and compare SQLite if metadata open reaches 256 MiB additional memory or extracts media; 5 GiB Save reaches 512 MiB or creates another complete copy; stored-entry raw copy fails; prior data cannot be preserved on local NTFS or OneDrive-managed storage; validation, workspace isolation, accessibility, or privacy cannot be maintained; or representative latency blocks the workflow.

## Documentation impact

- `docs/PROJECT-FORMAT-V2.md`
- `docs/VIDEO-EVIDENCE-ARCHITECTURE.md`
- `docs/spikes/archive-gate.md`
- `docs/spikes/archive-gate-reference-report.json`
- `docs/QA.md`
- GitHub issues #17 and #20
- [ADR-0008](0008-canonical-version-2-records.md)
- [ADR-0009](0009-version-1-migration-and-repair.md)
