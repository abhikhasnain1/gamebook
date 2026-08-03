# Version 2 project-format architecture freeze

## Scope

Issue #20 accepts [ADR-0002](../decisions/0002-zip64-project-storage.md), [ADR-0008](../decisions/0008-canonical-version-2-records.md), and [ADR-0009](../decisions/0009-version-1-migration-and-repair.md). It freezes architecture and machine-readable schemas without changing production commands, project writes, user interface, Gamebook 0.5.3 screenshot behavior, or version 1 compatibility.

The machine-checked [reference report](project-format-freeze-reference-report.json) binds the schemas and fixtures to the accepted Issue #17 archive gate, Issue #18 native media contract, Issue #19 placement and viewport contract, and the committed version 1 fixture.

```powershell
npm.cmd run project-format-contract:verify -- --self-test
npm.cmd run project-format-contract:verify -- --reference docs/spikes/project-format-freeze-reference-report.json
```

## Frozen boundaries

ZIP64 remains one portable `.gamebook` file with separately compressed canonical records and stored immutable content-addressed assets. Rust owns untrusted archive validation, source-keyed workspaces, locking, recovery, cache, materialization, scoped tokens, streamed Save, pre-visibility validation, and Windows replacement. The reference system's unsupported directory flush is recorded accurately; temporary-file flush, same-volume placement, write-through replacement, and visible-archive reopen remain mandatory.

The project schema versions manifest, assets, five evidence kinds, exact timelines, pages, stable placements, semantic annotations, connectors, findings, tags, collections, relationships, sessions, and Project Trash. Global settings, workspace state, locks, journals, migration reports, and repair reports have separate versioned schemas and owners. Search, previews, indexes, and derived text remain rebuildable.

Project Trash preserves the original record, transaction, order, dependencies, and required assets. Retention expiry means eligible for explicit cleanup, never automatic deletion. Source recordings cannot enter Trash while clips, frames, timed annotations, or placements depend on them.

Version 1 migration accepts Gzip and plain JSON by content, preserves valid legacy IDs, derives new IDs deterministically, verifies byte-identical screenshot assets, checks semantic annotation equivalence and exact render thresholds, and never mutates the source. First replacement preserves a collision-safe `.v1-backup`. Repair is read-only and never invents content. Unsupported future major versions fail before mutable workspace creation.

## Accessibility, security, and compatibility

Semantic research content and deterministic order exist outside canvas pixels. Production migration, repair, Trash, settings, and storage surfaces require keyboard operation, visible and restored focus, concise announcements, textual status, High Contrast and reduced-motion behavior, 900 by 620 support, 100/150/200 percent scale, Accessibility Insights, and NVDA validation.

Archive inputs remain untrusted and use the 16 MiB JSON, 32 MiB preview, and 250,000-entry limits. Paths, runtime state, 256-bit scoped tokens, credentials, media, and sensitive record text are excluded from persistent or diagnostic boundaries as specified. The valid and invalid fixtures verify these contracts without containing captured user or game media.

Milestone 6 must implement and revalidate these boundaries using screenshots only before recording or research workflow production work begins.
