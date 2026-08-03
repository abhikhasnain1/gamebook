# Architecture

## Runtime shape

Gamebook is a Tauri 2 desktop application with two long-lived layers:

- Rust owns the global hotkey, monitor capture, native window lifecycle, tray, single-instance policy, app-data recovery file, file dialogs, project compression, and final filesystem writes.
- React and Fabric.js own the editor state, direct manipulation, annotation serialization, history, page thumbnails, and export rendering.

The main WebView is created once and kept hidden while the game is active. Keeping the renderer warm avoids reconstructing the editor on every capture.

Interactive rendering is explicitly scheduled. Fabric automatic add/remove renders are disabled, drawing previews are limited to one animation-frame update and reuse their object, and transform events update only connectors bound to the changed target. React appearance state and anchor guides update at gesture boundaries rather than on every pointer sample.

## Capture sequence

1. The global-shortcut plugin receives `Ctrl+Shift+F12`.
2. Rust hides the overlay and waits briefly for the desktop compositor.
3. xcap captures the monitor under the pointer, with primary-display fallback.
4. Rust encodes the PNG, retains the bytes behind a short-lived opaque capture ID, and emits only that ID plus display metadata in `capture-created`.
5. The renderer lazily creates an unsaved version 2 workspace on the first capture, claims the PNG into its immutable asset store, and appends canonical screenshot evidence, placement, and page records. The native layer sizes the borderless window to 89% of the captured monitor width and 88% of its height, centers it, then reveals and focuses it.

An atomic in-process guard rejects overlapping capture requests.

## Page model

Each canonical page stores ordered `MediaPlacement` records, normalized Fabric annotations, extracted note text, and a page background. Screenshot evidence stores capture metadata, source dimensions, and an immutable asset digest. Source bytes, scoped media tokens, runtime URLs, and viewport transforms are not project fields.

The screenshot is reconstructed as an interactive `MediaPlacement` whenever a page loads. Its verified bytes are exposed through a workspace-scoped token that expires and is never persisted. History snapshots contain the frozen placement fields alongside annotation JSON, so screenshot movement and resizing participate in undo/redo without duplicating screenshot pixels or recording view state.

The logical page remains a finite 1600 by 900 surface. Fit is the default, with 25-200 percent zoom, reset, keyboard and pointer panning, and a semantic Outline. Fabric viewport transforms are ephemeral and cannot change page geometry, history, thumbnails, connectors, or exports.

Text notes use a registered `NoteTextbox` Fabric subclass. It preserves a user-drawn minimum height, uses width and height resize controls, and still expands when text needs more room. Content padding participates in wrapping, alignment, pointer hit testing, selection, and caret rendering, while the background and border share one adjustable rounded outline at the complete outer dimensions. Legacy `Textbox` notes are upgraded during deserialization.

Lines, arrows, and callouts use a registered purpose-built `Connector` Fabric object with direct endpoint controls. The shaft ends inside the arrowhead base instead of continuing underneath the tip. Each endpoint can store an object ID and one of four anchors. Target transforms recompute attached endpoints in scene coordinates, so moving, resizing, or rotating either target preserves the relationship. Connector hit testing measures distance from the pointer to the rendered segment instead of treating the complete diagonal bounding rectangle as clickable. Bindings are changed only by endpoint manipulation, so moving the connector body cannot silently discard an established relationship. Legacy grouped arrows and the previous `Fabric.Line` connector format are converted when loaded.

Crop extractions are Fabric image annotations that reuse the original screenshot image source with explicit `cropX`, `cropY`, width, and height. Their source ID and pixel rectangle remain in annotation metadata. This is non-destructive, avoids resampling the displayed canvas, and lets standard image controls, connector anchors, history, persistence, and exports operate without a parallel crop subsystem.

The page strip uses dnd-kit's pointer and keyboard sensors rather than native HTML drag events, which are unreliable in embedded WebViews. Tooltips use one delegated React portal layer with fixed viewport positioning so scrolling and clipped control containers cannot obscure them.

## Persistence

Version 2 `.gamebook` projects are portable ZIP64 archives containing canonical records and immutable content-addressed assets. Rust validates metadata and records, lazily opens the active page and immediate evidence, materializes assets by verified SHA-256, owns source-keyed workspaces and locks, writes recovery and Save journals, detects external source changes, evicts only verified clean cache data, and performs validated same-volume write-through replacement. Large unchanged stored entries remain raw-copied through a cancellation-aware reader. Scoped 256-bit media tokens expose verified bytes through the local `gamebook-media` protocol without returning an archive or workspace path.

Autosave waits for a quiet period, stages changed canonical documents atomically inside the workspace, and never rebuilds the archive. Unsaved and recovery-pending workspaces remain protected. Manual Save streams one replacement archive, validates it before visibility, and marks the workspace clean only after the visible archive reopens. Save cancellation and external-source conflicts preserve the prior project; the conflict flow offers Save As or explicit replacement.

Open accepts valid version 2 archives and Gzip or plain version 1 projects. Version 1 migration runs in an isolated workspace, preserves byte-identical screenshots and canonical page semantics, displays a migration report, and creates a collision-safe `.v1-backup` only on the first successful same-path replacement. Damaged version 2 input receives a read-only repair report, unsupported future versions are rejected before workspace creation, and failed or cancelled inputs are not mutated.

History snapshots cache their serialized comparison value, text edits are grouped over a short typing interval, and page patches reuse the latest snapshot. Thumbnail rendering runs in an idle callback at 192 by 108 pixels, while page-strip images decode asynchronously.

## Export pipeline

Pages materialize their verified screenshot asset as needed and render offscreen at a caller-selected multiplier with the viewport transform removed. PNG is a single rendered page. PDF embeds each rendered page as a 1600 by 900 landscape page. Markdown writes rendered page images to a sibling asset directory and uses relative links. Text export uses the extracted content of all note boxes.

Native dialogs are parented to the main WebView window and return the final destination; Rust performs all writes. The WebView receives no broad filesystem permission.

## Security boundaries

- The content security policy permits only the bundled application, Tauri IPC, development localhost, and local `data:` or `blob:` images.
- Verified version 2 image and media responses are limited to the local `gamebook-media` scheme and scoped, expiring tokens.
- The sole WebView uses Tauri core event and window permissions.
- Arbitrary filesystem APIs are not exposed to the frontend.
- The app does not inject DLLs, hook a game renderer, or inspect game memory.

## Important files

- `src-tauri/src/lib.rs`: native lifecycle, capture, persistence, and export commands
- `src-tauri/src/project_v2/`: version 2 archive validation, immutable assets, workspaces, recovery, tokens, and streamed replacement
- `src/components/CanvasEditor.tsx`: editor input, object creation, history, and inline formatting
- `src/lib/NoteTextbox.ts`: resizable fixed-height text-note object
- `src/lib/Connector.ts`: connector geometry, endpoint controls, anchors, snapping, and live relationship updates
- `src/lib/canvasPage.ts`: deterministic page composition, serialization, and rendering
- `src/App.tsx`: project UI, save/export orchestration, and keyboard flow
- `src/hooks/useProjectV2.ts`: reachable version 2 open, migration, workspace, save, recovery, and capture orchestration
- `src/types/projectV2.ts`: canonical screenshot editor adapters and serialization boundaries
- `src/types/session.ts`: version 1 compatibility parsing and shared annotation types
- `src/lib/native.ts`: typed renderer-to-native command boundaries
