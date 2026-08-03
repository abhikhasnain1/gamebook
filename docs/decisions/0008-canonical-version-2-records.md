# ADR-0008: Canonical version 2 records

- Status: Accepted
- Date: 2026-08-03
- Governing issue: #20
- Roadmap milestone: Milestone 5
- Supersedes: None
- Superseded by: None

## Context

Gamebook needs one durable record graph for screenshots, recordings, clips, frames, pages, annotations, research, settings, and deletion before version 2 implementation begins. Earlier specifications described the intended content, while ADR-0001 and ADR-0003 through ADR-0007 froze placement, timing, media, audio, color, and recovery boundaries. Issues #14 through #17 and ADR-0002 established the accepted ZIP64 and workspace foundation.

The version 1 Gzip JSON session remains current production behavior. This decision defines the future version 2 contract without changing the application or converting a project.

## Decision drivers

- Give every canonical record a stable type, version, owner, and machine-readable schema.
- Preserve exact media provenance and ADR-0001 placement geometry without runtime state.
- Make research content semantic and independent of canvas interpretation or color.
- Keep search, previews, and indexes rebuildable rather than authoritative.
- Preserve source recordings while clips, frames, timed annotations, or placements depend on them.
- Make Project Trash atomic, recoverable, dependency-aware, and explicitly emptied.
- Keep paths, media tokens, credentials, and sensitive diagnostics outside persistent records.

## Options considered

### One monolithic project document

A single document resembles version 1 but requires broad reads and rewrites, duplicates large payload concerns, and makes lazy record ownership and recovery less precise.

### Versioned canonical records with derived caches

Separate records permit lazy reads, atomic workspace updates, explicit ownership, referential validation, and stable research semantics. They require cross-record validation and ordered manifest indexes.

## Decision

Use the schemas in `docs/schemas/` as the normative machine-readable contract. `project-v2.schema.json` defines manifest, immutable content-addressed assets, evidence, timelines, pages, `MediaPlacement`, annotations, connectors, findings, tags, collections, relationships, sessions, and Project Trash. Every canonical record has a discriminator and version; the manifest is format version 2 with minimum reader version 2.

Rust owns archive entries, assets, timelines, workspace journals, validation, materialization, tokens, and replacement. React owns canonical page and research edits through validated commands. Fabric owns logical page composition but persists only normalized annotation and placement data. Global settings use `global-settings-v1.schema.json`; workspace, lock, recovery, and Save journals use `workspace-v1.schema.json` and are never archive records.

Assets are immutable and keyed by the SHA-256 of exact bytes. Screenshots and images reference image assets; videos reference MP4 assets and exact source timelines; clips reference a source-video microsecond range without creating an asset; frames reference a verified PNG plus decoded sample index and source PTS. The canonical frame pair is governed by ADR-0004.

Pages remain 1600 by 900 logical surfaces. `MediaPlacement` contains only ADR-0001 fields. Annotation semantic text, deterministic annotation order, scope, and connector bindings are canonical outside visual pixels. Findings retain Observation, Evidence references, Interpretation, Hypothesis, Follow-up, status, confidence, tags, and revision. Tags require normalized unique names plus a visible label, color, and non-color pattern. Collections and sessions keep ordered evidence references. Relationships use typed source and target references.

Search indexes, thumbnail indexes, previews, and derived text caches are rebuildable hints. A missing or mismatched preview is ignored and rebuilt; it cannot invalidate canonical evidence. Runtime paths, object URLs, media elements, callbacks, decoded frames, viewport transforms, and 256-bit scoped media tokens are forbidden in persistent records.

Project Trash wraps the complete original record, transaction ID, deletion and eligibility times, original order, and dependency snapshot. Eligibility means only that explicit cleanup may be offered. No timer silently deletes a record. Restore operates on the complete transaction. Permanent deletion occurs only through an explicit Empty Trash or confirmed cleanup transaction, and an asset is omitted only after no live or trashed record references it.

## Consequences

Milestone 6 can implement screenshot migration and persistence without reopening record-shape decisions. Later media and research milestones extend behavior through the frozen records rather than replacing the project format. Cross-record validation is mandatory because JSON Schema alone cannot prove ordering, reference integrity, source retention, timeline monotonicity, or normalized tag uniqueness.

Unknown future project record fields fail closed until a schema version adopts them. Global settings preserve unknown values where safe and fall back invalid known values individually. Schema changes require a new record or settings version and an accepted migration decision.

## Compatibility and migration

No version 1 file or current command changes. ADR-0009 governs deterministic version 1 conversion, backups, repair, and future-version rejection. Version 2 readers reject unsupported major versions before creating or mutating a workspace. Older applications refuse version 2 rather than attempting downgrade mutation.

## Accessibility

Canonical semantic text, deterministic record order, finding stages, tag labels and patterns, relationship targets, progress states, repair messages, and dependency summaries let keyboard and assistive-technology surfaces operate without reading the canvas. Production UI must expose named controls, visible and restored focus, throttled announcements, forced-colors-safe status, reduced-motion behavior, and usable layouts at 900 by 620 through 200 percent scale.

## Security and privacy

Archive names and contents remain untrusted. JSON and manifest entries are limited to 16 MiB, previews to 32 MiB, and archives to 250,000 entries. Relative POSIX path validation rejects absolute paths, drive prefixes, traversal, NUL, alternate data streams, links, reparse escapes, and case-insensitive duplicates. Assets are verified by SHA-256 before visibility.

The WebView receives no source or workspace path. Media tokens are 256-bit random, operation- and workspace-scoped, short-lived, and never persisted or logged. Credentials remain in Windows Credential Manager. Canonical records, logs, diagnostics, and exports follow `SECURITY-PRIVACY.md`; export privacy controls do not mutate source records.

## Validation

- `npm.cmd run project-format-contract:verify -- --self-test`
- `npm.cmd run project-format-contract:verify -- --reference docs/spikes/project-format-freeze-reference-report.json`
- Valid fixtures exercise every canonical record, evidence kind, settings document, workspace journal, migration report, and repair report.
- Invalid fixtures exercise archive abuse and limits, duplicate assets and tags, missing references, invalid clip/timeline identity, runtime token persistence, source retention, implicit microphone consent, automatic Trash deletion, future versions, source mutation, and invented repair content.
- Milestone 6 must add archive round trips, transaction interruption, migration equivalence, render differences, accessibility UI, and version 1 regression tests against these schemas.

## Documentation impact

- `docs/PROJECT-FORMAT-V2.md`
- `docs/VIDEO-EVIDENCE-ARCHITECTURE.md`
- `docs/SECURITY-PRIVACY.md`
- `docs/ACCESSIBILITY.md`
- `docs/QA.md`
- GitHub issues #20 and #21
