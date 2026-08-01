# Contributing to Gamebook

Gamebook is a local-first Windows gameplay research and annotation application. Contributions must preserve the current screenshot workflow while following the dependency gates for planned media work.

## Start with context

Read [the documentation index](docs/INDEX.md), [the roadmap](docs/ROADMAP.md), and every specification relevant to the change. Confirm whether the behavior is current, required, proposed, or governed by an accepted decision record.

For product work, start from a GitHub issue that satisfies [the issue tracking policy](docs/ISSUE-TRACKING.md). Discuss substantial scope or architecture changes before implementation.

## Make a focused change

- Use one issue and one reviewable branch per independently testable outcome.
- Preserve version 1 project compatibility unless an accepted specification and migration plan say otherwise.
- Keep feasibility spike code isolated until a decision record adopts its result.
- Follow existing Rust, React, Fabric, and Tauri ownership boundaries.
- Avoid unrelated refactors and generated-file churn.
- Update documentation and decision records in the same change as the behavior they describe.

Do not commit credentials, personal paths, editor state, local automation, transcripts, diagnostic captures, unreleased game media, or other workstation-only material.

## Definition of done

A change is ready for review when it includes:

- Observable acceptance criteria linked to the governing issue.
- Automated tests appropriate to its behavior and risk.
- Manual QA for affected current workflows.
- Applicable keyboard, focus, semantic, announcement, contrast, reduced-motion, scaling, High Contrast, and NVDA validation.
- Applicable security, privacy, recovery, compatibility, migration, and export validation.
- Updated user, architecture, QA, specification, and decision documentation.
- Exact validation commands and results in the pull request.

Accessibility and security/privacy defects block the milestone that introduces them.

## Local validation

Run the checks that apply to the change. The current baseline commands are:

```powershell
npm.cmd run check
npm.cmd run frontend:build
cargo check --manifest-path src-tauri/Cargo.toml
```

Run `npm.cmd run build` when validating the complete Windows application or installer. Follow [the release QA checklist](docs/QA.md) for affected workflows.

## Commits and pull requests

Write concise, imperative commit subjects that describe the project change. Link the primary issue in the pull request, explain scope and non-goals, and report failures or untested scenarios directly.

Complete the pull request checklist. A reviewer should be able to trace every changed requirement to code, tests, documentation, and validation evidence.
