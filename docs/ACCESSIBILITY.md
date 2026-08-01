# Gamebook Accessibility Specification

> Status: Required product specification for future work. Accessibility is part of every milestone and is not deferred to final release cleanup.

## Standard and audience

Gamebook targets WCAG 2.2 AA where the criteria apply to a Windows desktop application and follows established Windows keyboard, focus, High Contrast, and assistive-technology conventions.

The product must support researchers who use a keyboard, screen reader, magnification, high contrast, reduced motion, captions, or precise non-pointer controls. Visual canvas interaction must always have a semantic alternative.

## Definition of done for every feature

A feature is incomplete until it includes:

- Complete keyboard operation.
- Visible and correctly restored focus.
- Accessible names, roles, values, and states.
- Status and error announcements.
- High Contrast and non-color-only presentation.
- Reduced-motion behavior where animation or autoplay is involved.
- Automated accessibility coverage where technically meaningful.
- Keyboard-only and NVDA manual verification.

Accessibility defects block the same milestone that introduces the affected feature.

## Semantic Outline

The right-side Outline mirrors the visual project structure using ordinary semantic controls. It contains pages, media placements, annotations, notes, connectors, and timed findings in deterministic order.

Users can use the Outline to:

- Select, rename, reorder, show/hide, and delete eligible objects.
- Identify source type, placement state, annotation scope, and relationship targets.
- Move and resize objects through keyboard increments or numeric controls.
- Edit rotation, crop, poster timestamp, clip range, and timed annotation range.
- Navigate from derived evidence to its source recording and timestamp.

Outline selection and canvas selection remain synchronized without stealing focus unexpectedly. Canvas-only decorative objects never appear in the Outline.

## Keyboard interaction

Global and tool shortcuts are remappable, expose conflicts, and remain disabled while typing text.

- Arrow keys move a selected page object by one logical page pixel.
- Shift+Arrow moves it by ten pixels.
- Space+Arrow pans the viewport.
- Space+drag and middle-button drag provide pointer panning.
- Fit, zoom percentage, reset, and directional pan controls are keyboard accessible.
- Escape exits the current editing mode before minimizing the application.

All pointer drag operations have command or numeric alternatives. Reordering uses keyboard sensors and announces the resulting position.

## Focus and announcements

Dialogs trap focus and restore it to the invoking control. Opening the media timeline, Evidence Library, Frame Bin, or contextual formatting controls does not relocate focus unless the user invokes that surface.

Polite status announcements cover selection, page changes, zoom level, viewport position, save state, recording state, elapsed/remaining recording time, playback state, frame/time changes, import results, job progress, extraction completion, and successful export.

Errors that require action use an assertive announcement and move focus to a concise recovery surface. Repeated frame or timer updates are throttled so they do not overwhelm screen readers.

## Media accessibility

Media controls expose accessible play/pause, mute, volume, playback speed, loop start/end, current source time, duration, decoded sample index, previous/next frame, and poster-frame controls.

Autoplay occurs only when enabled and reduced motion is not requested. Immediate pause and mute controls remain available. User volume and autoplay preferences persist outside project files.

Before the first audio-enabled recording, an accessible disclosure explains that version 1 records the complete selected output-device mix and may include notifications, voice chat, and other applications. Microphone consent is separate and is never inferred from system-audio consent.

Researchers can attach captions and transcripts to evidence. Timed findings and annotations are navigable as a chronological semantic list, so timeline dragging is never required.

Extraction progress reports completed, total, failed, and estimated remaining frames without announcing every generated frame.

## Visual presentation

- Text and controls meet WCAG AA contrast requirements.
- Focus indicators remain visible in all themes and Windows High Contrast.
- Color is never the sole indicator of tag, annotation type, status, or selection.
- Annotation colors have user-facing names; patterns or labels are available where categories must remain distinguishable.
- The interface supports 200% UI scaling and remains operable at the existing 900 by 620 minimum window size.
- View zoom affects the page view only and never scales application chrome unpredictably.
- Tooltips appear on hover and focus but are not the only source of an accessible name.
- HDR blocking, color-conversion warnings, interrupted-recording recovery, Trash impact, and update-recovery states are available as text and announced without relying on color or animation.

## Accessible export

Offline HTML/ZIP is the canonical accessible report. It includes:

- Logical headings, landmarks, page navigation, and evidence lists.
- Keyboard-operable media controls.
- Alt text, captions, transcripts, source metadata, timecodes, and provenance.
- A semantic representation of page annotations and timed findings outside the visual composition.
- Visible focus, reduced motion, sufficient contrast, and no network dependency.

Static PDF contains selectable titles, timecodes, note text, and provenance where supported, but Gamebook does not claim PDF/UA conformance until a dedicated tagged-PDF implementation is independently validated.

## Validation matrix

Every applicable milestone runs:

- Automated axe checks with no serious or critical violations.
- React component accessibility tests for names, state, focus, and keyboard actions.
- Keyboard-only completion of the milestone's primary workflow.
- NVDA verification on current supported Windows.
- Accessibility Insights inspection.
- Windows High Contrast and reduced-motion checks.
- 100%, 150%, and 200% UI scale checks at supported window sizes.

Release QA additionally verifies recording, frame stepping, extraction, search, structured findings, save/recovery, and HTML export without pointer input.

The Settings and Storage surfaces expose keyboard-operable import/export/reset, cache cleanup, recording recovery, Project Trash, diagnostic consent, and shortcut conflict resolution.

## Milestone Evidence Matrix

Each implementation issue records the applicable row evidence in its issue or pull request before milestone closure. A serious or critical axe violation, keyboard trap, missing accessible name for an interactive control, lost focus after a modal or native-dialog flow, High Contrast-only information loss, reduced-motion violation, or blocking NVDA barrier prevents closure unless a linked follow-up is explicitly accepted as outside the milestone scope.

| Roadmap milestone | Automated evidence | Keyboard-only evidence | NVDA evidence | High Contrast and reduced-motion evidence | Scale evidence | Reviewer |
| --- | --- | --- | --- | --- | --- | --- |
| M1 Test foundation | Vitest accessibility helpers, fixture contracts, and screenshot-regression tests pass. | Current screenshot workflow can capture from shortcut, select tools, move between page controls, save, and export without pointer-only blockers. | Tool rail, page controls, save/export status, dialogs, and error messages expose names, states, and concise announcements. | Current controls, focus rings, selected states, and fixture descriptions remain visible without color-only meaning; no animation requires reduced-motion override. | 100%, 150%, and 200% UI scale preserve the 900 by 620 minimum workflow without clipped controls. | Issue implementer records automated evidence; reviewer spot-checks manual evidence. |
| M2 Native media feasibility spike | Native harness records timing, audio, HDR, interruption, and failure results with no serious/critical accessibility defects in spike controls. | Recording start/stop, cancellation, disclosure acknowledgement, recovery, and failure review are operable from the keyboard. | Whole-system-audio disclosure, recording state, elapsed/remaining time, cancellation, and recovery outcomes are announced. | HUD or fallback notification communicates video, system-audio, and microphone state by text and shape, not color or motion alone. | Disclosure, HUD fallback, and recovery surfaces fit at supported scales. | Spike owner records environment and results; accessibility reviewer validates disclosure and recovery flows. |
| M3 MediaPlacement and viewport feasibility spike | Component and harness tests cover placement names, selected state, timeline controls, zoom/pan controls, and cleanup. | Play/pause, seek, previous/next frame, Fit, 25-200% zoom, reset, pan, move, resize, crop, poster timestamp, and page switch are keyboard-operable. | Placement role, source name, playback state, current time, decoded sample index, zoom, selection, and errors are exposed without canvas interpretation. | Autoplay obeys reduced motion; placement state, focus, anchors, and connectors remain distinguishable in High Contrast. | Zoom/pan controls and timeline remain usable at 100%, 150%, and 200% with the 900 by 620 minimum. | Spike owner records harness metrics; accessibility reviewer verifies semantic alternatives. |
| M4 ZIP64 feasibility spike | Archive validation and recovery tests include accessible error/status surfaces and fixture names/descriptions. | Open, materialize, save, cancel, recover, stale-lock review, external-change choice, and cache cleanup are keyboard-operable. | Progress, errors, lock/recovery choices, cache sizes, and safe cleanup outcomes are announced. | Failure, warning, and destructive actions use text and focus management, not color-only status. | Long archive paths, storage estimates, and recovery surfaces fit at supported scales without exposing private paths unnecessarily. | Storage owner records recovery evidence; accessibility reviewer verifies error and recovery flows. |
| M5 Architecture freeze | Adopted contracts identify automated accessibility tests and manual evidence required by dependent issues. | Frozen interfaces preserve keyboard alternatives for placement, library, settings, Trash, and export actions. | Contracts define semantic records and announcements for evidence, findings, jobs, errors, and recovery. | Decisions document High Contrast, reduced-motion, and non-color-only consequences. | Decisions document supported scale behavior and minimum-window constraints. | Architecture reviewer confirms every accepted ADR has accessibility impact and validation sections. |
| M6 Version 2 screenshot compatibility | Migration, render-diff, project transaction, Trash, settings, and archive tests include accessibility assertions where UI exists. | Open, migrate, inspect repair report, edit, save, restore Trash, and export current screenshot projects without pointer-only blockers. | Migration reports, repair summaries, save/recovery state, Trash impact, and export results are announced. | Repair, Trash, and validation warnings remain textual and High Contrast safe; no motion-only progress. | Migration and repair surfaces remain usable at supported scales. | Compatibility owner records automated and manual migration evidence; accessibility reviewer verifies repair/Trash flows. |
| M7 Recording vertical slice | Recording controls, disclosures, state events, and export tests include axe and component coverage. | Hotkey to record, stop, autoplay/pause, annotate, save, reopen, and export is keyboard-operable. | Recording, finalization, poster creation, warnings, playback, save, reopen, and export states are announced. | Autoplay honors reduced motion; HUD/fallback states and audio/microphone indicators are not color-only. | Recording settings, HUD fallback, timeline, and export summary fit supported scales. | Feature owner records end-to-end evidence; accessibility reviewer verifies recording and playback. |
| M8 Video editing and exact frames | Tests cover frame controls, trim/split state, timed annotation scopes, source protection, and materialization errors. | Previous/next frame, timecode entry, loop, trim, split, timed annotation range, source protection, and materialization are keyboard-operable. | Current source time, sample index, selected range, clip boundaries, protected-source warnings, and operation results are announced. | Timed visibility, range selection, and destructive warnings use text and persistent focus; motion can be reduced. | Timeline and editing controls fit supported scales with precise numeric alternatives. | Video-editing owner records exact-frame evidence; accessibility reviewer verifies timeline alternatives. |
| M9 Evidence Library and Frame Bin | Virtualization, extraction-job, selection, cancellation, and storage-management tests include semantics and axe coverage. | Browse, search/filter, select ranges, drag alternatives, extract, cancel, batch action, and storage cleanup are keyboard-operable. | Counts, selected items, progress, failures, estimates, provenance links, and cancellation results are announced at a throttled cadence. | Status, tag/category, progress, and selection do not rely on color; reduced motion avoids unnecessary thumbnail animation. | 5,000-record browsing and visible thumbnail grids remain usable at supported scales. | Library owner records performance and accessibility evidence; accessibility reviewer verifies virtualized list behavior. |
| M10 Research workflow | Tests cover finding form fields, tags, collections, relationships, timeline, search, backlinks, and Review mode semantics. | Observation, Evidence, Interpretation, Hypothesis, Follow-up, tags, relationships, filters, and Review mode are keyboard-operable. | Finding stages, relationship targets, search results, filters, timeline position, and navigation outcomes are announced. | Tags and statuses have labels/patterns beyond color; reduced motion avoids disruptive timeline transitions. | Search, filters, forms, and Review mode remain usable at supported scales. | Research owner records workflow evidence; accessibility reviewer verifies semantic research navigation. |
| M11 Export and sharing | HTML export has no serious/critical axe violations; PDF/Markdown/JSON/CSV tests verify semantic content and privacy controls. | Offline HTML report, media controls, page navigation, evidence lists, and privacy/export options are keyboard-operable. | HTML headings, landmarks, media state, evidence provenance, captions/transcripts, and export summaries are exposed. | Exported HTML has visible focus, sufficient contrast, reduced motion, and no color-only evidence status. | Export preview/options and generated HTML remain usable at supported scales and browser zoom. | Export owner records browser evidence; accessibility reviewer verifies HTML report semantics. |
| M12 Publication | Release checklist includes automated tests, installer/update recovery checks, diagnostics redaction, and accessibility evidence. | Install, first launch, update prompt, rollback, settings/storage, diagnostic export, upgrade/uninstall, and sample projects are keyboard-operable. | Installer/update states where available, first-launch health, settings, storage, diagnostics, and recovery outcomes are announced or documented. | Installer/update/recovery status is textual and High Contrast safe; animations obey reduced-motion settings. | Installer, app shell, settings, storage, docs, and sample projects are checked at supported UI scale. | Release owner compiles evidence; accessibility reviewer signs off before publication. |
