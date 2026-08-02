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

## Reference results

The retained [reference report](zip64-lazy-materialization-reference-report.json) summarizes the complete release matrix from implementation revision `d50f484ad61bf8b7308b25c890cd78d89349e94b`. The 474,112-byte release binary has SHA-256 `02AF3D3A0C9E123998254BF2E35C1E265E7E25E9CDFE13C815E4AB4B2865844E`; the evidence manifest verified that binary and all 11 raw reports before cleanup.

| Scenario | Logical archive | Physical allocation | Open time | Additional private memory | Traced read volume | Asset payload opens | Media extracted |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 GiB metadata open | 1,077,937,225 bytes | 4,325,376 bytes | 17 ms | 4,096 bytes | 1,943 bytes | 0 | 0 bytes |
| 5 GiB ZIP64 metadata open | 5,372,904,638 bytes | 4,325,376 bytes | 8 ms | 421,888 bytes | 2,040 bytes | 0 | 0 bytes |

The ZIP parser performed 524-620 bytes of bounded read-ahead into adjacent asset ranges while resolving local headers. No asset payload was requested or opened, and no asset was extracted or materialized during metadata open. The 5 GiB result stayed 267,655,568 bytes below the 256 MiB additional-memory limit.

Selected materialization wrote and verified exactly one 4,194,304-byte asset, left the large asset unrequested, and issued one 256-bit workspace/digest/operation/expiry-bound token only after the final file became visible. Digest mismatch and archive checksum failure each wrote the selected bytes only to an exclusive temporary file, exposed no final output or token, and removed the partial. Cancellation at 2,097,152 bytes produced the same clean result.

Malformed central-directory, parent-traversal, case-insensitive duplicate, oversized JSON, and compressed oversized JSON scenarios all failed closed before canonical records changed or output became visible. Every scenario removed its synthetic fixture; materialization scenarios also removed their workspace with zero partial or final files retained.

## Accessibility review surface

The native benchmark is noninteractive. A separate semantic harness exposes archive condition, open, selected-asset materialization, progress, cancellation, digest failure, traversal failure, recovery review, cleanup, and success through ordinary labeled controls and live regions:

```text
http://127.0.0.1:1420/tools/spikes/archive-materialization.html
```

The review covers keyboard operation, focus transfer to actionable errors and recovery, polite progress/status announcements, assertive validation errors, forced colors, reduced motion, 100/150/200 percent UI scale, the 900 by 620 minimum window, axe, Accessibility Insights, and NVDA. The surface uses generic fixture labels and never displays a project path, media bytes, or token.

Four component tests passed with no serious or critical axe violations. Browser review at 900 by 620 passed at 100, 150, and 200 percent scale with one continuous vertical work area and no horizontal overflow. Keyboard workflows covered metadata open, selected materialization, cancellation, traversal rejection, digest failure, recovery review, cleanup, and success. Actionable errors received focus, recovery headings received focus, and cleanup restored focus to the materialize command. Accessibility Insights for Windows 1.1.2924.1 exposed the expected document, landmarks, labeled controls, disabled states, summary terms, and live status; its automated check correctly delegated Chromium content to the web scanner. NVDA 2026.1.1 was launched against the same Edge surface; spoken-output confirmation remains required before issue closeout.

## Compatibility and decision boundary

The spike uses synthetic local data and performs no network request or project write. Production commands, the version 1 schema, screenshot behavior, recovery, and exports remain unchanged. Issue #14 unlocks workspace lifecycle issue #15; ZIP64 is not selected until issues #15 and #16 pass and issue #17 records the proposed storage decision for Milestone 5.
