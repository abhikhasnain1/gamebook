# Raw-copy streamed Save and replacement spike

## Scope

Issue #16 evaluates unchanged stored-entry raw copy, bounded-memory hashing, one sibling ZIP64 replacement archive, complete pre-replacement validation, durable first Save, Windows replacement, cancellation, low-space refusal, corruption, injected write failure, forced termination, and cleanup. The harness is isolated from production Tauri commands and version 1 persistence. It does not select ZIP64, freeze the version 2 format, or authorize production Save work.

The native example creates synthetic archives only. Its 5 GiB fixture contains a small manifest and page record plus one valid stored zero-filled media entry with real ZIP64 sizes and offsets. The source uses an NTFS sparse range to avoid consuming 5 GiB before the measured Save. The replacement is written normally and consumes its complete physical size, so the measured path performs a real 5 GiB raw copy.

## Save path

The harness follows the proposed Save ordering without introducing a production interface:

1. Validate the destination leaf, source manifest, stored media metadata, and same-parent replacement boundary.
2. Estimate replacement space and refuse before temporary creation when the effective available space is too small.
3. Exclusively create one sibling replacement archive.
4. Write changed Deflate records, raw-copy the unchanged stored media through `zip::ZipWriter::raw_copy_file`, and stream a new 16 MiB asset through a 1 MiB buffer and SHA-256.
5. Flush the replacement file, reopen it, validate names, references, sizes, compression, CRC, and SHA-256 for all 5,385,486,336 asset bytes, and retain no complete additional temporary copy.
6. Use write-through `MoveFileExW` for first Save or write-through `ReplaceFileW` for replacement.
7. Reopen the visible archive metadata and clean the run-specific fixture root.

The harness attempts `FlushFileBuffers` on the containing directory. Windows did not support that directory-handle flush on the reference system, so the measured durability path uses a fully flushed temporary file and the write-through replacement flags. Issue #17 must retain this measured limitation when it defines the proposed storage contract.

## Recovery scenarios

Cancellation and simulated write failure stop after 8 MiB, remove the partial sibling archive, and leave the prior archive byte-identical and readable. The low-space role injects an effective available-space value one byte below the exact estimate and proves refusal before temporary creation without filling the user's disk.

The corruption role changes one stored-asset byte after the replacement is complete. CRC/SHA-256 validation rejects it before visibility, removes the replacement, and preserves the prior project. The forced-termination role starts the same release binary as a child, waits for a flushed partial-archive checkpoint above 8 MiB, terminates the child process, verifies that the partial remained unreferenced and the prior project remained byte-identical and readable, then removes the reviewed partial.

## Evidence contract

One release binary and exact source revision produce independent reports for:

- cancellation;
- deterministic low-space refusal;
- simulated write failure;
- corruption and checksum rejection;
- true child-process termination;
- 5 GiB local NTFS first Save;
- 5 GiB local NTFS replacement;
- 5 GiB OneDrive-managed replacement.

The manifest binds the release binary and all eight reports to SHA-256. The verifier checks the role set, exact build identity, 5 GiB thresholds, memory, raw-copy and stream-hash contracts, replacement operations, recovery invariants, cleanup, accessibility declarations, privacy, and compatibility. Raw reports, manifests, sparse fixtures, full replacement archives, and binaries remain under `src-tauri/target/` and are not committed.

```powershell
npm.cmd run streamed-save:verify -- --self-test
npm.cmd run streamed-save:run -- --build-id <exact-40-character-revision>
```

## Reference results

The retained [reference report](streamed-save-reference-report.json) summarizes the verified matrix from implementation revision `b14e0ae73918c23f16bfa6dd43242a6d45c57a67`. The 642,560-byte release binary has SHA-256 `C6B9CEC577605946061E7F16697269BBEA0EEBE2463AD4B3C6CF28BC8CC437C3`.

| Scenario | Total Save | Full validation | Additional private memory | Replacement |
| --- | ---: | ---: | ---: | ---: |
| Local NTFS first Save | 17,358 ms | 7,342 ms | 1,523,712 bytes | `MoveFileExW`, 2 ms |
| Local NTFS replacement | 17,680 ms | 7,161 ms | 1,519,616 bytes | `ReplaceFileW`, 467 ms |
| OneDrive-managed replacement | 19,171 ms | 7,147 ms | 1,519,616 bytes | `ReplaceFileW`, 451 ms |

Every large run raw-copied exactly 5,368,709,120 stored bytes, stream-hashed a 16,777,216-byte new asset, validated two assets totaling 5,385,486,336 bytes, stayed more than 535 MB below the 512 MiB additional-memory limit, and had exactly one complete replacement archive at peak. The source stayed valid until replacement, the visible result reopened successfully, and the temporary sibling was absent after success.

Cancellation completed in 130 ms and injected write failure in 133 ms; each stopped at 8,388,608 bytes and removed its partial. The low-space role created no temporary. Corruption was rejected before replacement. Forced termination retained an unreferenced 8,389,125-byte partial for recovery review, then removed it. Every failure role left the prior project byte-identical and readable.

## Accessibility review surface

The native benchmark is noninteractive. A separate semantic surface exposes Save estimates, progress, cancellation, external-change choices, low-space refusal, write failure, recovery, and completion through ordinary labeled controls, alerts, progress, summaries, focused headings, and a polite status region:

```text
http://127.0.0.1:1420/tools/spikes/streamed-save.html
```

Five component tests pass with no serious or critical axe violations. Browser review at 900 by 620 passes at 100, 150, and 200 percent UI scale with no horizontal overflow or clipped control text. The progress, external-change, low-space, write-failure, cancellation, and success states expose expected names, roles, values, focus transfer, and status text. Forced-colors, reduced-motion, and visible-focus rules are present. Accessibility Insights for Windows 1.1.2924.1 exposes the named document and Edge UI Automation exposes the header, main Operation region, Save summary complementary landmark, labeled controls, definitions, disabled states, progress, alerts, and status. Its Chromium automated-check advisory is covered by the clean axe run.

The manual reviewer confirmed that the normal Save/progress/cancellation flow and the external-change, low-space, and write-failure recovery choices passed with NVDA 2026.1.1. The same surface passed Windows High Contrast review. Together with the automated scale, forced-colors, reduced-motion, focus, semantics, and axe evidence, the isolated accessibility review is complete.

## Compatibility and decision boundary

The spike performs no production project write and no application network request. A OneDrive client may independently synchronize its managed test directory; the harness uses synthetic zero-filled media and removes the complete run root. Reports contain no local path, project title, or media bytes.

Production commands, the version 1 schema, screenshot behavior, recovery, and exports remain unchanged. ZIP64 remains provisional. Issue #17 must combine this evidence with issues #14 and #15, record every measured limitation, and either propose ZIP64 for Milestone 5 or perform the required SQLite-container comparison.
