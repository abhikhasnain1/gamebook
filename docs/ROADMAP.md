# Gamebook Media Research Roadmap

> Status: Dependency-ordered implementation roadmap. Only the documentation milestone is approved by the creation of this file; product implementation requires a separate reviewed task for each milestone.

## Program rules

- Preserve the verified Gamebook 0.5.3 baseline throughout the program.
- Use one reviewable branch and commit series per milestone.
- Do not finalize the version 2 schema before all three feasibility spikes are reviewed.
- Do not merge disposable spike code into production paths unless the architecture review explicitly adopts it.
- Accessibility, diagnostics, tests, and QA updates ship with each feature rather than at the end.
- Every milestone leaves the application runnable and existing screenshot behavior passing.

## Milestone 0: Baseline and documentation

1. Verify the untouched frontend production build and Rust tests.
2. Create the root baseline commit before adding planning documents.
3. Add the approved product, video/evidence, project-format, accessibility, and roadmap documents in a separate documentation commit.
4. Record current limitations: no frontend test harness, direct destination overwrite, base64 screenshot storage, screenshot-specific page composition, and no remote repository.

Exit: clean Git history contains an untouched baseline followed by documentation only.

## Milestone 1: Test foundation

Add frontend unit and component testing, accessibility checks, synthetic numbered-frame fixtures, deterministic version 1 migration fixtures, and native integration-test scaffolding. Extend release QA without changing product behavior.

Exit: existing screenshot workflows have automated coverage sufficient to detect schema, rendering, keyboard, and export regressions.

## Milestone 2: Native media feasibility spike

Build an isolated harness for Windows capture, Media Foundation H.264/AAC, WASAPI loopback, frame timelines, exact decoding, HUD exclusion, and failure handling.

Required results:

- 1080p60 and 1440p60 capture on the documented reference system.
- Capability-reported 4K60 or an explicit fallback result.
- Thirty-second video duration within one encoded frame and audio duration within one audio buffer; finalization measured separately and completed within five seconds on reference hardware.
- No more than 50 ms A/V drift after 30 seconds.
- Exact numbered-frame stepping and extraction for 30 FPS and 60 FPS fixtures.
- Correct variable-frame-rate sample order and presentation timestamps.
- No referenced partial evidence after cancellation or failure.

Exit: approve `windows-capture` or document the direct-Windows-API fallback without changing the public interfaces.

## Milestone 3: `MediaPlacement` and viewport feasibility spike

Build an isolated Fabric harness proving media geometry, offscreen playback, native exact-frame substitution, connectors, z-order, history, cleanup, Fit, 25-200% zoom, and pan.

Required results on the documented reference system:

- At least 55 rendered FPS for representative 60 FPS 1080p and 1440p sources.
- Pointer-to-transform latency below 50 ms at the 95th percentile.
- Process memory returns within 100 MB of its pre-loop level after ten playback loops and cleanup.
- Page switching, pause, exact-frame mode, and disposal leave no active callbacks or stale media.
- View transforms never modify persisted page state or static export pixels.

Exit: adopt the Fabric offscreen-surface design or evaluate and document a layered DOM video fallback before schema freeze.

## Milestone 4: ZIP64 feasibility spike

Build an isolated archive harness for lazy record reads, on-demand asset materialization, SHA-256 verification, workspace locks, raw entry copy, streamed replacement, recovery, and cache eviction.

Required results:

- Open 5 GB project metadata with less than 256 MB additional memory and no media extraction.
- Materialize only selected assets.
- Save a 5 GB project with less than 512 MB additional memory and no extra complete temporary copy beyond the replacement archive.
- Preserve the prior project through cancellation, low disk space, forced termination, checksum failure, and simulated write failure.
- Pass local NTFS and OneDrive-managed replacement scenarios.
- Pass stale-lock, external-file-change, copied-project, recovery, and clean-cache eviction scenarios.

Exit: approve ZIP64 or compare it with the documented SQLite-container fallback before further schema work.

## Milestone 5: Architecture freeze

Update the proposed interfaces and format from measured spike results. Freeze evidence, asset, page, placement, timing, workspace, and migration contracts. Add architecture decision records for the selected capture, rendering, and storage approaches.

Exit: the implementation schema has no unresolved media transport, timing, rendering, save, migration, or accessibility decisions.

## Milestone 6: Version 2 screenshot compatibility

Implement assets, pages, placements, atomic workspaces, archive persistence, version 1 migration, and repair reporting using screenshots only. Preserve screenshot capture and all current editing/export behavior.

Exit: version 1 fixtures migrate deterministically; source images are byte-identical; normalized annotations and transforms are equivalent; 1600 by 900 renders keep fewer than 0.1% of pixels above a per-channel difference of 8; repeated save/reopen introduces no semantic changes.

## Milestone 7: Recording vertical slice

Implement settings, shortcut, recording HUD, capture state, audio, finalization, poster creation, autoplay preference, primary placement, save/reopen, and basic multimedia export.

Exit: hotkey -> record -> autoplay -> annotate -> save -> reopen -> export passes automated, keyboard-only, NVDA, lifecycle, and failure QA.

## Milestone 8: Video editing and exact frames

Implement normal playback, native previous/next frame, source timecode, looping, non-destructive trim/split, timed annotations, source protection, frame capture, and clip materialization.

Exit: frame and clip operations remain exact across split, page duplication, save/reopen, export, source protection, and materialization.

## Milestone 9: Evidence Library and Frame Bin

Implement guaranteed PNG/JPEG and H.264/AAC MP4 import, virtualized evidence browsing, extraction jobs, estimates, sampling, cancellation, provenance navigation, grids, contact sheets, batch actions, and storage management.

Exit: 5,000 frame records and 500 visible thumbnails remain responsive; cancellation cleans partial outputs; low-space safeguards prevent project damage.

## Milestone 10: Research workflow

Implement sessions, capture metadata, structured findings, controlled tags, collections, markers, search, filters, backlinks, chronological timeline, and Review mode.

Exit: a finding can navigate through Observation -> Evidence -> Interpretation -> Hypothesis -> Follow-up and export every referenced source accurately.

## Milestone 11: Export and sharing

Implement the offline HTML/ZIP report, static PDF evidence sheets, enhanced Markdown, JSON, and CSV.

HTML acceptance:

- No network requests.
- Opens after extraction in current Edge, Chrome, and Firefox.
- Reconstructs placement geometry, crop, rotation, z-order, page annotations, and timed visibility.
- Plays and seeks included media and clip ranges.
- Provides equivalent semantic evidence content.
- Has no serious or critical axe violations.

PDF acceptance:

- Each page begins with its poster-based composition.
- Timed findings generate evidence sheets sorted by page order, source order, and timestamp.
- Timestamps within half a source-frame interval share one evidence sheet.
- Every sheet contains the decoded frame, active annotations, source name, timecode, note text, and provenance.
- PDF never claims embedded video playback.

## Milestone 12: Publication

Complete long-session reliability, accessibility, diagnostics, privacy controls, signed NSIS/MSI installers, update metadata, user documentation, sample projects, upgrade/uninstall testing, and direct-download release procedures.

External prerequisites are publisher identity, code-signing certificate, public release/update host, license selection, and trademark clearance.

## Post-version 1

After version 1 stability, consider synchronized comparisons, onion skinning, pixel differences, measurements, motion/cadence analysis, input and telemetry tracks, local OCR/transcription, opt-in cloud processors, macOS capture, and collaboration.

These features must reuse the frozen evidence and processor boundaries rather than force another project-format redesign.
