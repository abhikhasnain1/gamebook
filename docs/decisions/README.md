# Architecture Decision Records

Architecture Decision Records preserve durable technical decisions and their consequences. They complement specifications and issues; they do not replace either.

## When a record is required

Create or update a decision record when a choice materially affects:

- Runtime ownership or cross-layer interfaces.
- Dependencies, native platform integrations, or build/distribution strategy.
- Persistent schemas, archive layout, migration, recovery, or compatibility.
- Media timing, rendering, color, audio, extraction, or export behavior.
- Security, privacy, accessibility, diagnostics, or update guarantees.
- A previously accepted decision or a roadmap gate.

Routine implementation details that follow an accepted design remain in the issue and code review.

## Lifecycle

Use one of these statuses:

- `Proposed`: under active evaluation and not an implementation contract.
- `Accepted`: approved and authoritative for its stated scope.
- `Rejected`: evaluated and not selected.
- `Superseded by ADR-NNNN`: replaced while preserving historical context.
- `Deprecated`: still present but scheduled for removal.

Only accepted records override earlier architecture prose for the decision they cover. Update affected specifications in the same change so readers do not need to discover a hidden conflict.

## Naming and content

Name records `NNNN-short-title.md`, using the next available four-digit number. Copy [ADR-TEMPLATE.md](ADR-TEMPLATE.md) and fill every section. Link the governing issue, measured evidence, alternatives, consequences, compatibility impact, accessibility impact, security/privacy impact, validation, and superseded records.

Milestone 5 creates the first accepted records for media capture, placement rendering, archive storage, timing, color, audio, and interrupted-recording behavior after the feasibility spikes pass.

## Records

| Record | Status | Scope |
| --- | --- | --- |
| [ADR-0001](0001-media-placement-rendering.md) | Proposed | Fabric offscreen media placement rendering |
| [ADR-0002](0002-zip64-project-storage.md) | Proposed | ZIP64 project storage and streamed replacement |
| [ADR-0003](0003-direct-windows-media-capture.md) | Accepted | Direct Windows capture, encoding, targets, and frame-rate qualification |
| [ADR-0004](0004-source-timing-and-exact-decode.md) | Accepted | Native source timing, frame identity, and exact decode |
| [ADR-0005](0005-system-audio-loopback.md) | Accepted | Whole-output-device audio, synchronization, failure, and consent |
| [ADR-0006](0006-sdr-color-and-logical-aperture.md) | Accepted | SDR color, HDR blocking, padding, and logical aperture |
| [ADR-0007](0007-interrupted-recording-recovery.md) | Accepted | Recording staging, probing, recovery, and quarantine |
