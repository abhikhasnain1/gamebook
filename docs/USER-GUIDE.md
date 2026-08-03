# Gamebook User Guide

## Capture and return

1. Start Gamebook. It remains available in the Windows notification area.
2. Put the pointer on the display you want to capture.
3. Press `Ctrl+Shift+F12`. The capture becomes a new page and the editor opens as a centered box above the game. A margin of the live game remains visible on every side.
4. Press `Esc` or Minimize when finished. Gamebook autosaves before hiding. Use X only when you want to quit Gamebook completely; Gamebook asks for confirmation because quitting also disables background capture.

The tray menu can also capture, reopen the current gamebook, or quit the background application.

## Annotate a page

- Select moves, resizes, and rotates the screenshot, text boxes, and diagram objects.
- Pen draws one freehand mark.
- Arrow, Line, Box, and Circle drag from the first point to the second.
- Callout drags an arrow and opens an editable note box at the endpoint.
- Crop Extract lets you drag over part of the protected source screenshot and creates a separate image object from that region. The source remains unchanged.
- Every creation tool is one-shot. After a pen stroke, shape, connector, crop extraction, or text box is completed, Gamebook returns to Select and keeps the new object active so it can be moved, resized, styled, or connected immediately. Text boxes and callouts enter text editing with the caret ready.

New text boxes and double-clicked text boxes immediately show a blinking caret. Text has a consistent inset from the border while the background fill still reaches the complete outer edge. The formatting bar appears directly above the active box and includes an exact numeric font size, bold, italic, underline, bulleted lists, and alignment. Pressing `Enter` in a bullet continues the list; pressing `Enter` on an empty bullet exits it.

The white page is a finite 1600 by 900 grid workspace. The screenshot starts at a practical size but is not locked: select it to move, resize, or rotate it. Text boxes and diagrams can be placed anywhere, including across a screenshot edge. Fit is the default view; the view controls provide 25-200 percent zoom, centered 100 percent reset, and four-way pan without changing saved page geometry or exports. Space+Arrow, Space+drag, and middle-button drag also pan the view.

The Outline beside the page is the semantic counterpart to canvas selection. Select the screenshot there to review its layer and use named numeric controls for position, scale, and rotation. Outline and canvas selection stay synchronized without moving keyboard focus unexpectedly.

The color swatches and stroke preview affect new drawing objects. Use `-` and `+` around the preview to change line thickness. Hover any control for its purpose; tooltips are rendered above the complete interface and do not get clipped by scrolling toolbars. Press `Delete` to remove selected annotation objects; the page screenshot is protected from accidental deletion.

Crop extractions are ordinary image annotations. They can be moved, resized, rotated, connected to, annotated over, and deleted. They are generated from the original screenshot pixels rather than from the scaled page preview, so text and small interface details remain crisp in exports. You may create multiple extractions from the same source screenshot.

Select a line or arrow to reveal endpoint handles. Drag an endpoint near a screenshot, shape, or text-box anchor to attach it. Attached connectors remain aligned when either object moves, resizes, or rotates, including when both connected objects are moved in sequence. Drag an endpoint away from its anchor to detach only that end; moving the connector body preserves established connections.

Use the rainbow swatch for any annotation color and the paint-bucket control for the page background. Selecting an object opens its appearance bar for border color, exact border width, fill or text-box background, and transparency. Rectangles and text boxes also expose an exact corner-radius control, from square corners at `0` through strongly rounded corners. Numeric fields use matching dark step buttons and also accept typed values. The page uses a subtle dotted grid that is included in exports.

## Work with pages

Every hotkey capture adds a numbered page to the current gamebook. Drag a thumbnail by its grip to reorder it; pointer and keyboard sorting both update numbering and export order automatically. The gamebook title remains editable in the top bar, while pages are always named `1`, `2`, `3`, and so on.

Deleting a thumbnail removes that page from the current project. The delete control is hidden until the thumbnail is hovered. The plus button creates a clean page from the current screenshot without copying its annotations.

## Save and recover

Save writes an editable, portable `.gamebook` project. The first save asks for a location; later saves update that file. `Ctrl+S` is equivalent to Save. If the source changed outside Gamebook, Save pauses and offers Save As, explicit replacement, or cancellation instead of overwriting silently.

Gamebook autosaves changed records after a short quiet period inside a protected private workspace; it does not rebuild the project archive on every edit. Recoverable workspaces appear at startup and in Project storage. Project storage can also clear verified clean cache files, but it never removes unsaved or recovery data.

Open accepts current version 2 projects and legacy version 1 screenshot projects. Legacy projects are migrated in a workspace without changing the source, then a report summarizes the result. The first successful Save over a legacy source creates a collision-safe `.v1-backup`. Damaged version 2 input opens a read-only repair summary of valid and missing content; unsupported future versions are rejected without creating a mutable workspace or changing the file.

## Export

- PNG renders the current landscape page at high resolution.
- PDF renders every page into one landscape, multi-page document in thumbnail order.
- Markdown writes one `.md` file plus a sibling asset folder containing each rendered page image.
- Plain text writes page titles and all text-box content in page order.

Exports are flattened snapshots. Keep the `.gamebook` project when future editing is important.

## Keyboard reference

| Command | Shortcut |
| --- | --- |
| Capture | `Ctrl+Shift+F12` |
| Minimize to game | `Esc` |
| Save | `Ctrl+S` |
| Undo / Redo | `Ctrl+Z` / `Ctrl+Y` |
| Delete selection | `Delete` |
| Pan page view | `Space+Arrow` |
| Select | `V` |
| Pen | `P` |
| Arrow | `A` |
| Callout | `K` |
| Line | `L` |
| Box | `R` |
| Circle | `O` |
| Crop extract | `C` |
| Text | `T` |

When a text box is being edited, typing is reserved for text and tool shortcuts are suspended. The first `Esc` exits text editing; the next minimizes the overlay.
