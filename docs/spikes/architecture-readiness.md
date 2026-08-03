# Milestone 5 architecture readiness audit

## Scope

Issue #21 verifies that accepted decisions, frozen contracts, required specifications, validation evidence, and Milestone 6 tracker units form one implementable dependency chain. This audit changes no production command, schema, project write, user interface, screenshot behavior, or version 1 project behavior.

The machine-readable [reference report](architecture-readiness-reference-report.json) binds the complete authority matrix and downstream traceability requirements.

```powershell
npm.cmd run architecture-readiness:verify -- --self-test
npm.cmd run architecture-readiness:verify -- --reference docs/spikes/architecture-readiness-reference-report.json
```

## Decision coverage

ADR-0001 through ADR-0009 are Accepted and cover rendering and viewport, ZIP64 storage and replacement, native capture, exact timing and decode, whole-device audio, SDR color and aperture, interrupted recording recovery, canonical version 2 records, and deterministic migration/repair. The native-media, placement/viewport, archive-gate, and project-format reference reports retain the measured evidence and implementation conformance requirements.

No media transport, timing, rendering, save, migration, research-record, accessibility, security/privacy, compatibility, or export decision blocks screenshot-only Milestone 6 work. Existing static PNG/PDF/Markdown/text export remains current behavior. Future multimedia export is constrained by ADR-0001 composition, ADR-0004 exact source identity, ADR-0008 semantic records, and the product, accessibility, and security specifications; implementation dependency choices remain owned by the later export issue rather than Milestone 6.

## Downstream order

Milestone 6 remains split into four reviewable units:

1. Issue #22 implements native workspaces, immutable assets, archive validation, materialization, recovery, and streamed Save.
2. Issue #23 implements deterministic version 1 migration, backup, future-version rejection, and read-only repair.
3. Issue #24 generalizes current screenshots to the stable placement and semantic Outline boundary while preserving editing and exports.
4. Issue #25 implements versioned settings, atomic Project Trash, and canonical research foundations.

Each issue directly cites the accepted ADRs, schemas, retained report, required specifications, upstream dependency, accessibility evidence, security/privacy boundaries, compatibility contract, and exact production conformance it owns. Issue #22 is the first ready unit after this audit; #23 through #25 remain dependency-blocked.

## Audit result

All local Markdown links resolve. Every ADR is Accepted and contains context, drivers, alternatives, decision, consequences, compatibility, accessibility, security/privacy, validation, and documentation impact. All four frozen reference reports retain their expected governing issue, schema, status, thresholds, and current-versus-future boundary. Provisional spike statements remain historical; current authority text points to accepted decisions.

The application remains Gamebook 0.5.3 with version 1 Gzip/plain JSON persistence. Milestone 6 must re-run the frozen conformance, current screenshot regression, accessibility, security/privacy, build, installer, and publication gates in each owning issue.
