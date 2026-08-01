# Issue Tracking

GitHub Issues are Gamebook's primary execution tracker. Specifications define requirements, the roadmap defines dependency order, decision records define accepted architecture choices, and issues record the status of concrete work.

## Tracker structure

- Create one GitHub milestone for each roadmap milestone that has active work.
- Create an umbrella issue for a milestone when several dependent issues share one exit criterion.
- Keep implementation issues small enough for one reviewable branch and commit series.
- Link dependencies explicitly with `Blocked by` and `Blocks` references.
- Link every implementation pull request to one primary issue.
- Use sub-issues for independently testable deliverables; use checklists only for inseparable steps inside one deliverable.

The roadmap is not a status board. Do not mark roadmap sections complete merely to mirror issue state.

## Labels

Apply one label from each applicable group:

| Group | Labels |
| --- | --- |
| Type | `type: bug`, `type: feature`, `type: spike`, `type: architecture`, `type: documentation` |
| Priority | `priority: P0`, `priority: P1`, `priority: P2`, `priority: P3` |
| Status | `status: ready`, `status: blocked`, `status: in-progress`, `status: review` |
| Area | `area: media`, `area: canvas`, `area: storage`, `area: research`, `area: export`, `area: accessibility`, `area: security` |

Closed issues use GitHub's closed state instead of a `status: done` label. Remove stale status labels whenever state changes.

## Required issue content

Every issue must contain enough information to execute and review without reconstructing its intent from conversation history:

- Goal and user or engineering outcome.
- Governing documents and exact roadmap milestone.
- Current behavior or measured baseline.
- Scope and explicit non-goals.
- Dependencies and affected interfaces.
- Observable acceptance criteria.
- Automated and manual test requirements.
- Accessibility requirements or a justified not-applicable statement.
- Security and privacy requirements or a justified not-applicable statement.
- Compatibility, migration, and recovery impact.
- Required documentation and decision-record updates.

Spike issues also define the fixture, reference environment, metrics, thresholds, failure scenarios, report format, and decision unlocked by the result.

## Lifecycle

1. **Proposed:** Capture the outcome, source documents, and open questions.
2. **Ready:** Resolve scope, dependencies, acceptance criteria, and validation requirements.
3. **In progress:** Assign an owner, link the branch or pull request, and record material discoveries.
4. **Review:** Attach test results, accessibility evidence, security/privacy review, documentation changes, and any decision record.
5. **Closed:** Verify every acceptance criterion or explicitly move remaining work to linked follow-up issues.

Reopen an issue when its acceptance criteria were not actually met. Create a new issue when newly discovered work has an independent outcome or release risk.

## Audit cadence

Audit the tracker at the start and end of each milestone and before every release candidate. During active implementation, perform a weekly reconciliation that checks:

- Every open issue maps to a current specification or accepted maintenance need.
- Dependencies and blockers match the roadmap and accepted decisions.
- Issue status matches linked pull requests and verified code.
- Acceptance criteria include tests, accessibility, security/privacy, compatibility, and documentation where applicable.
- Closed issues have evidence for their stated outcome.
- Newly accepted decisions have decision records and updated dependent issues.
- Obsolete, duplicate, or superseded issues are closed with links to their replacement.

Record audit findings as issue updates or new issues. Do not create a separate status spreadsheet or Markdown backlog.
