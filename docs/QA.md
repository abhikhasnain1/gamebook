# Release QA Checklist

## Build gates

- `npm.cmd run check`
- `npm.cmd run frontend:build`
- `cargo check --manifest-path src-tauri/Cargo.toml`
- `npm.cmd run build`

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
