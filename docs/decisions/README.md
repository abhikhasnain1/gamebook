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
