# Gamebook

Gamebook is a native Windows overlay for turning game screenshots into annotated, multi-page field notes without leaving a borderless-fullscreen game.

Press `Ctrl+Shift+F12` while playing. Gamebook captures the display under the pointer, opens as a centered overlay with the game still visible around it, and adds the capture as a new landscape page. Press `Esc` or Minimize to return to the game while Gamebook keeps running.

## Current feature set

- Native background tray application built with Tauri 2 and Rust
- Display-aware screenshot capture with a global hotkey
- Centered, monitor-relative overlay that preserves visible game context
- Finite grid workspace with freely movable and resizable screenshots
- Pen, arrow, callout, line, rectangle, circle, and text tools
- One-shot drawing flow that selects each new object immediately for adjustment
- Non-destructive crop extraction from the source screenshot at original resolution
- Endpoint-controlled arrows and lines with clean integrated arrowheads, precise hit areas, snap anchors, and persistent live connections
- Callouts that cross the screenshot boundary and create an editable note at the endpoint
- Drag-to-create, freely resizable text boxes with contextual formatting
- Exact font sizes, bold, italic, underline, continuing lists, and alignment controls
- Preset colors, full-spectrum color pickers, page backgrounds, fills, transparency, exact border widths, and adjustable rounded corners
- Select, move, resize, rotate, delete, undo, and redo
- Drag-reorderable, automatically numbered pages with delete and clean-page duplication
- Unclipped, consistent tooltips across editor, project, page, save, and export controls
- Subtle dotted grids that remain visible in PNG and PDF exports
- Debounced crash-recovery autosave
- Frame-throttled canvas interaction, lightweight page thumbnails, and background autosave compression for large projects
- Editable compressed `.gamebook` project files
- Current-page PNG export
- Whole-session landscape PDF, Markdown with image assets, and plain-text exports
- Single-instance behavior and native tray commands
- Separate minimize-to-game and confirmed quit actions, with parented native file dialogs

## Run locally

Prerequisites are Node.js 20 or newer, Rust stable with the MSVC target, Microsoft C++ Build Tools, and WebView2.

```powershell
npm.cmd install
npm.cmd run dev
```

The window starts hidden. Use `Ctrl+Shift+F12` or the tray icon to open it.

## Build installers

```powershell
npm.cmd run build
```

Windows installers are written below `src-tauri/target/release/bundle/`.

## Documentation

- [Documentation index](docs/INDEX.md)
- [User guide](docs/USER-GUIDE.md)
- [Architecture and data model](docs/ARCHITECTURE.md)
- [Release QA checklist](docs/QA.md)

## Scope

Gamebook is designed for borderless-fullscreen and windowed games. Exclusive fullscreen titles may prevent normal desktop overlays from appearing, and games that deliberately block desktop capture can return a blank image. Gamebook does not inject into a game process or interact with anti-cheat software.
