# MediaPlacement rendering performance spike

> Status: Isolated Milestone 3 feasibility harness for issue #13. This is measured spike evidence, not a production rendering path or an accepted architecture decision.

## Scope

The harness measures the proposed Fabric offscreen-surface design with deterministic 1920 by 1080 and 2560 by 1440, 60 FPS H.264 fixtures. Each fixture contains exactly 1,800 source samples over 30 seconds. A full-resolution drawing surface feeds a `MediaPlacement` on a 1600 by 900 Fabric page with representative annotation and connector objects.

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
npm.cmd run media-rendering:run -- --build $build --duration-ms 30000 --output src-tauri\target\media-rendering-performance\reference-report.json
npm.cmd run media-rendering:verify -- --report src-tauri\target\media-rendering-performance\reference-report.json
```

The collector starts a separate Edge process with a temporary profile, loopback-only debugging, hardware acceleration, disabled background throttling, and a 1280 by 720 viewport. It samples the complete Edge process tree for CPU time, GPU-engine utilization, and private memory. The browser report records strictly advancing source `mediaTime` values rather than compositor submission counts, which can repeat on high-refresh displays.

For each source the harness records:

- 30-second presented and rendered source-frame rates and dropped callbacks.
- Synthetic pointer-event-to-Fabric-render latency distribution.
- Pause, seek, exact-frame substitution, and page-switch latency.
- Ten short playback lifecycle loops followed by callback, source, decoded-frame, and element cleanup.
- Keyboard-named controls, polite status announcements, reduced-motion and forced-colors state.
- Local network origins and proof that source URLs, runtime tokens, project data, and local paths are not persisted in the report.

The Fabric gate requires both sources to render at least 55 FPS, transform latency p95 below 50 ms, zero retained runtime resources, and post-cleanup process private memory no more than 100 MB above baseline. A failure requires layered DOM video evaluation before schema freeze.

## Manual accessibility evidence

Use the standalone page at:

```text
http://127.0.0.1:1420/tools/spikes/media-rendering-performance.html?build=COMMIT_SHA
```

At 900 by 620 and 100%, 150%, and 200% UI scale, verify keyboard focus order, visible focus, status announcements, forced colors, reduced motion, and no clipped controls. Record current NVDA and Windows versions plus the spoken benchmark state and measurement summaries in issue #13 or its pull request. The canvas composition has a named semantic alternative; interpreting canvas pixels is not required to operate the harness.

## Security and recovery

Fixtures and reports contain synthetic content only. The harness makes requests only to the loopback Vite origin, exposes no filesystem paths to the page, writes no project data, and deletes the temporary browser profile before each run. Failed or cancelled runs leave the verified Gamebook project and recovery state untouched. The collector terminates its isolated browser process in `finally`; retained target artifacts remain unreferenced local evidence for review.
