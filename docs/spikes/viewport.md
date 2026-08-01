# View-only Viewport Spike

> Status: Isolated Milestone 3 feasibility harness for issue #12. This is measured spike evidence, not production editor behavior or an accepted architecture decision.

## Scope

The harness proves Fit, reset, 25-200 percent zoom, dedicated-control pan, Space+Arrow pan, Space+primary-button drag, middle-button drag, resize behavior, and unambiguous logical object movement. It also proves that every viewport path leaves the logical page snapshot, history, connector scene coordinates, static export pixels, and thumbnail pixels unchanged.

The verified Gamebook 0.5.3 editor and version 1 project schema are not imported by or changed for the harness. The standalone entry is `tools/spikes/viewport.html`; spike modules live under `src/spikes/` and are unreachable from the production entry point.

## Measured Contract

- The logical page remains 1600 by 900 at every view scale.
- Fit is the default and centers the logical page with a bounded inset.
- Zoom accepts only finite whole or fractional values from 25 through 200 percent and preserves the logical scene center.
- Reset selects a centered 100 percent view.
- Dedicated controls and Space+Arrow pan the view by 24 screen pixels. Space+primary-button drag and middle-button drag move page content with the pointer.
- Arrow moves the selected object by one logical pixel; Shift+Arrow moves it by ten. Those object-editing intents are distinct from Space+Arrow viewport panning.
- At least 80 screen pixels of a page edge remain reachable after panning.
- View mode, zoom, transform, and logical viewport center are ephemeral. They do not enter version 1 page serialization, undo/redo, connector calculations, thumbnails, or static exports.
- Non-finite zoom, pan, and viewport dimensions fail without changing the prior view.

## Run

```powershell
npm.cmd run start
```

Open the normal evidence run:

```text
http://127.0.0.1:1420/tools/spikes/viewport.html?build=COMMIT_SHA
```

For deterministic 200 percent UI-scale review, double the outer viewport and open:

```text
http://127.0.0.1:1420/tools/spikes/viewport.html?build=COMMIT_SHA&uiScale=2
```

The 2x transform uses a half-size application shell and the effective responsive rules, making a 1800 by 1240 outer viewport equivalent to a 900 by 620 workspace at 200 percent. The report records `environment.uiScale` explicitly.

Verify the report and verifier itself:

```powershell
npm.cmd run viewport:verify -- --self-test
npm.cmd run viewport:verify -- --report docs/spikes/viewport-reference-report.json
```

## Acceptance Evidence

The browser scenario runs 14 ordered Fit, zoom, reset, pan, pointer-intent, and resize paths. After each path it compares the exact version 1 snapshot, history position, logical connector endpoints, full static PNG hash and byte count, and thumbnail PNG hash and byte count. It also checks malformed input and semantic controls.

Vitest covers controller bounds, center preservation, resize, malformed inputs, keyboard intent, pointer-pan activation, viewport announcements, component interaction, and serious/critical axe findings. Manual browser interaction covers dedicated pan, Fit, zoom, selected-object Arrow movement, visual focus, responsive layout, and browser diagnostics. The browser automation surface cannot hold Space during a drag; Space+primary and middle-button activation are therefore covered by the pointer-session unit test and deterministic browser invariant sequence rather than claimed as manual input evidence.

No new native permission, path, media, credential, or diagnostic boundary is introduced. The harness stores no user data, has no persistence or recovery path, and exposes only synthetic geometry and artifact hashes in its report.

Issue #13 owns 1080p60/1440p60 performance, transform latency, memory growth, cleanup under stress, the final rendering architecture, and consolidated NVDA/Windows High Contrast review. No architecture decision record is accepted by this issue.

## Reference Result

The retained `viewport-reference-report.json` was produced from exact implementation commit `42a574a4599820f34c34a38dae1cf57a5665f0e7` on Windows using Chromium 150 at 1280 by 720. All 11 checks and all 14 ordered viewport paths passed. Every path retained the same 43,601-byte static export with SHA-256 `1e2117b3ddf85ca92360305d6a4052555d7a0853f5d3e977c07f1fa9a5902a55` and the same 2,577-byte thumbnail with SHA-256 `4233c644242af224f58f91ddff01311688a7b65917007aa1c21c32e61633ba78`.

The 900 by 620 run remained exactly 900 by 620 with no document overflow, warnings, or errors. A deterministic 200 percent scale run used an 1800 by 1240 outer viewport and a 900 by 620 half-size shell rendered at 2x; the full application filled the frame, the heading and controls remained visible without overlap, the document did not overflow, and the harness again passed 11/11 checks. Dedicated pan, Fit, zoom-in, and one-logical-pixel Arrow movement passed through rendered controls. NVDA and Windows High Contrast remain consolidated issue #13 reviewer checks.
