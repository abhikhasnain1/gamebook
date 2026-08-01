# Documentation Index

This index defines how Gamebook's documentation fits together. Read it before planning or changing the product.

## Document status

Gamebook documentation uses four kinds of truth:

- **Current behavior:** verified behavior in the present codebase. `README.md`, `docs/USER-GUIDE.md`, `docs/ARCHITECTURE.md`, and `docs/QA.md` describe this baseline unless a section says otherwise.
- **Required specification:** product, accessibility, and security requirements that all applicable implementation work must satisfy.
- **Proposed contract:** architecture or format design that remains provisional until its feasibility gates pass and an accepted decision record freezes it.
- **Execution state:** milestones, issues, pull requests, and validation evidence. GitHub Issues are the authority for task status; the roadmap defines dependency order, not day-to-day status.

Do not infer that a feature exists because it appears in a proposed or required specification.

## Required reading

| Document | Role | Read when |
| --- | --- | --- |
| [README](../README.md) | Product overview and current setup | Starting any repository work |
| [Product specification](PRODUCT-SPEC.md) | Product purpose, scope, workflows, and release acceptance | Planning or changing user-facing behavior |
| [Video and evidence architecture](VIDEO-EVIDENCE-ARCHITECTURE.md) | Proposed media ownership, timing, rendering, and cleanup contracts | Media, canvas, playback, frame, or export work |
| [Project format version 2](PROJECT-FORMAT-V2.md) | Proposed archive, workspace, migration, and evidence records | Persistence, import, migration, recovery, or storage work |
| [Accessibility specification](ACCESSIBILITY.md) | Required accessible interaction and validation | Every user-facing milestone |
| [Security and privacy specification](SECURITY-PRIVACY.md) | Required data, media, diagnostics, export, and update boundaries | Every milestone that handles data or system capabilities |
| [Roadmap](ROADMAP.md) | Dependency order, gates, and milestone exits | Planning issues, branches, and releases |
| [Issue tracking](ISSUE-TRACKING.md) | Issue structure, labels, ownership, and audit rules | Creating or updating project work |
| [Architecture](ARCHITECTURE.md) | Current runtime and version 1 data model | Changing implementation ownership or persistent behavior |
| [Release QA](QA.md) | Current regression and release checks | Implementing, reviewing, or releasing |
| [User guide](USER-GUIDE.md) | Current user workflows | Changing controls, behavior, or public instructions |
| [Decision records](decisions/README.md) | Durable architecture decision policy | Selecting among meaningful technical alternatives |

## Authority and conflicts

Use this order when sources disagree:

1. Accepted decision records govern the decision they explicitly cover.
2. Product, accessibility, and security specifications govern required outcomes.
3. Frozen architecture and format contracts govern implementation boundaries.
4. The roadmap governs dependency order and milestone gates.
5. Code and tests establish what is currently implemented.
6. Current-state guides describe the supported user experience.

This order is not permission to resolve a contradiction silently. Record the conflict in the owning issue, identify the affected documents, and update all accepted sources in the same reviewed change.

Provisional media and version 2 format sections do not become frozen contracts until Milestones 2 through 4 pass and Milestone 5 records the accepted decisions.

## Change protocol

Every product change must identify:

- Governing issue and roadmap milestone.
- Source documents and affected acceptance criteria.
- Dependencies and non-goals.
- Compatibility and migration impact.
- Accessibility impact and validation.
- Security and privacy impact and validation.
- Automated and manual test evidence.
- Documentation and decision-record updates.

GitHub Issues own execution status. Documents own durable knowledge and must not contain a duplicate open/closed backlog.
