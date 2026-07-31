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
