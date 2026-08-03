# ADR-0009: Version 1 migration and repair

- Status: Accepted
- Date: 2026-08-03
- Governing issue: #20
- Roadmap milestone: Milestone 5
- Supersedes: None
- Superseded by: None

## Context

Gamebook 0.5.3 stores a version 1 session as Gzip-compressed JSON with base64 screenshot and thumbnail data, page-local screenshot geometry, Fabric annotation JSON, extracted text, backgrounds, and monitor metadata. The current reader also accepts plain JSON by falling back after Gzip decoding fails. Version 2 must preserve that baseline while refusing unsupported or corrupt input without silent mutation.

## Decision drivers

- Preserve exact screenshot bytes, page order, IDs, transforms, annotations, connectors, text, backgrounds, and metadata.
- Produce deterministic records and reports from the same source bytes.
- Keep the opened version 1 source unchanged until a complete version 2 replacement succeeds.
- Preserve a collision-safe version 1 backup on first replacement.
- Recover valid content from damaged version 2 archives without inventing missing content.
- Reject unsupported future major versions before workspace or source mutation.

## Options considered

### In-place conversion

In-place conversion minimizes temporary storage but can destroy the only valid project during decoding, normalization, validation, or replacement failure.

### Isolated deterministic migration with backup

Workspace migration preserves the source, supports repeatable verification, and promotes only a fully validated replacement. It costs temporary workspace and backup storage.

## Decision

Detect Gzip JSON version 1 and plain JSON version 1 by content, not extension. Parse through the current version 1 compatibility contract, then migrate in a source-keyed workspace without modifying the opened file. Preserve existing project, page, annotation, and connector IDs when valid and unique. Derive new evidence and placement IDs deterministically from the source SHA-256, legacy type, and legacy ID; the same source must produce the same IDs and normalized records.

Decode each screenshot data URL once and verify that the immutable asset bytes are byte-identical. Preserve page and active-page order, titles, timestamps, monitor metadata, dimensions, screenshot transform, background, thumbnail meaning, extracted text, normalized annotations, connector bindings, and export order. Create one primary screenshot evidence and `MediaPlacement` per legacy page. All legacy annotations are page-persistent.

Migration emits a versioned report with source and target formats, source digest, ID mappings, asset byte-identity results, page semantic results, render-diff results, messages, and `sourceMutated: false`. Acceptance requires 1600 by 900 output with fewer than 0.1 percent of pixels above a per-channel difference of 8. Cancellation or failure leaves the source, prior saved project, and backup state unchanged.

The first successful Save over a version 1 source creates a collision-safe timestamped `.v1-backup` before replacement. The replacement then follows ADR-0002. It is not marked complete until the visible version 2 archive validates and reopens. Repeated save/reopen must introduce no semantic migration changes.

Repair is read-only. It reports valid and invalid record IDs, missing assets, actionable messages, and whether content is recoverable. It may expose valid recoverable records for user-directed Save As, but never fabricates screenshots, annotations, findings, assets, or relationships and never changes the source. Unsupported future major versions return `future-version-rejected` before creating a mutable workspace.

## Consequences

Migration and repair require explicit reports and deterministic fixture coverage. A partially recoverable project may require user review and a new Save As destination. Gamebook never describes omitted or invented content as repaired.

## Compatibility and migration

This decision changes no current version 1 reader or writer. Milestone 6 implements the new path while retaining existing open, edit, Save, recovery, and export behavior. The committed version 1 fixture and its screenshot hash remain the compatibility baseline. Downgrade mutation is unsupported; an older reader refuses version 2.

## Accessibility

Migration, backup, repair, cancellation, and future-version outcomes require semantic headings and lists, keyboard-operable actions, visible and restored focus, polite progress, assertive actionable errors, and concise announcements. Reports expose page and record names or stable labels without requiring canvas inspection. Status and severity remain textual in High Contrast and reduced motion, and layouts remain usable at 900 by 620 through 200 percent scale.

## Security and privacy

Source bytes and records are untrusted and subject to archive, JSON, data-URL, dimension, allocation, and decompression limits before use. Migration and repair perform no network request. Paths, project text, screenshot bytes, media tokens, and record payloads are excluded from default logs. Reports use stable IDs, digests, counts, error codes, and concise redacted detail. A failed parse cannot delete or replace existing evidence.

## Validation

- `npm.cmd run fixtures:verify`
- `npm.cmd run project-format-contract:verify -- --self-test`
- `npm.cmd run project-format-contract:verify -- --reference docs/spikes/project-format-freeze-reference-report.json`
- Milestone 6 must validate both Gzip and plain JSON detection; deterministic repeated migration; byte-identical screenshot extraction; annotation, connector, transform, text, background, order, and metadata equivalence; exact render thresholds; cancellation and interruption; collision-safe backup; save/reopen stability; read-only partial repair; malformed data; and future-major rejection.

## Documentation impact

- `docs/PROJECT-FORMAT-V2.md`
- `docs/ARCHITECTURE.md` when implementation changes current behavior
- `docs/USER-GUIDE.md` when migration UI exists
- `docs/QA.md`
- GitHub issues #20, #21, and Milestone 6 implementation issues
