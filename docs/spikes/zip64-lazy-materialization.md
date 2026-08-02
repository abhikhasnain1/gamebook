# ZIP64 lazy-open and materialization spike

## Scope

Issue #14 evaluates ZIP64 central-directory access, selective record reads, streamed asset materialization, SHA-256 verification, archive validation, cancellation, scoped asset exposure, and cleanup. The harness is isolated from production Tauri commands and version 1 persistence. It does not freeze the version 2 format, add a project loader, or authorize schema work.

The native example uses `zip` 8.6.0 with seek-based `ZipArchive` access. Synthetic 1 GiB and 5 GiB projects contain a Deflate-compressed manifest and initial page record, one 4 MiB selected stored asset, and one large stored zero-filled asset. The large entry is a valid NTFS sparse range, so the archive has real 64-bit offsets and logical length without consuming the equivalent physical storage.

## Open gate

The example wraps the archive file in a seek-aware read tracer, opens the central directory, validates every entry's metadata, reads `manifest.json`, and reads only the manifest's initial records. Asset payloads are not opened, decompressed, or materialized.

The report separates bounded parser read-ahead into adjacent asset ranges from asset payload requests. A passing 5 GiB run requires:

- a logical archive of at least 5 GiB with ZIP64 required;
- less than 256 MiB additional process private memory;
- zero asset payload opens, zero media extraction bytes, and zero materialized assets;
- a valid format version 2 manifest and its declared initial records;
- complete fixture and temporary-output cleanup.

Fixture creation and hashing complete before the measured open interval. Reports retain archive and allocation sizes, fixture-creation time, open time, memory snapshots, traced read volume, entry count, and initial-record count without retaining fixture bytes or local paths.

## Validation boundary

Before any record read or materialization, the harness:

- requires UTF-8 relative POSIX names;
- rejects absolute paths, drive prefixes, parent/current/empty components, backslashes, NUL characters, alternate data streams, and case-insensitive duplicate destinations;
- rejects encryption, symlinks, Windows reparse attributes, special Unix file kinds, and unsupported extra metadata that could encode link behavior;
- enforces 250,000 entries, 16 MiB manifest/record limits, 32 MiB preview limits, checked total-size accumulation, and actual decompressed read limits;
- verifies manifest asset IDs, archive paths, SHA-256 syntax, sizes, and entry references;
- creates materialized output only inside a newly created non-reparse workspace whose ancestor chain is checked.

Materialization checks available space, creates an exclusive temporary file, streams one selected entry through a bounded buffer and SHA-256 hasher, flushes it, and renames it into visibility only after byte count and digest match. Cancellation, CRC failure, digest failure, or write failure removes the temporary output and issues no token. A successful 256-bit random token is bound to the workspace fingerprint, asset digest, read operation, and ten-minute lifetime; the token and all paths remain outside reports.

## Evidence roles

One release binary and exact source revision must produce independent reports for:

- 1 GiB metadata open;
- 5 GiB ZIP64 metadata open;
- selected-asset materialization;
- digest failure;
- archive checksum failure;
- cancellation;
- malformed archive;
- parent traversal;
- case-insensitive duplicate names;
- oversized JSON;
- compressed oversized JSON.

The evidence manifest binds the release binary and every report to SHA-256. The verifier checks all thresholds, required roles, cleanup, redaction, compatibility declarations, and exact build identity.

```powershell
npm.cmd run zip64-lazy:verify -- --self-test
npm.cmd run zip64-lazy:run -- --build-id <exact-40-character-revision>
```

Raw reports, manifests, sparse fixtures, workspaces, and release binaries remain under `src-tauri/target/` and are not committed.

## Accessibility review surface

The native benchmark is noninteractive. A separate semantic harness exposes archive condition, open, selected-asset materialization, progress, cancellation, digest failure, traversal failure, recovery review, cleanup, and success through ordinary labeled controls and live regions:

```text
http://127.0.0.1:1420/tools/spikes/archive-materialization.html
```

The review covers keyboard operation, focus transfer to actionable errors and recovery, polite progress/status announcements, assertive validation errors, forced colors, reduced motion, 100/150/200 percent UI scale, the 900 by 620 minimum window, axe, Accessibility Insights, and NVDA. The surface uses generic fixture labels and never displays a project path, media bytes, or token.

## Compatibility and decision boundary

The spike uses synthetic local data and performs no network request or project write. Production commands, the version 1 schema, screenshot behavior, recovery, and exports remain unchanged. Issue #14 unlocks workspace lifecycle issue #15; ZIP64 is not selected until issues #15 and #16 pass and issue #17 records the proposed storage decision for Milestone 5.
