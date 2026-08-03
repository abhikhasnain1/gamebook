# MediaPlacement and viewport architecture freeze

## Scope

Issue #19 accepts [ADR-0001](../decisions/0001-media-placement-rendering.md) from the measured Issues #10-#13 geometry, playback, viewport, performance, and accessibility evidence. It changes no production command, user interface, project schema, screenshot behavior, or version 1 project.

The machine-checked [contract report](placement-viewport-freeze-reference-report.json) binds the exact source revisions, report schemas, checks, thresholds, selected approach, manual accessibility closeout, field-family authority, and planned production conformance.

```powershell
npm.cmd run placement-viewport-contract:verify -- --self-test
npm.cmd run placement-viewport-contract:verify -- --reference docs/spikes/placement-viewport-freeze-reference-report.json
```

## Stable placement and runtime ownership

`MediaPlacement` persists only its type discriminator, placement schema version, opaque placement/evidence IDs, finite logical position, positive nonuniform scale, normalized angle, optional positive crop, optional nonnegative integer poster time in source microseconds, and integer media z-index. Geometry, crop, layer, and poster-setting edits participate in project history. Paths, runtime URLs, tokens, DOM/video elements, callbacks, decoded frames, bitmaps, media bytes, and viewport state never enter the placement record.

The runtime controller owns the hidden video, video-frame callback, one full-resolution offscreen surface, scoped token, decoded-frame reference, current playback mode, source time, and errors. Normal browser playback, native exact PNG substitution, and the poster share that surface and unchanged Fabric geometry. Exact mode uses the ADR-0004 decoded sample index plus 100-nanosecond source PTS; the microsecond value is derived for user-facing controls and ranges.

Only one placement plays at once. Pause, page switch, export, minimize, deletion, disposal, source/token failure, and exact-frame failure cancel callbacks, release sources and decoded frames, clear runtime references, remove video elements, and restore the poster where the placement remains. Callback generations prevent late work from drawing into a suspended or replaced placement.

## Composition and export

Media sorts by z-index and stable ID below annotations and connectors. Timed annotations use inclusive source-video ranges and render above their target. Connectors bind stable placement IDs and named anchors; neither playback frames nor view transforms change their logical coordinates.

Static export suspends playback, resolves each video placement at its configured poster identity, and renders the unchanged 1600 by 900 logical page. Export and thumbnail output exclude viewport and runtime state. The Issue #12 reference retained identical export and thumbnail hashes through all fourteen viewport paths.

## View-only viewport

Fit is the default and centers the 1600 by 900 page with at most a 24-screen-pixel inset. Zoom accepts finite values from 25 through 200 percent and preserves the scene center. Reset selects centered 100 percent. Dedicated controls and Space+Arrow pan by 24 screen pixels; Space+primary drag and middle-button drag pan with the pointer. Arrow and Shift+Arrow remain one- and ten-logical-pixel object edits. At least 80 screen pixels of a page edge remain reachable.

Mode, zoom, viewport transform, and scene center are ephemeral. They create no Save or history change and do not affect placement geometry, connector calculations, thumbnails, or static export pixels. Invalid finite/bounds inputs preserve the prior view.

## Selected rendering approach

Two Fabric runs passed at 59.49-59.63 rendered FPS, 6.3-6.5 ms p95 transform latency, zero dropped callbacks, zero retained runtime objects, and 21.8-22.7 MB private-memory deltas after ten loops. The layered-DOM fallback also passed at 59.53-59.88 FPS, 6.2 ms p95, zero retained runtime objects, and a 4.5 MB delta.

Fabric is accepted because both of its runs pass while retaining one composition system for placement, annotations, connectors, selection, viewport transforms, and export preparation. Layered DOM remains the measured fallback if representative supported hardware misses the 55 FPS, 50 ms p95, 100 MB return, zero-leak, or exact-composition gates.

## Accessibility, security, and compatibility

The semantic Outline mirrors canvas selection without stealing focus and provides labeled numeric position, scale, rotation, crop, layer, and poster controls. Named keyboard controls cover playback, exact frames, posters, Fit, zoom, reset, and pan. Selection, time, sample, zoom, center, progress, completion, and actionable errors are available as throttled text outside the canvas.

The complete 900 by 620 matrix passed at 100, 150, and 200 percent scale, reduced motion, and forced colors. Accessibility Insights found no page-specific blocker, and NVDA 2026.1.1 passed spoken names, roles, states, values, progress, completion, and errors across all four exact harnesses. Autoplay remains disabled when reduced motion is requested.

The frontend receives no paths or unrestricted filesystem access. Stable records and diagnostics exclude runtime references, tokens, media, and viewport state. Missing, expired, or wrong-operation tokens fail generically and preserve a safe poster. Gamebook 0.5.3 screenshot behavior and version 1 parse, Save, recovery, and export behavior remain unchanged. Issue #20 must embed this stable placement boundary without serializing its runtime or viewport state.
