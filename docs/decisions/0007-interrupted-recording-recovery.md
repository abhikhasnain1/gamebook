# ADR-0007: Interrupted recording recovery

- Status: Accepted
- Date: 2026-08-03
- Governing issue: #18
- Roadmap milestone: Milestone 5
- Supersedes: None
- Superseded by: None

## Context

Recording can fail during initialization, capture, encoding, storage, device use, or finalization. A partially written file must never become trusted evidence, but automatically deleting all output can destroy playable user work. Issue #9 exercised cancellation and injected initialization, encoder, decoder, GPU, storage, and finalization failures. It also exercised graceful and forced interruption before and after finalization.

The evidence distinguished playable finalized-but-unpromoted media from unplayable interrupted media. It proved that neither class needs automatic project references, promotion, deletion, or destructive repair.

## Decision drivers

- Never reference media before final probing validates it.
- Preserve recoverable finalized work without representing it as completed evidence.
- Keep unplayable output inspectable and user controlled without exposing it to the project.
- Make cancellation and late-event handling deterministic.
- Protect the last saved project through every recording failure boundary.

## Options considered

### Delete every incomplete output

This simplifies cleanup but can discard a playable finalized recording after promotion or application interruption and removes the user's ability to decide.

### Stage, probe, recover, or quarantine

This keeps incomplete output outside canonical records, distinguishes playable drafts from unplayable files, and requires explicit user action before promotion or deletion.

## Decision

Recording uses `idle -> preparing -> recording -> finalizing -> completed | failed | cancelled`. Native media and a recovery journal remain in a staging area until finalization and probing validate at least one playable video sample and the expected media contract. A project record cannot reference the staging path or media before that probe succeeds.

Playable finalized-but-unpromoted media becomes an explicitly labeled recoverable draft. Unplayable interrupted media is quarantined. Neither state is automatically promoted, referenced, repaired, deleted, or included in diagnostics. Recovery offers retry probe, recover eligible draft, reveal, and delete. Destructive actions require explicit confirmation and apply only to the selected recording ID.

Cancellation is idempotent. Every native event includes its recording ID, and late events are ignored unless that ID is still current. Initialization, encoder, decoder, GPU, storage, finalization, device-loss, source-close, and protected-content failures leave generated partial assets unreferenced. A failure cannot mutate the last saved project.

## Consequences

The workspace owns staging journals and separates recoverable recordings from clean evictable cache. Unsaved, recovery-pending, and quarantined files are never evicted automatically. Startup recovery validates journal and path boundaries before presenting any action.

The user may retain local quarantined bytes until deciding what to do. Storage settings must report recoverable and quarantined storage separately and never describe it as canonical project evidence.

## Compatibility and migration

This decision changes no version 1 project or recovery file. Future version 2 workspaces add recording journals and state without allowing version 1 Save to reference them. Unsupported, corrupt, cancelled, and failed inputs are not silently repaired or mutated.

## Accessibility

Failure review, recovery, retry, reveal, and delete are semantic keyboard workflows with accessible names, visible and restored focus, explicit state, and announced outcomes. Draft and quarantine states are textual and do not rely on color, icons, animation, or sound. Confirmation and error dialogs retain focus and remain usable in forced colors, reduced motion, 900 by 620, 100/150/200 percent scale, Accessibility Insights, and NVDA.

## Security and privacy

Staging paths are app-managed, local, scoped to the current user, and never sent to the frontend as filesystem paths. Opaque tokens are short lived and limited to validated entries. Recovery validates path containment, file type, size, and media limits before probing. Diagnostics exclude paths, titles, endpoint IDs, tokens, media, captions, transcripts, and note text; quarantined media is excluded by default and can only be attached through separate explicit consent.

## Validation

The accepted evidence is Issue #9 revision `f615378cb003b1a7e832ab601d59c56352658928`, binary SHA-256 `CF3E208FF67641E0D7CA93238DF7E7EACF274776F556ED2DFD5EF772EF5B5CD9`, and 29 machine-verified reports. Production conformance covers cancellation before and during capture, every injected failure boundary, graceful interruption, forced interruption, finalized-unpromoted recovery, unplayable quarantine, stale events, repeated cancellation, explicit deletion, restart recovery, diagnostics exclusion, and prior-project preservation.

## Documentation impact

This record freezes recording lifecycle and recovery in `docs/VIDEO-EVIDENCE-ARCHITECTURE.md`, constrains Issue #20 workspace and evidence schemas, and governs Milestone 7 recording failure and recovery implementation.
