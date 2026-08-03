# ADR-0001: Media placement rendering and viewport

- Status: Accepted
- Date: 2026-08-03
- Governing issue: #19
- Roadmap milestone: Milestone 5
- Supersedes: None
- Superseded by: None

## Context

Gamebook needs normal video playback, exact-frame substitution, poster frames, Fabric selection and transforms, timed annotations, connectors, page switching, static export, and view-only zoom and pan without putting runtime media or viewport state into a project. Issues #10 through #12 established stable placement geometry, one offscreen surface for playback and exact frames, deterministic lifecycle cleanup, a semantic Outline, and non-destructive viewport transforms. Issue #13 compared the preferred Fabric offscreen surface with a layered DOM fallback and completed the consolidated performance and accessibility gates.

The retained [freeze report](../spikes/placement-viewport-freeze-reference-report.json) binds this decision to the exact geometry, playback, viewport, performance, and manual accessibility revisions. The native source-time and exact-frame identity contract remains governed by [ADR-0004](0004-source-timing-and-exact-decode.md).

## Decision drivers

- Sustain at least 55 rendered FPS and keep p95 transform latency below 50 ms for representative 1080p60 and 1440p60 sources.
- Release callbacks, sources, decoded frames, and video elements after lifecycle stress and return process private memory within 100 MB of baseline.
- Keep playback, posters, exact frames, timed annotations, connectors, hit testing, z-order, selection, and static rendering in one composition system.
- Keep runtime URLs, media elements, decoded frames, filesystem paths, media tokens, and viewport transforms out of serialized projects.
- Preserve pointer and keyboard geometry edits while providing an equivalent semantic Outline and non-destructive view controls.
- Preserve Gamebook 0.5.3 screenshot behavior and version 1 project compatibility.

## Options considered

### Fabric offscreen surface

A hidden video element supplies frames to a full-resolution drawing surface through the browser video-frame callback. `MediaPlacement` uses that surface as its Fabric image source. Two decision runs passed at 59.49-59.63 rendered FPS, 6.3-6.5 ms p95 transform latency, zero runtime leaks, and private-memory deltas of 22,667,264 and 21,848,064 bytes.

This keeps playback composition in the same Fabric scene as placement geometry, annotations, connectors, hit testing, viewport transforms, and static rendering. Its cost is a full-resolution drawing surface per active placement and one browser-to-canvas copy for each presented frame.

### Layered DOM video

A visible DOM video element is synchronized with a transparent Fabric `MediaPlacement`; Fabric annotations render above it. The fallback run passed at 59.53-59.88 rendered FPS, 6.2 ms p95 transform latency, zero runtime leaks, and a 4,481,024-byte private-memory delta.

This uses less measured private memory but introduces a second composition system. Production would have to synchronize placement, crop, rotation, z-order, viewport transforms, visibility, exact-frame substitution, export, and cleanup across DOM and Fabric boundaries.

## Decision

Use the Fabric offscreen-surface approach. A serialized `MediaPlacement` owns its `MediaPlacement` type discriminator, placement schema version, stable placement and evidence IDs, finite logical position, positive nonzero scale, normalized angle, optional crop, optional poster timestamp in source microseconds, and integer media z-index. The containing version 2 record is frozen by Issue #20, but it may not add runtime state to this placement boundary.

The runtime controller owns the hidden video element, browser video-frame callback, drawing surface, scoped media token, decoded-frame reference, playback mode, source time, current sample, and errors. Each presented frame is drawn once and requests one Fabric render. Exact decoded PNGs and posters use the same surface and geometry. Exact mode requires the ADR-0004 sample index plus 100-nanosecond source PTS identity; a mismatch restores the prior usable poster and reports an error. Only one placement plays at a time.

Media placements sort by z-index and stable ID beneath annotations and connectors. Timed annotations render above their target only within their inclusive source-time range. Connectors bind the stable placement ID and named anchor and do not depend on the current frame or viewport. Static export suspends playback, decodes each placement at its configured poster identity, composes the unchanged 1600 by 900 logical page, and excludes runtime and viewport state.

View mode, zoom, six-value Fabric viewport transform, and logical scene center are ephemeral window state. Fit is the default and centers the 1600 by 900 page with a bounded inset. Zoom accepts finite values from 25 through 200 percent while preserving the scene center; Reset selects centered 100 percent. Dedicated controls and Space+Arrow pan by 24 screen pixels, Space+primary drag and middle-button drag pan with the pointer, and at least 80 screen pixels of a page edge remain reachable. Arrow moves a selected object by one logical pixel, Shift+Arrow by ten, and Space+Arrow never edits the object.

Viewport changes create no project mutation or history entry and cannot alter logical geometry, connector coordinates, thumbnails, or static export pixels. Non-finite zoom, pan, or viewport dimensions fail without changing the prior view. Layered DOM video remains the measured fallback if a production implementation misses a frozen gate on representative supported hardware or cannot preserve exact composition. This decision does not implement production media UI or authorize recording or schema work outside the roadmap.

## Consequences

Fabric remains the single visual composition system for playback, placement, annotations, connectors, transforms, page switching, and export preparation. Runtime ownership and cleanup stay behind the placement playback controller. Full-resolution surfaces require explicit lifecycle disposal and repeat memory validation on supported hardware.

Pause, page switch, export, minimize, placement deletion, disposal, exact-frame failure, token failure, and source failure cancel callbacks, pause and release sources, clear runtime references, release decoded frames, and restore a poster where the placement remains. Late callback generations cannot redraw a suspended or replaced placement.

Geometry, crop, z-order, and poster-setting edits participate in project history. Playback time, exact mode, autoplay state, active callback state, and viewport state do not. Page switching disposes inactive runtime state while preserving stable placement records.

## Compatibility and migration

This decision changes no production code or stored project. Version 1 projects continue to parse, save, recover, and export exactly as Gamebook 0.5.3 does. Future version 2 projects store only stable placement records and evidence identifiers; they never store a drawing surface, video element, object URL, media token, decoded frame, callback, filesystem path, or viewport transform.

Layered DOM fallback does not require a schema migration because rendering state remains outside the stable placement record. Unsupported, malformed, cancelled, or failed runtime inputs preserve the prior placement and last saved project.

## Accessibility

Canvas rendering does not replace semantic controls. The Outline is the semantic peer of canvas selection and exposes placement name, selected state, layer, position, scale, rotation, crop, and poster time through labeled keyboard-operable controls. Canvas and Outline selection remain synchronized without stealing focus. Playback, seek, previous/next exact frame, poster restore, Fit, 25-200 percent zoom, reset, directional pan, and status/error review have named controls, visible and restored focus, and concise announcements. Repeated playback and viewport updates are throttled.

Autoplay is suppressed when reduced motion is requested. State, selection, warnings, and errors do not rely on canvas pixels, motion, color, or sound. The 900 by 620 matrix passed at 100, 150, and 200 percent UI scale, including reduced-motion and forced-colors checks. NVDA 2026.1.1 and Accessibility Insights on the reference Windows system exposed landmarks, selected states, numeric values, playback and frame controls, zoom and center state, progress, completion, and actionable errors across all four exact Milestone 3 harnesses with visible focus and no keyboard trap.

## Security and privacy

Native code owns file access and issues media tokens under the ADR-0003 through ADR-0007 native boundary. The webview receives no filesystem paths or unrestricted file access. Stable records and diagnostics exclude runtime URLs, media tokens, video elements, callbacks, frame bitmaps, decoded-frame references, media bytes, and source titles. Missing, expired, or wrong-operation tokens fail generically and restore a safe poster state.

Disposal revokes runtime references and leaves no project mutation. The spike uses synthetic local fixtures, loopback-only requests, no project writes, and an isolated temporary browser profile. Production import, media serving, diagnostics, and archive validation remain subject to `docs/SECURITY-PRIVACY.md`.

## Validation

- Issue #10 revision `c6c25c37603cd93b004c56b9705cf6a378e74919`: ten geometry, serialization, composition, connector, history, page-switch, export, and semantic Outline checks.
- Issue #11 revision `5f2c32fb7d56baf56ceb975ec51c74ee2cf84aa1`: eleven playback, exact-frame, timed-annotation, token-failure, and cleanup checks with zero callbacks and sources after six lifecycle boundaries.
- Issue #12 revision `42a574a4599820f34c34a38dae1cf57a5665f0e7`: eleven checks and fourteen viewport paths with identical 43,601-byte export and 2,577-byte thumbnail hashes.
- Issue #13 revision `4f63b5e00d793c4d90e212f6f9aa1e7bde05264c`: two passing Fabric runs and one passing layered-DOM run using identical 1,800-frame fixtures; all FPS, latency, memory, visual, and ten-loop cleanup gates passed.
- Manual closeout revision `274a53ea94c5b79631f5b8cf0454b9aa5938a6b7`: keyboard-only, NVDA 2026.1.1, Accessibility Insights, High Contrast, reduced motion, and scale review on Windows 11 Pro 10.0.26200 and Edge 150.0.4078.105.

Revisit the selected approach if representative supported hardware falls below 55 rendered FPS, reaches 50 ms p95 transform latency, retains more than 100 MB after cleanup, leaks runtime state, or cannot preserve exact frame, annotation, connector, viewport, and static-export composition.

## Documentation impact

This record is reflected in `docs/VIDEO-EVIDENCE-ARCHITECTURE.md`, `docs/spikes/placement-viewport-freeze.md`, the placement/viewport freeze report, `docs/spikes/media-rendering-performance.md`, `docs/QA.md`, and the downstream version 2 schema and media implementation issues.
