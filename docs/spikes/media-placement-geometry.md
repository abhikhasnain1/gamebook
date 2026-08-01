# MediaPlacement Geometry and Serialization Spike

> Status: Isolated Milestone 3 feasibility harness for issue #10. This is measured spike evidence, not a production media path or an accepted architecture decision.

## Scope

The harness proves the stable geometry boundary for a custom Fabric `MediaPlacement`: move, nonuniform scale, rotation, crop, selection, hit testing, media z-order below annotations, connector anchors, history, page switching, and static poster export. It does not implement playback, native exact-frame substitution, viewport zoom or pan, performance measurement, project-format version 2, or production UI.

The verified Gamebook 0.5.3 editor and version 1 project schema are not imported by or changed for the harness. The standalone entry is `tools/spikes/media-placement-geometry.html`; spike modules live under `src/spikes/` and are unreachable from the production entry point.

## Stable Boundary

`MediaPlacement.toObject()` emits only the placement version, opaque placement and evidence IDs, logical transforms, optional crop rectangle, optional poster timestamp, and media z-index. It deliberately omits image sources, filesystem paths, object URLs, DOM elements, video elements, frame bitmaps, media bytes, opaque runtime tokens, and Fabric runtime references.

The deterministic fixture reconstructs poster surfaces from an evidence ID only. Connector records retain the stable placement ID and named anchor. Page composition sorts media by z-index, then adds annotations and connectors above all media.

## Run

```powershell
npm.cmd run start
```

Open:

```text
http://127.0.0.1:1420/tools/spikes/media-placement-geometry.html?build=COMMIT_SHA
```

The footer reports the automated browser scenario result. The page exposes the complete JSON evidence in the hidden `#spike-report-json` element for deterministic collection. Numeric Outline controls provide keyboard alternatives for position, scale, rotation, z-order, poster timestamp, and crop.

Verify the report and verifier itself:

```powershell
npm.cmd run media-placement:verify -- --self-test
npm.cmd run media-placement:verify -- --report docs/spikes/media-placement-geometry-reference-report.json
```

## Acceptance Evidence

The browser scenario checks stable-record validation, exclusion of runtime state, Fabric custom-class reconstruction, hit testing, composition order, connector identity and anchor retention, undo/redo, page switching, static PNG export, and labeled numeric controls.

Vitest additionally exercises malformed geometry, forbidden runtime fields, deterministic composition order, history, page records, and axe coverage for the semantic Outline. Manual review covers pointer transforms, selection, keyboard numeric edits, undo/redo, page switching, 900 by 620 layout, focus visibility, High Contrast CSS, reduced-motion CSS, and visual placement/export fidelity.

Issue #11 owns offscreen playback and exact-frame substitution. Issue #12 owns complete viewport and keyboard pan behavior. Issue #13 owns 1080p60/1440p60 performance, transform-latency, memory, callback cleanup, and final rendering-architecture selection. No architecture decision record is accepted by this issue.

## Reference Result

The retained report in `media-placement-geometry-reference-report.json` was produced from exact implementation commit `c6c25c37603cd93b004c56b9705cf6a378e74919` on Windows using Chromium 150 at 1280 by 720. All ten checks passed. Fabric `loadFromJSON` reconstructed both placements, including the cropped record, and the harness recomposed the secondary page before returning to the primary page for export. The static export contained 111,730 data-URL characters, and the verified composition order was both media placements by z-index followed by the annotation and connector.

Keyboard numeric editing, undo/redo, placement selection, and page switching passed in the browser. At the supported 900 by 620 minimum viewport, the document remained exactly 900 by 620 with no page-level overflow; the 250-pixel Outline retained an internal vertical scroll area for its complete controls. Browser diagnostics contained no warnings or errors. Automated axe coverage reported no serious or critical violations for the semantic Outline.

NVDA and Windows High Contrast remain manual Milestone 3 reviewer checks. The harness includes semantic labels, pressed/current state, live status, visible focus, forced-colors rules, and reduced-motion rules for those checks; issue #13 owns the milestone-level rendering decision and consolidated reviewer evidence.
