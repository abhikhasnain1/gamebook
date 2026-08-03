# Release QA Checklist

## Build gates

- `npm.cmd run check`
- `npm.cmd run frontend:test`
- `npm.cmd run fixtures:verify`
- `npm.cmd run frontend:build`
- `cargo check --manifest-path src-tauri/Cargo.toml`
- `cargo clippy --manifest-path src-tauri/Cargo.toml --lib -- -D warnings`
- `cargo test --manifest-path src-tauri/Cargo.toml --lib`
- `npm.cmd run build`

## Frontend automated tests

- `npm.cmd run frontend:test` runs Vitest in jsdom with React Testing Library.
- Component tests must render through deterministic browser and native-command boundaries; mock native commands rather than invoking Tauri.
- Serious and critical axe-core accessibility violations fail the test run.
- Baseline component coverage must include accessible names, roles, state, focus, and keyboard operation where applicable.

## Screenshot regression baseline

- Frontend regression tests cover version 1 session parsing, legacy page default backfills, capture-page metadata, unsupported-format rejection, text export order, and fixture manifest contracts.
- Regression fixtures must preserve page order, source pixel references, screenshot transforms, annotation IDs, extracted text, textual descriptions, and expected malformed-input failures.
- Current manual coverage remains required for native screenshot capture, save/recovery dialogs, PNG/PDF/Markdown render output, keyboard-only editing, NVDA, display scale, and high-contrast checks until those paths have dedicated automation.

## Accessibility Evidence

For every issue, record accessibility evidence in the owning GitHub issue or pull request using this format:

- Roadmap milestone and workflow under test.
- Automated commands and results, including axe or component accessibility coverage when applicable.
- Keyboard-only path, expected focus order, and result.
- NVDA version, Windows version, speech output summary, and result when assistive-technology validation applies.
- High Contrast theme, reduced-motion setting, UI scale, minimum-window size, and result.
- Reviewer responsible for manual accessibility evidence.
- Blockers, linked follow-up issues, or explicit not-applicable rationale.

Unmet accessibility criteria block milestone closure when they affect the milestone workflow. A follow-up issue may defer only independent work that is outside the milestone scope and does not leave the shipped workflow with a serious or critical barrier.

Current manual coverage for the screenshot workflow remains required for native display capture, parented file dialogs, rendered PNG/PDF/Markdown inspection, keyboard-only end-to-end editing, NVDA, Accessibility Insights, High Contrast, reduced motion, and 100/150/200 percent Windows UI scale. Automated coverage supplements but does not replace those checks.

Frontend tests cover axe/component checks for the tool rail, Outline, viewport, migration/repair/conflict/storage dialogs, capture claim flow, production project orchestration, placement serialization, version 1 compatibility, fixture contracts, render differences, and text export order.

## Version 2 persistence foundation

- Rust library tests cover lazy active-page open, on-demand record reads, schema and cross-record validation, relative-path and duplicate rejection, immutable asset CRC/SHA-256 visibility, scoped range responses, token invalidation, source-keyed workspace reuse, copied-project separation, live/fresh/stale/malformed locks, corrupt-state recovery, registry traversal rejection, autosave journals, cancellation cleanup, external-change choices, Save As preservation, streamed replacement, visible reopen, cache eviction, and operation cleanup after failures.
- Frontend command-contract tests verify that version 2 Open and Save accept no renderer-supplied path, materialization returns only a scoped token and metadata, media URLs reject non-token input, and the production editor stages no path, token, runtime URL, or base64 asset.
- A release WebView check must load a materialized screenshot through the Windows `gamebook-media` protocol mapping and complete PNG export from that canvas. A blank placement, failed thumbnail, protocol error, or tainted-canvas export failure blocks the persistence change.
- Run `cargo test --manifest-path src-tauri/Cargo.toml --lib`, `cargo clippy --manifest-path src-tauri/Cargo.toml --lib -- -D warnings`, `npm.cmd run frontend:test`, and `npm.cmd run frontend:build` for every persistence change.
- Production persistence changes rerun the 5 GiB archive, OneDrive-managed replacement, forced-interruption, low-space, accessibility, and current screenshot/version 1 matrices.

## Version 1 migration and repair foundation

- Rust tests cover Gzip and plain JSON content detection, deterministic IDs and records, byte-identical screenshot assets, page order and active-page mapping, annotation IDs/order/text/transforms, schema-valid ordered reports, read-only valid/missing/future/malformed repair outcomes, cancellation, source preservation, failed-save cleanup, collision-safe first-replacement backup, materialization, and stable repeated version 2 Save.
- Frontend command-contract and component tests verify that migration accepts only an operation ID, repair accepts no renderer-supplied data, reports expose stable textual code/severity/status without paths or base64 media, Save reports whether the version 1 backup was created, and every report/conflict/storage dialog is keyboard operable with trapped and restored focus.
- Production migration validation includes keyboard, focus, announcements, 900 by 620 layout, 100/150/200 percent scale, High Contrast, reduced motion, Accessibility Insights, NVDA, and measured 1600 by 900 render-difference evidence.
- Run `cargo test --manifest-path src-tauri/Cargo.toml --lib`, `cargo clippy --manifest-path src-tauri/Cargo.toml --lib -- -D warnings`, `npm.cmd run frontend:test`, both project-format verifier modes, both architecture-readiness verifier modes, and fixture verification for every migration or repair change.

## Production version 2 screenshot workflow

- Native tests cover opaque screenshot claim IDs, protected unsaved workspaces, autosave, first Save As, bootstrap cleanup, reopen, exact asset bytes, valid-version lock errors, external conflicts, cancellation, version 1 backup, stable repeated Save, and read-only repair/future rejection.
- Frontend tests cover lazy workspace creation on first capture, active-page materialization, canonical record staging, immediate title changes, Save As, migration reports, recovery by opaque workspace ID, clean-cache results, placement history, semantic Outline controls, and viewport state exclusion.
- The committed render comparison builds the legacy 0.5.3 and canonical `MediaPlacement` scenes at 1600 by 900. Fewer than 0.1 percent of pixels may exceed a per-channel difference of 8; the expected current result is zero differing pixels.
- Manual production review exercises Open, migration report, repair report, edit, Save, Save As, external conflict, cancellation, recovery, Project storage, PNG/PDF/Markdown/text export, and focus restoration at the supported sizes and accessibility modes.

## Deterministic fixtures

- `npm.cmd run fixtures:verify` checks every generated fixture against the committed manifest.
- `npm.cmd run fixtures:generate` regenerates numbered-frame, SDR/HDR, malformed import/archive, and version 1 project fixtures.
- `npm.cmd run native-decode:verify -- --self-test` checks the isolated exact-decode report verifier.
- `npm.cmd run native-decode:verify -- --manifest PATH` validates a complete issue #8 release evidence set against one exact build and binary hash.
- `npm.cmd run direct-stack:verify -- --self-test` checks the isolated direct-capture report verifier.
- `npm.cmd run direct-stack:verify -- --manifest PATH` validates issue #9 reports, retained-media hashes, fixed scenario counts, and the exact release binary hash.
- `npm.cmd run native-media-contract:verify -- --self-test` proves that the architecture-freeze verifier rejects softened 60 FPS, HDR, token, and interrupted-media policies.
- `npm.cmd run native-media-contract:verify -- --reference docs/spikes/native-media-freeze-reference-report.json` validates Issue #18 source revisions and hashes, every accepted native contract, ADR status and required sections, dependent architecture prose, accessibility and privacy boundaries, compatibility, and planned production conformance.
- `npm.cmd run media-placement:verify -- --self-test` checks the isolated placement-geometry report verifier.
- `npm.cmd run media-placement:verify -- --report PATH` validates issue #10 stable serialization, Fabric reconstruction, geometry, connector, z-order, history, page-switch, static-export, and semantic-control evidence against one exact commit.
- `npm.cmd run media-playback:verify -- --self-test` checks the isolated offscreen-playback report verifier.
- `npm.cmd run media-playback:verify -- --report PATH` validates issue #11 browser video-frame callbacks, one-active-placement behavior, exact-frame substitution, timed visibility, poster restoration, token boundaries, lifecycle cleanup, and semantic controls against one exact commit.
- `npm.cmd run viewport:verify -- --self-test` checks the isolated view-only viewport report verifier.
- `npm.cmd run viewport:verify -- --report PATH` validates issue #12 Fit, 25-200 percent zoom, reset, every pan path, resize, serialization/history/connector invariants, and exact static-export and thumbnail hashes against one exact commit.
- `npm.cmd run media-rendering:verify -- --self-test` checks the isolated rendering-performance report verifier.
- `npm.cmd run media-rendering:verify -- --fabric PATH --fabric-repeat PATH --dom PATH --visual-100 PATH --visual-150 PATH --visual-200-reduced PATH --visual-200-forced-colors PATH --reference docs/spikes/media-rendering-comparison-reference-report.json` validates issue #13 full-resolution performance, lifecycle cleanup, memory return, CPU/GPU evidence, semantic controls, minimum-viewport scale and accessibility modes, fixture identity, report privacy, and redacted reference accuracy from one exact implementation commit.
- `npm.cmd run placement-viewport-contract:verify -- --self-test` proves that the architecture-freeze verifier rejects persisted runtime/viewport state, softened performance gates, and weakened cleanup or accessibility boundaries.
- `npm.cmd run placement-viewport-contract:verify -- --reference docs/spikes/placement-viewport-freeze-reference-report.json` validates Issue #19 against all four retained source reports, exact revisions and thresholds, manual accessibility closeout, accepted ADR-0001, dependent architecture prose, security/privacy, compatibility, and planned production conformance.
- `npm.cmd run zip64-lazy:verify -- --self-test` checks the isolated ZIP64 lazy-open and materialization report verifier.
- `npm.cmd run zip64-lazy:run -- --build-id REVISION` builds one release harness, runs the complete issue #14 evidence-role matrix, hashes the binary and reports, and verifies their manifest against exact ZIP64, memory, lazy-read, validation, digest, cancellation, cleanup, privacy, and compatibility gates.
- `npm.cmd run workspace-lifecycle:verify -- --self-test` checks the isolated workspace identity, lock, recovery, external-change, and cache-policy report verifier.
- `npm.cmd run workspace-lifecycle:run -- --build-id REVISION` builds one release harness, runs the complete issue #15 evidence-role matrix, hashes the binary and reports, and verifies same-source reuse, copied-project separation, live/stale/malformed lock handling, external-change choices, close/reopen, protected cache eviction, cancellation, reparse rejection, cleanup, privacy, and compatibility gates.
- `npm.cmd run streamed-save:verify -- --self-test` checks the isolated raw-copy streamed Save and atomic-replacement report verifier.
- `npm.cmd run streamed-save:run -- --build-id REVISION` builds one release harness, runs the complete issue #16 evidence-role matrix, hashes the binary and reports, and verifies 5 GiB first Save, local and OneDrive-managed replacement, bounded memory, raw entry copy, streamed hashing, pre-replacement validation, cancellation, low-space refusal, corruption, simulated write failure, forced termination, cleanup, privacy, and compatibility gates.
- `npm.cmd run archive-gate:verify -- --self-test` checks the combined Milestone 4 storage-gate verifier and its negative cases.
- `npm.cmd run archive-gate:verify -- --reference docs/spikes/archive-gate-reference-report.json` binds the Issue #17 ZIP64 recommendation, thresholds, limitations, accessibility, security/privacy, compatibility, and revisit triggers to the exact retained reports from issues #14, #15, and #16.
- `npm.cmd run project-format-contract:verify -- --self-test` checks schema parsing, local JSON Schema references, every valid canonical/support document, 24 malformed contract fixtures, and four weakened-contract cases.
- `npm.cmd run project-format-contract:verify -- --reference docs/spikes/project-format-freeze-reference-report.json` binds Issue #20 UTF-8/LF-normalized schema and fixture hashes to accepted Issues #17-#19 evidence, ADR-0002/0008/0009, archive limits, token and Trash boundaries, the version 1 fixture, and planned Milestone 6 conformance.
- `npm.cmd run architecture-readiness:verify -- --self-test` proves that the Milestone 5 readiness verifier rejects missing decisions, unresolved blockers, weakened downstream traceability, threshold drift, and broken documentation links.
- `npm.cmd run architecture-readiness:verify -- --reference docs/spikes/architecture-readiness-reference-report.json` validates every local documentation link, accepted ADR, frozen schema/report identity and threshold, current-versus-future boundary, and Milestone 6 issue traceability requirement.
- Deterministic regression fixtures live under `src/test/fixtures/`; isolated spike media may live under `src/spikes/fixtures/`. Both locations contain synthetic content only.
- `src/test/fixtures/manifest.json` records hashes, byte counts, textual descriptions, expected failures, and accessibility descriptions.
- Fixture updates must keep regeneration instructions and validation evidence with the fixture change.

## Capture and lifecycle

- App starts hidden and exposes one tray icon.
- `Ctrl+Shift+F12` captures the display under the pointer.
- The screenshot does not contain the Gamebook overlay.
- The overlay appears above a borderless-fullscreen game.
- The overlay is centered and leaves the game visible on all four sides.
- `Esc` and Minimize autosave, hide the overlay, and return focus to the game.
- X opens an in-app confirmation above the editor; Cancel keeps the app running and Quit autosaves before exiting.
- Save, Open, and Export dialogs stay above and owned by the Gamebook window.
- A second launch activates the existing instance.

## Editing

- Each drawing tool creates a selectable object at the pointer position.
- Completing Pen, Arrow, Callout, Line, Box, Circle, Crop Extract, or Text returns to Select and keeps the new object active; text and callouts keep the caret ready.
- Arrow shafts terminate inside the arrowhead base with no stroke visible beyond the tip at any supported line width.
- The screenshot can be moved, resized, and rotated; undo/redo restores its transform.
- Callout arrows can cross the screenshot boundary and open a note at the endpoint.
- Line and arrow endpoint controls render at the actual endpoints at every canvas scale.
- Endpoints snap to object anchors and remain attached through target move, resize, rotation, undo, page switches, save, and reopen.
- Move each target of a two-ended connection several times in alternating order; both endpoints remain attached throughout.
- Clicking inside a diagonal connector's bounding rectangle but away from its visible stroke selects the object underneath instead of the connector.
- Dragging an attached connector body preserves its bindings; dragging one endpoint away from its anchor detaches only that endpoint.
- Text requires a drag, creates exactly one box, switches back to Select, and focuses the caret.
- Empty and populated text boxes show a blinking caret immediately after creation and after double-click editing.
- Text keeps its configured inset from every border while the fill reaches the full border edge.
- Text boxes resize horizontally and vertically without losing editability.
- The formatting bar follows only the text box currently being edited.
- Numeric font sizes accept exact values from 8 through 144.
- Font-size, border-width, and corner-radius steppers use dark themed buttons and accept exact typed values.
- Bullets continue on `Enter` and exit after `Enter` on an empty bullet.
- Text remains editable after page switches, project save, and project reopen.
- Text formatting applies to a selection or the whole active text box.
- Tool hotkeys do not fire while text is being typed.
- Undo and redo cover drawing, movement, resizing, deletion, and text changes.
- Long notes remain within the landscape page and do not overlap application controls.
- Selected-object color and line-width changes render immediately.
- Text-box backgrounds and shape fills support arbitrary colors and transparency.
- Rectangles and text boxes accept corner radii from 0 through 200; rounding updates live and survives undo, page switches, save, reopen, PNG, and PDF export.
- Tooltips for toolbar, formatting, appearance, project, save, export, window, history, and page controls remain fully visible above clipped and scrolling regions.
- Crop selection is constrained to the source screenshot and produces a crisp, independently movable image without modifying it.
- Crop images can be resized, rotated, connected, saved, reopened, exported, undone, redone, and deleted; the source screenshot cannot be deleted.

## Performance

- Drawing previews remain visually attached to the pointer without allocating more than once per animation frame.
- Moving, resizing, and rotating objects on a 14-page ultrawide project remains smooth and attached connectors update throughout the gesture.
- Continuous transforms do not rebuild anchor guides, React appearance controls, history, thumbnails, or autosave payloads until the gesture completes.
- Typing a paragraph produces grouped history and persistence work without a per-keystroke pause.
- Autosave begins only after the quiet period, returns through the async command path, and does not freeze object interaction while Rust compresses the project.
- New captures use a small JPEG page-strip thumbnail rather than decoding the full screenshot for every thumbnail instance.

## View-only viewport

- The logical page remains 1600 by 900; Fit is the default and reset selects centered 100 percent.
- Exercise 25, 50, 100, and 200 percent view zoom plus compact and large viewport resize paths.
- Exercise dedicated four-way pan controls, Space+Arrow, Space+primary-button drag, and middle-button drag.
- Arrow moves a selected object by one logical pixel, Shift+Arrow by ten, and Space+Arrow pans without moving it.
- After every view-only path, compare the exact page snapshot, undo/redo position, connector scene endpoints, static PNG hash and byte count, and thumbnail PNG hash and byte count.
- Verify malformed zoom, pan, and resize inputs preserve the prior valid view.
- Verify named icon controls, labeled slider, visible focus, polite zoom/position announcements, forced-colors rules, reduced-motion rules, 900 by 620 layout, and deterministic 200 percent UI-scale layout.
- Keep the production editor, Gamebook 0.5.3 screenshot behavior, and version 1 project serialization unchanged until issue #13 accepts a rendering architecture.

## Media rendering performance

- Generate exact 30-second, 1,800-sample 1920 by 1080 and 2560 by 1440 H.264 fixtures with the isolated Media Foundation example.
- Run each source for 30 seconds with a full-resolution offscreen surface, representative annotation and connector objects, and strictly advancing source-time frame accounting.
- Require at least 55 rendered FPS for both sources and pointer-event-to-render latency below 50 ms at p95.
- Record pause, seek, exact-frame, and page-switch timings plus CPU, GPU, process private memory, presented frames, rendered frames, source-time gaps, and coalesced render callbacks.
- Complete ten playback lifecycle loops; post-cleanup callbacks, sources, decoded frames, and attached media elements must all be zero, and private memory must return within 100 MB of baseline.
- Verify named keyboard controls, focus, polite status, forced colors, reduced motion, 900 by 620 layout, 100/150/200 percent scale, and NVDA output.
- Keep generated media, temporary browser profiles, and raw reports uncommitted; retain only redacted reference evidence governed by accepted ADR-0001.

## Sessions and export

- Repeated hotkey captures append pages without losing previous annotations.
- Pages can be reordered by pointer drag or keyboard from the grip, renumber automatically, deleted, and duplicated cleanly from the current screenshot.
- Page order in PDF, Markdown, and text matches the thumbnail strip.
- PNG contains the screenshot, annotations, notes, selected page background, and dotted grid without page-title chrome.
- PDF opens with one landscape page per capture.
- Markdown image links resolve from its generated asset folder.
- Autosave recovers the latest session after forced termination.
- Save cancellation does not display a false success state.

## Display coverage

- 3440x1440 ultrawide at 100% scale
- 1920x1080 at 100% scale
- 2560x1440 at 125% scale
- Secondary monitor with a negative desktop coordinate
- Minimum supported 900x620 overlay
