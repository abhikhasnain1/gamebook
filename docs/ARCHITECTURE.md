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
4. Rust encodes the PNG in memory, creates a 224 by 126 JPEG page-strip thumbnail, and emits both with the display metadata in `capture-created`.
5. The renderer appends a page and makes it active. The native layer sizes the borderless window to 89% of the captured monitor width and 88% of its height, centers it, then reveals and focuses it.

An atomic in-process guard rejects overlapping capture requests.

## Page model

Each page stores:

- source PNG as a data URL;
- capture timestamp, display name, and source dimensions;
- the screenshot's position, scale, and rotation;
- Fabric annotation objects, excluding fixed page chrome and screenshot pixels;
- a small thumbnail;
- extracted note text for text and Markdown export.
- a page background color; the dotted grid is generated as a repeatable Fabric pattern.

The screenshot is reconstructed as an interactive Fabric image whenever a page loads. History snapshots contain its small transform record alongside annotation JSON, so screenshot movement and resizing participate in undo/redo without duplicating screenshot pixels.

Text notes use a registered `NoteTextbox` Fabric subclass. It preserves a user-drawn minimum height, uses width and height resize controls, and still expands when text needs more room. Content padding participates in wrapping, alignment, pointer hit testing, selection, and caret rendering, while the background and border share one adjustable rounded outline at the complete outer dimensions. Legacy `Textbox` notes are upgraded during deserialization.

Lines, arrows, and callouts use a registered purpose-built `Connector` Fabric object with direct endpoint controls. The shaft ends inside the arrowhead base instead of continuing underneath the tip. Each endpoint can store an object ID and one of four anchors. Target transforms recompute attached endpoints in scene coordinates, so moving, resizing, or rotating either target preserves the relationship. Connector hit testing measures distance from the pointer to the rendered segment instead of treating the complete diagonal bounding rectangle as clickable. Bindings are changed only by endpoint manipulation, so moving the connector body cannot silently discard an established relationship. Legacy grouped arrows and the previous `Fabric.Line` connector format are converted when loaded.

Crop extractions are Fabric image annotations that reuse the original screenshot image source with explicit `cropX`, `cropY`, width, and height. Their source ID and pixel rectangle remain in annotation metadata. This is non-destructive, avoids resampling the displayed canvas, and lets standard image controls, connector anchors, history, persistence, and exports operate without a parallel crop subsystem.

The page strip uses dnd-kit's pointer and keyboard sensors rather than native HTML drag events, which are unreliable in embedded WebViews. Tooltips use one delegated React portal layer with fixed viewport positioning so scrolling and clipped control containers cannot obscure them.

## Persistence

`GamebookSession` is a versioned JSON document. Project and recovery files are Gzip-compressed JSON with the `.gamebook` extension. The format is intentionally self-contained so projects remain portable and do not depend on hidden sidecar assets. Version 1 projects from the fixed-layout editor are normalized with a default screenshot transform when opened.

Autosave waits for a quiet period and uses the latest session reference, so page selection alone does not rewrite the project. The session is serialized once by Tauri IPC; Rust streams the JSON into fast Gzip compression on a blocking worker instead of recompressing the complete multi-page document on either UI thread. Minimizing hides the native window first, then snapshots and persists recovery data in the background; quitting still awaits its final recovery write before exiting.

History snapshots cache their serialized comparison value, text edits are grouped over a short typing interval, and page patches reuse the latest snapshot. Thumbnail rendering runs in an idle callback at 192 by 108 pixels, while page-strip images decode asynchronously.

## Export pipeline

Pages render offscreen at a caller-selected multiplier. PNG is a single rendered page. PDF embeds each rendered page as a 1600 by 900 landscape page. Markdown writes rendered page images to a sibling asset directory and uses relative links. Text export uses the extracted content of all note boxes.

Native dialogs are parented to the main WebView window and return the final destination; Rust performs all writes. The WebView receives no broad filesystem permission.

## Security boundaries

- The content security policy permits only the bundled application, Tauri IPC, development localhost, and local `data:` or `blob:` images.
- The sole WebView uses Tauri core event and window permissions.
- Arbitrary filesystem APIs are not exposed to the frontend.
- The app does not inject DLLs, hook a game renderer, or inspect game memory.

## Important files

- `src-tauri/src/lib.rs`: native lifecycle, capture, persistence, and export commands
- `src/components/CanvasEditor.tsx`: editor input, object creation, history, and inline formatting
- `src/lib/NoteTextbox.ts`: resizable fixed-height text-note object
- `src/lib/Connector.ts`: connector geometry, endpoint controls, anchors, snapping, and live relationship updates
- `src/lib/canvasPage.ts`: deterministic page composition, serialization, and rendering
- `src/App.tsx`: session UI, save/export orchestration, and keyboard flow
- `src/types/session.ts`: durable project schema
