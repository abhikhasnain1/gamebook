# Gamebook Project Format Version 2

> Status: Accepted architecture contract under dependency-ordered implementation. ADR-0002, ADR-0008, and ADR-0009 freeze the container, records, settings, workspace, migration, repair, and compatibility boundaries. The production screenshot editor uses the version 2 archive, workspace, migration, repair, canonical placement, versioned settings, Project Trash, and canonical research-record preservation paths. Video records and research editing workflows remain assigned to later roadmap issues.

## Goals

Version 2 must remain a portable single `.gamebook` file while supporting large media without base64 serialization, whole-project memory loading, eager extraction, or autosave archive rebuilds.

The format must preserve version 1 projects, survive interrupted writes, support deterministic provenance, and permit lazy access to recordings and extracted frames.

## Normative schemas

The machine-readable schemas are authoritative for record fields and versions:

- [`project-v2.schema.json`](schemas/project-v2.schema.json): manifest, assets, evidence, timelines, pages, placements, annotations, findings, tags, collections, relationships, sessions, and Project Trash.
- [`global-settings-v1.schema.json`](schemas/global-settings-v1.schema.json): global capture, shortcut, playback, accessibility, storage, Trash, and diagnostic preferences.
- [`workspace-v1.schema.json`](schemas/workspace-v1.schema.json): workspace state, locks, recovery journals, and Save journals.
- [`migration-repair-v1.schema.json`](schemas/migration-repair-v1.schema.json): deterministic migration and read-only repair reports.

Cross-record constraints that JSON Schema cannot express are part of this contract and are checked by `npm.cmd run project-format-contract:verify`. These include referential integrity, manifest order, unique asset digests and normalized tag names, exact timeline order, valid clip ranges, source retention, archive path safety, and explicit-only Trash cleanup.

## Implementation status

The Rust-owned implementation validates archive names, metadata, compression, limits, canonical records, record identity, annotation order, typed relationships, source-video/timeline links, source retention, and Trash wrapper identity. Initial open reads the central directory, manifest, active page, immediate evidence, and required timeline only; other records load on demand. Asset materialization, source-keyed workspaces, locks, recovery and Save journals, scoped media tokens, clean-cache eviction, external-change choices, cancellable raw copy, complete replacement validation, same-volume write-through replacement, directory-flush reporting, and visible reopen are reachable through typed native commands.

The React/Fabric screenshot editor creates canonical screenshot evidence, page, annotation, connector, and `MediaPlacement` records. Native screenshot events expose only an opaque capture claim ID and display metadata; screenshot bytes enter the workspace without crossing renderer IPC as base64. Open, autosave, Save, Save As, cancellation, external-change conflict, recovery, materialization, and clean-cache controls use the version 2 workspace path. Viewport and runtime token state remain ephemeral, while PNG, PDF, Markdown, text, thumbnails, history, connectors, and crop extraction continue to use the 1600 by 900 logical page.

Deterministic Gzip/plain version 1 migration, byte-identical screenshot staging, schema-valid migration reports, read-only repair reports, future-major rejection, and collision-safe first-replacement backups are integrated into the same visible Open workflow. The 1600 by 900 screenshot comparison reports zero pixels above the per-channel threshold of 8 for the committed migration fixture, below the required 0.1 percent limit.

Global settings are atomically owned by Rust, migrate one version at a time, preserve unknown safe values, default invalid known fields individually, preserve corrupt input before restoring defaults, preserve unsupported future settings without allowing mutation, reject credential-like fields, and keep microphone capture off without separate versioned consent. The Settings surface provides native-path import/export/reset and applies the validated WebView scale preference.

Project Trash calculates a closed dependency set before deletion, reports blockers without mutating the project, commits canonical records plus workspace recovery state through one rollback-capable transaction, retains required assets, restores the complete transaction at original order, and permanently omits unreferenced assets only after explicit cleanup. Loaded canonical records round-trip through the editor unchanged outside fields the current UI owns; unloaded research records remain native-owned and are copied unchanged during Save. Search text and preview hints remain rebuildable derived state. Research editing UI and video records remain future implementation work.

## Package layout

```text
manifest.json
records/sessions/{id}.json
records/evidence/{id}.json
records/pages/{id}.json
records/findings/{id}.json
records/tags/{id}.json
records/collections/{id}.json
records/relationships/{id}.json
records/trash/{id}.json
assets/{sha-prefix}/{sha256}.{extension}
previews/{evidence-id}/thumbnail.jpg
previews/{evidence-id}/poster.jpg
timelines/{video-id}.json
```

JSON and text entries use Deflate compression. MP4, PNG, and JPEG entries are stored without redundant recompression. Assets are immutable and addressed by the SHA-256 digest of their exact bytes. Clips contain source ranges and do not create media assets.

`manifest.json` contains the format version, project metadata, ordered record IDs, asset index, and minimum reader version. Page, evidence, and session records are separate so the working copy can update them independently.

## Canonical records

An evidence record contains a stable ID, evidence kind, title, timestamps, capture/import metadata, tags, relationships, preview references, and a type-specific payload.

- Screenshot evidence references an immutable image asset.
- Video evidence references an MP4 asset, timeline entry, dimensions, duration, audio metadata, and decoder information.
- Clip evidence references a source video ID and source start/end microseconds.
- Frame evidence references a source video ID, source timestamp, decoded sample index, and PNG asset.

Pages contain ordered `MediaPlacementRecord` values, Fabric annotation JSON, annotation scopes, page background, structured notes, and the primary evidence ID where applicable.

Canonical research records are fixed by ADR-0008 before Milestone 6:

- A finding stores Observation, Interpretation, Hypothesis, Follow-up, status, confidence, evidence references, tags, author-local timestamps, and revision metadata.
- A tag stores stable ID, unique normalized name, visible label, optional description, color/pattern presentation, and sort order.
- A collection stores stable ID, title, description, ordered evidence references, and timestamps.
- A relationship stores source ID, target ID, one typed relation (`supports`, `contradicts`, `derived-from`, `compares`, or `follow-up`), optional note, and timestamps.
- A session stores game, build, platform, level, test label, start/end time, capture defaults, and ordered evidence references.

Search indexes, thumbnail indexes, previews, and derived text caches are rebuildable workspace data and are never canonical archive records. A missing or mismatched preview is ignored and rebuilt from canonical evidence.

## Lazy open and materialization

Opening a project reads only the ZIP central directory, manifest, and records required for the initial UI. Media remains in the archive until playback, decoding, export, or editing requires a filesystem path.

Materialization streams one archive entry into the app-managed workspace while calculating SHA-256. The completed file becomes visible only after its digest matches the asset record. Verified entries are reused across page switches and jobs.

Binary assets never cross Tauri IPC as base64. The frontend receives an opaque token that resolves only within the application's scoped media protocol.

## Workspace identity and locking

Each opened project receives a workspace keyed by a generated workspace ID and the canonical source path fingerprint, not only the project ID. This prevents copied projects with identical internal IDs from sharing mutable state.

The workspace contains:

- Atomic working records and a recovery journal.
- New or changed assets.
- Lazily materialized source assets.
- Interrupted recording staging files and their recovery journals.
- A lock containing process ID, application instance ID, source fingerprint, and last heartbeat.

Because Gamebook is single-instance, opening the same source path twice activates its existing workspace instead of creating another. Opening a byte-identical project from a different path creates a separate workspace and reports that it is a copy.

A lock is stale only when its process is absent and its heartbeat has expired. Stale locks never cause automatic deletion; they open the recovery flow. If the source file changes externally after opening, Save pauses and offers Save As or explicit replacement rather than silently overwriting it.

## Autosave and cache lifecycle

Autosave atomically writes changed records and the recovery journal inside the workspace. It never rebuilds the archive. Source and generated assets are immutable once referenced.

Unsaved or recovery-pending workspaces are never evicted automatically. Clean materialized cache entries may be evicted using least-recently-used order after their project is closed. Storage settings show clean cache size, recoverable workspace size, and safe cleanup actions.

Removing an evictable cache file does not remove an archive asset or evidence record. Reopening it materializes the entry again and re-verifies its digest.

Interrupted recording files are not ordinary cache entries. They remain quarantined until the user recovers or discards them and are listed separately in Storage settings.

## Streamed Save and replacement

Manual Save performs these steps:

1. Flush and validate all working records.
2. Estimate output and temporary-space requirements.
3. Create a sibling temporary ZIP64 archive.
4. Raw-copy unchanged stored media entries from the source archive without materializing them.
5. Write changed records and new workspace assets while streaming and hashing.
6. Validate entry references, sizes, digests, and the new manifest.
7. Flush the temporary file and containing directory where supported.
8. Replace an existing destination with `ReplaceFileW`, or atomically rename a first save.
9. Mark the workspace clean only after replacement succeeds.

Cancellation, validation failure, insufficient space, forced termination, or write failure leaves the previous project intact. The temporary replacement is clearly identified and cleaned only after the application verifies it is unreferenced.

The save path never loads an entire asset or archive into frontend or Rust memory. It creates no additional complete copy beyond the source and replacement archives; lazily materialized working assets may also exist.

## Source retention and materialization

A source recording cannot be deleted while clips, frames, timed annotations, or placements depend on it.

Materializing a clip uses the native media pipeline to create and verify an independent H.264/AAC MP4 asset covering the selected range. Dependent placements and timed annotations are remapped to the new source timeline, and provenance records the former relationship. The original source becomes deletable only when no references remain.

Frame evidence is independent once its PNG asset is complete and verified, but it retains historical provenance to the former source even if that source is later removed.

## Deletion and Project Trash

Deleting evidence is an atomic project transaction. Before commit, the application calculates inbound and outbound references and presents the placements, findings, relationships, clips, frames, and annotations that would be affected.

Eligible records move to `records/trash/` with their original record type, deletion timestamp, transaction ID, and dependency snapshot. Project Trash retains records and required assets for 30 days by default. Reaching `eligibleAfter` only makes a transaction eligible for explicit cleanup; no timer silently deletes it. Undo or Restore reinstates the whole transaction and its ordering.

Source evidence with active dependents cannot enter Trash. For other evidence, the user may cancel or explicitly remove eligible placements/links as part of the same transaction; Gamebook never deletes containing findings or notes automatically.

Empty Trash is an explicit irreversible operation. Permanently deleted records disappear from the next archive, and assets are omitted only when no live or trashed record references their digest. Batch operations either complete completely or leave the project unchanged.

The screenshot editor implements this contract for closed canonical dependency sets. Deleting a page reviews the page and its exclusively owned screenshot evidence together; shared placements, findings, collections, sessions, timed annotations, clips, frames, and other live dependencies block deletion rather than being silently rewritten. Relationship and timeline records that belong to the selected closed set move with the same transaction. Storage lists each transaction, retention eligibility, retained bytes, complete restore, eligible cleanup, and explicit Empty all.

## Global settings format

Global preferences live outside `.gamebook` in an atomic `settings.json` under the Tauri application configuration directory. The root contains `settingsVersion`, capture defaults, shortcut mappings, playback/accessibility preferences, storage limits, trash retention, and diagnostic consent.

Migrations run one version at a time and have fixture tests. Unknown future settings are preserved when safe; invalid known values fall back individually. A corrupt file is renamed with a timestamp before defaults are created. Secrets and cloud credentials are stored only in Windows Credential Manager.

The production settings manager implements version 1 at the native boundary. Startup, update, and import normalize every known field independently against the frozen contract while preserving unknown safe values. Corrupt files are renamed to a collision-safe timestamped copy before defaults are written. Unsupported future settings remain byte-identical on disk while session defaults are read-only. Import failure leaves current settings unchanged, native dialogs keep paths out of renderer IPC, and credential-like fields are rejected before a settings write. The current UI exposes recording defaults, separate audio and microphone consent versions, conflict-safe screenshot and video shortcuts, playback, reduced motion, WebView scale, cache limit, Trash retention, local logging, import, export, and reset.

## Version 1 migration

The loader detects Gzip JSON and plain JSON by content signature. Migration runs in a workspace and does not modify the opened file.

Migration must:

- Decode each screenshot data URL into a byte-identical immutable asset.
- Preserve page IDs and order, active page, titles, timestamps, monitor metadata, source dimensions, transforms, backgrounds, extracted text, thumbnails, and normalized annotation JSON.
- Create one primary media placement for each legacy screenshot.
- Mark every legacy annotation as page-persistent.
- Preserve connector IDs and bindings.
- Produce a migration report before the first version 2 Save.

The first successful replacement of a version 1 path creates a collision-safe timestamped `.v1-backup`. A failed Save leaves the source and backup state unchanged. Re-running migration against the same source is deterministic.

Unsupported future major versions are rejected without creating or mutating a workspace. Missing or corrupt records produce a repair report and expose valid recoverable content without silently inventing replacements.

Archive readers apply the validation, path-safety, decompression, token, and logging requirements in [SECURITY-PRIVACY.md](SECURITY-PRIVACY.md).

## Archive feasibility gate

The spike uses representative 1 GB and 5 GB projects and records Windows version, CPU, RAM, storage type, OneDrive state, archive entry count, and media distribution.

ZIP64 is accepted only when the spike demonstrates:

- Initial metadata open without media extraction and with less than 256 MB additional memory for the 5 GB fixture.
- Materialization of only the selected recording during first playback.
- A 5 GB Save with less than 512 MB additional memory.
- No complete temporary copy beyond the replacement archive.
- Correct cancellation and recovery during low disk space, forced termination, checksum failure, and simulated write failure.
- Correct replacement on local NTFS and a OneDrive-managed directory.
- Correct stale-lock, external-change, duplicate-copy, and cache-eviction behavior.

The report records wall-clock open, materialization, validation, and Save times. A future regression to unexpectedly poor latency or unsupported raw-copy behavior triggers comparison with the SQLite-container alternative.

Issues #14 through #17 passed the complete gate. The 5 GiB metadata open used 421,888 additional private bytes with no media extraction; selected materialization exposed only the requested verified asset; the 5 GiB Save used at most 1,523,712 additional private bytes and one replacement archive; and local NTFS, OneDrive-managed replacement, workspace identity, locks, copied-project separation, recovery, and cache scenarios passed. The combined [archive-gate report](spikes/archive-gate.md) and [ADR-0002](decisions/0002-zip64-project-storage.md) accept ZIP64 without requiring a SQLite comparison.

The reference system did not support `FlushFileBuffers` on the containing directory. The accepted contract retains complete temporary-file flush, pre-visibility validation, same-volume sibling placement, and write-through `MoveFileExW` or `ReplaceFileW`, records directory-flush support accurately, and reopens the visible archive before marking the workspace clean. It never claims unsupported directory-flush durability.

## Security limits

Manifest and individual JSON entries are limited to 16 MiB, previews to 32 MiB, and an archive to 250,000 entries. Names are relative POSIX paths. Readers reject absolute paths, drive prefixes, `..`, NUL, alternate data streams, links, reparse escapes, and case-insensitive duplicate destinations before materialization. Declared and actual sizes are checked, and every content-addressed asset is SHA-256 verified before visibility.

Native code issues 256-bit random media tokens bound to one application instance, workspace, digest, and operation. Tokens and filesystem paths are never archive, settings, log, diagnostic, or export fields. Credentials remain in Windows Credential Manager.

## Contract validation

```powershell
npm.cmd run project-format-contract:verify -- --self-test
npm.cmd run project-format-contract:verify -- --reference docs/spikes/project-format-freeze-reference-report.json
```

The valid fixtures cover every canonical record and support document. Invalid fixtures cover archive abuse and limits, malformed references and timing, source retention, implicit microphone consent, automatic deletion, future versions, migration mutation, and invented repair content. Milestone 6 adds production archive round trips, interruption, render equivalence, migration, repair, accessibility, and version 1 compatibility evidence against this frozen contract.

## Migration acceptance

- Decoded source image assets are byte-identical to version 1 data URLs.
- Normalized annotation structures, counts, IDs, connector bindings, and transforms are equivalent.
- Migrated renders remain 1600 by 900 and have fewer than 0.1% of pixels exceeding a per-channel difference of 8.
- Page order, active page, titles, text, backgrounds, and export order are exact.
- Saving, reopening, and saving again produces no additional semantic migration changes.
