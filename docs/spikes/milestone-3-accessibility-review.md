# Milestone 3 accessibility review

> Status: Manual validation protocol for the isolated Milestone 3 feasibility harnesses. Record results in issue #13 or its pull request; this document does not assert that a check passed.

## Purpose

Use this protocol to complete the consolidated keyboard, NVDA, Accessibility Insights, Windows Contrast Themes, reduced-motion, and UI-scale review for the MediaPlacement and viewport feasibility spike. The production editor is outside this protocol and remains unchanged.

Run the local Vite server before opening the harnesses:

```powershell
npm.cmd run start
```

Use current releases of NVDA, Accessibility Insights for Windows, Microsoft Edge WebView2, and Windows. Record their exact versions with the results.

## Harnesses

Review these synthetic, local-only harnesses:

| Workflow | Exact implementation | URL |
| --- | --- | --- |
| Placement geometry | `c6c25c37603cd93b004c56b9705cf6a378e74919` | `http://127.0.0.1:1420/tools/spikes/media-placement-geometry.html?build=c6c25c37603cd93b004c56b9705cf6a378e74919` |
| Playback and exact frame | `5f2c32fb7d56baf56ceb975ec51c74ee2cf84aa1` | `http://127.0.0.1:1420/tools/spikes/media-playback.html?build=5f2c32fb7d56baf56ceb975ec51c74ee2cf84aa1` |
| View-only viewport | `42a574a4599820f34c34a38dae1cf57a5665f0e7` | `http://127.0.0.1:1420/tools/spikes/viewport.html?build=42a574a4599820f34c34a38dae1cf57a5665f0e7` |
| Rendering performance | `4f63b5e00d793c4d90e212f6f9aa1e7bde05264c` | `http://127.0.0.1:1420/tools/spikes/media-rendering-performance.html?build=4f63b5e00d793c4d90e212f6f9aa1e7bde05264c&approach=dom` |

Do not use project media or personal data. Keep generated reports and temporary browser profiles uncommitted.

## Keyboard and NVDA

Start NVDA before opening each page. Use `Tab`, `Shift+Tab`, arrow keys, `Space`, and `Enter`; do not use a pointer to complete the workflow. Confirm that focus is visible at every step, focus order follows the visual order, controls expose concise names, current values and selected states are spoken, and status changes are announced once without rapid repetition.

### Placement geometry

1. Traverse page selection, Undo, Redo, export, placement selection, and every numeric placement field.
2. Select each page and placement. Confirm that NVDA announces the page or source name, control role, and selected state.
3. Change X, Y, scale, rotation, layer, poster timestamp, and crop values. Confirm that the value and resulting status are available without interpreting the canvas.
4. Use Undo and Redo after a value change. Confirm that the operation and restored selection or value are announced.
5. Run export verification and confirm that its result is announced.

### Playback and exact frame

1. Traverse placement selection, Play/Pause, seek, previous frame, next frame, poster, and source-time controls.
2. Activate Play and Pause with both `Enter` and `Space`. Confirm that playback state is spoken.
3. Change the seek control and use previous/next exact frame. Confirm that source time, decoded sample index, and resulting playback or exact-frame state are available semantically.
4. Select another placement. Confirm that the source name and selected state are announced and that only one placement reports playing.
5. Exercise poster restoration and the harness error path. Confirm that success uses a polite status and an actionable error uses an assertive announcement.

### View-only viewport

1. Traverse Fit, Reset, Zoom out, zoom percentage, Zoom in, directional pan controls, and page selection.
2. Activate Fit and Reset. Change zoom through 25%, 50%, 100%, and 200%; confirm that the current zoom is announced after each change.
3. Use the dedicated pan controls and `Space+Arrow`. Confirm that viewport position is announced.
4. With an object selected, use `Arrow` and `Shift+Arrow`; confirm that object movement remains distinct from `Space+Arrow` viewport panning.
5. Confirm that page selection and viewport state are available without interpreting canvas pixels.

### Rendering performance

1. Traverse to Run rendering benchmark and confirm its accessible name and visible focus indicator.
2. Activate Run with `Enter`, then repeat with `Space` in a separate run.
3. Confirm that the current source and five-second progress updates are announced politely and do not overwhelm speech.
4. When the run completes, navigate through the measurement summary. Confirm that source, rendered FPS, transform p95, dropped callbacks, and final result are discoverable as text.
5. Confirm that the named composition is supplemental and that operating the benchmark never requires canvas interpretation.

## Accessibility Insights

For every harness:

1. Run FastPass automated checks and record every failure, warning, and needs-review item.
2. Run Tab stops. Confirm the same complete, logical focus order exercised in the keyboard review and no keyboard trap.
3. Inspect control names, roles, values, selected states, status regions, and error regions.
4. Confirm that the canvas or visual composition has a concise accessible name and that equivalent controls and text expose the workflow.

A serious or critical automated failure, missing accessible name, keyboard trap, lost focus, or unavailable semantic alternative blocks Milestone 3 closure.

## Windows display modes

Run every harness at the 900 by 620 minimum application viewport.

### Contrast Themes

1. Record the current Windows contrast-theme setting.
2. Apply the Aquatic contrast theme in Windows Accessibility settings.
3. Confirm in the browser that `matchMedia("(forced-colors: active)").matches` is `true`.
4. Verify visible focus, selection, connectors, controls, labels, status, and errors. No meaning may rely on color alone, and no text or control may clip or overflow.
5. Restore the original Windows contrast-theme setting and confirm that forced colors is no longer active when the original setting was None.

### Reduced motion

1. Record the current Windows Animation effects setting.
2. Turn Animation effects off in Windows Accessibility settings.
3. Confirm in the browser that `matchMedia("(prefers-reduced-motion: reduce)").matches` is `true`.
4. Verify that playback does not start automatically and that no control, status, or measurement depends on animation.
5. Restore the original Animation effects setting and confirm the media query returns to its original value.

### UI scale

At 100%, 150%, and 200% UI scale, verify the complete keyboard workflow at the minimum application size. At 200%, use each harness's documented deterministic scale mode when changing the system display scale is impractical. Record the outer viewport, effective application shell size, scale method, overflow result, and any clipped or overlapping text or controls.

## Evidence record

Record the following in issue #13 or PR #61:

- Windows, Edge WebView2, NVDA, and Accessibility Insights versions.
- Exact harness revision and URL for each workflow.
- Keyboard-only focus order, activation result, and any blocker.
- NVDA speech summary for names, states, values, progress, completion, and errors.
- Accessibility Insights FastPass and Tab stops results.
- Contrast theme, reduced-motion setting, UI scales, viewport sizes, and restoration result.
- Reviewer name, date, failures, and links to any independently accepted follow-up issue.

Do not close issue #13 or mark ADR-0001 Accepted until every applicable Milestone 3 accessibility criterion has evidence and the architecture-freeze milestone reviews the proposed decision.
