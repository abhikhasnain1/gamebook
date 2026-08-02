# MediaPlacement rendering performance spike

> Status: Isolated Milestone 3 feasibility harness for issue #13. This is measured spike evidence, not a production rendering path or an accepted architecture decision.

## Scope

The harness compares the proposed Fabric offscreen-surface design with a layered DOM video fallback using deterministic 1920 by 1080 and 2560 by 1440, 60 FPS H.264 fixtures. Each fixture contains exactly 1,800 source samples over 30 seconds. Both approaches use a `MediaPlacement` on a 1600 by 900 Fabric page with representative annotation and connector objects.

The production editor, screenshot capture, version 1 project parser, persistence, and export paths are not imported or changed. Local fixture media, Edge profiles, and raw reports remain below `src-tauri/target/media-rendering-performance/` and are not committed.

## Generate fixtures

Build the deterministic Media Foundation fixture generator from the exact revision under test:

```powershell
$build = git rev-parse HEAD
cargo build --release --manifest-path src-tauri/Cargo.toml --example media_render_fixture
src-tauri\target\release\examples\media_render_fixture.exe --width 1920 --height 1080 --fps 60 --duration 30 --output src-tauri\target\media-rendering-performance\fixture-1080p60.mp4 --report src-tauri\target\media-rendering-performance\fixture-1080p60.json --build-id $build
src-tauri\target\release\examples\media_render_fixture.exe --width 2560 --height 1440 --fps 60 --duration 30 --output src-tauri\target\media-rendering-performance\fixture-1440p60.mp4 --report src-tauri\target\media-rendering-performance\fixture-1440p60.json --build-id $build
```

The generator uses Media Foundation H.264 hardware transforms, deterministic full-resolution NV12 content, SDR Rec.709 limited-range metadata, integer 100 ns timestamps, no audio, no network access, and no project writes.

## Run the benchmark

Start the local Vite server, then run the isolated Edge collector:

```powershell
npm.cmd run start
$build = git rev-parse HEAD
npm.cmd run media-rendering:run -- --build $build --duration-ms 30000 --approach fabric --output src-tauri\target\media-rendering-performance\fabric-reference.json
npm.cmd run media-rendering:run -- --build $build --duration-ms 30000 --approach fabric --output src-tauri\target\media-rendering-performance\fabric-repeat.json
npm.cmd run media-rendering:run -- --build $build --duration-ms 30000 --approach dom --output src-tauri\target\media-rendering-performance\dom-reference.json
npm.cmd run media-rendering:verify -- --fabric src-tauri\target\media-rendering-performance\fabric-reference.json --fabric-repeat src-tauri\target\media-rendering-performance\fabric-repeat.json --dom src-tauri\target\media-rendering-performance\dom-reference.json --visual-100 src-tauri\target\media-rendering-performance\visual-100.json --visual-150 src-tauri\target\media-rendering-performance\visual-150.json --visual-200-reduced src-tauri\target\media-rendering-performance\visual-200-reduced.json --visual-200-forced-colors src-tauri\target\media-rendering-performance\visual-200-forced-colors.json --reference docs\spikes\media-rendering-comparison-reference-report.json
```

The collector starts a separate Edge process with a temporary profile, loopback-only debugging, hardware acceleration, disabled background throttling, and a 1280 by 720 viewport. It samples the complete Edge process tree for CPU time, GPU-engine utilization, and private memory. The browser report records strictly advancing source `mediaTime` values rather than compositor submission counts, which can repeat on high-refresh displays.

For each source the harness records:

- 30-second presented and rendered source-frame rates and dropped callbacks.
- Synthetic pointer-event-to-Fabric-render latency distribution.
- Pause, seek, exact-frame substitution, and page-switch latency.
- Ten short playback lifecycle loops followed by callback, source, decoded-frame, and element cleanup.
- Keyboard-named controls, polite status announcements, reduced-motion and forced-colors state.
- Local network origins and proof that source URLs, runtime tokens, project data, and local paths are not persisted in the report.

The gate requires both sources to render at least 55 FPS, transform latency p95 below 50 ms, all visual-mode checks, zero retained runtime resources, and post-cleanup process private memory no more than 100 MB above baseline. The comparison verifier also requires an exact shared build, fixture hashes, generator hash, reference environment, viewport, scale, and collection contract.

## Reference result

The retained [comparison report](media-rendering-comparison-reference-report.json) was produced from exact implementation revision `4f63b5e00d793c4d90e212f6f9aa1e7bde05264c`. Two Fabric runs passed at 59.49-59.63 rendered FPS, 6.3-6.5 ms p95 transform latency, zero dropped render callbacks, zero retained runtime resources, and private-memory deltas of 22,667,264 and 21,848,064 bytes. The layered-DOM fallback passed at 59.53-59.88 rendered FPS, 6.2 ms p95 transform latency, zero dropped render callbacks, zero retained runtime resources, and a 4,481,024-byte private-memory delta.

[ADR-0001](../decisions/0001-media-placement-rendering.md) proposes the Fabric offscreen surface because it passes the gate twice while retaining one Fabric composition system for placement, annotations, transforms, hit testing, z-order, and page switching. Layered DOM remains the measured fallback. The ADR is Proposed and does not change current Gamebook behavior.

## Manual accessibility evidence

Follow the consolidated [Milestone 3 accessibility review](milestone-3-accessibility-review.md) for keyboard-only, NVDA, Accessibility Insights, Windows Contrast Themes, reduced-motion, and UI-scale evidence across issues #10 through #13.

Use the standalone page at:

```text
http://127.0.0.1:1420/tools/spikes/media-rendering-performance.html?build=COMMIT_SHA
```

At 900 by 620 and 100%, 150%, and 200% UI scale, verify keyboard focus order, visible focus, status announcements, forced colors, reduced motion, and no clipped controls. Record current NVDA and Windows versions plus the spoken benchmark state and measurement summaries in issue #13 or its pull request. The canvas composition has a named semantic alternative; interpreting canvas pixels is not required to operate the harness.

The automated matrix records `--viewport 900x620`, `--ui-scale 1|1.5|2`, `--reduced-motion true|false`, and `--forced-colors true|false`. All four retained runs passed visual synchronization and cleanup; component tests reported no serious or critical axe findings. NVDA 2026.1.1 completed the manual spoken review on the reference Windows system. It announced the named Run control, source changes, five-second progress updates, browser completion, and the text measurement summary. The Enter-activated run completed at 59.96/59.81 rendered FPS, and the separate Space-activated run completed at 59.56/59.94 rendered FPS. Both runs reported 6.2 ms p95 transform latency and zero dropped callbacks for the 1080p60 and 1440p60 sources.

## Security and recovery

Fixtures and reports contain synthetic content only. The harness makes requests only to the loopback Vite origin, exposes no filesystem paths to the page, writes no project data, and deletes the temporary browser profile before each run. Failed or cancelled runs leave the verified Gamebook project and recovery state untouched. The collector terminates its isolated browser process in `finally`; retained target artifacts remain unreferenced local evidence for review.
