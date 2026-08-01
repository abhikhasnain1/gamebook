# Native Capture and H.264 Encoding Spike

> Status: Milestone 2 spike evidence for issue #6. This report is provisional and does not adopt a production recording architecture.

## Scope

This spike measures Windows Graphics Capture through `windows-capture` 2.0.0 and Media Foundation H.264 file finalization in an isolated Cargo example. It does not add production recording commands, UI, project-schema fields, or public recording behavior.

The harness lives at `src-tauri/examples/native_capture_spike.rs` and writes a local MP4 plus a JSON metrics report under `src-tauri/target/native-capture-spike/` by default. Generated MP4 and JSON outputs are validation artifacts and are not committed.

## Controlled Capture Fixture

`tools/spikes/native-capture-fixture.html` is a standalone local capture stimulus. It draws SDR color bars, a physical-pixel-aware checkerboard, alternating cadence blocks, frame numbers, elapsed time, viewport dimensions, and measured animation cadence without loading external resources or making network requests.

Verify and open it from the repository root:

```powershell
npm.cmd run native-capture:fixture:verify
Start-Process tools/spikes/native-capture-fixture.html
```

Move the browser window to the target display and press `F` inside the fixture to enter browser fullscreen. Press `P` to pause/resume and `R` to reset its counters. For deterministic selected-window and source-close closeout runs, use `controlled-fixture-window`; it resolves only the exact fixture title and records an anonymous target label. The `picker-window` target remains available for exploratory system-picker runs. Add `?run=RUN_ID` to the local file URL when a visible run label is useful. The harness `--countdown` option gives the operator up to 30 seconds to focus or fullscreen the fixture after target resolution.

## Harness Commands

Run from the repository root:

```powershell
$buildId = git rev-parse HEAD
git status --short
cargo run --manifest-path src-tauri/Cargo.toml --example native_capture_spike -- --build-id $buildId --scenario encoder-capability --run-id encoder-capability-01
cargo run --manifest-path src-tauri/Cargo.toml --example native_capture_spike -- --build-id $buildId --target primary-monitor --scenario encode --duration 30 --frame-rate 60 --countdown 5 --run-id 1080p60-monitor-pass-01
cargo run --manifest-path src-tauri/Cargo.toml --example native_capture_spike -- --build-id $buildId --target controlled-fixture-window --scenario encode --duration 30 --frame-rate 60 --countdown 5 --run-id selected-window-pass-01
cargo run --manifest-path src-tauri/Cargo.toml --example native_capture_spike -- --build-id $buildId --target primary-monitor --scenario cancel --duration 5 --frame-rate 60 --countdown 5 --run-id cancellation-cleanup-01
cargo run --manifest-path src-tauri/Cargo.toml --example native_capture_spike -- --build-id $buildId --target controlled-fixture-window --scenario source-close --duration 30 --frame-rate 60 --countdown 5 --run-id source-close-cleanup-01
cargo run --manifest-path src-tauri/Cargo.toml --example native_capture_spike -- --build-id $buildId --target primary-monitor --scenario encoder-failure --duration 1 --frame-rate 60 --run-id encoder-failure-01
```

Run only from a clean committed branch: `git status --short` must have no output. `--build-id` is required and accepts a 7-64 character hexadecimal commit ID so every report identifies the exact source revision. Target options are `primary-monitor`, `monitor-index:N`, `controlled-fixture-window`, `picker-window`, `picker-monitor`, and the non-closeout `picker` fallback. The controlled target resolves only `Gamebook Native Capture Fixture - Brave` and never records that title. The picker API does not expose the selected item type after selection, so `picker-window` and `picker-monitor` are operator declarations: the operator must choose the declared target kind. Scenario options are `encode`, `cancel`, `source-close`, `encoder-failure`, and `encoder-capability`. For `source-close`, close the selected window before the configured timeout; a timeout produces a failing `source-not-closed` report and removes the partial MP4. Run IDs are restricted to 1-80 ASCII letters, numbers, hyphens, or underscores so they cannot escape the configured output directory.

`encoder-capability` is a no-pixel scenario. It does not construct or start Windows Graphics Capture. It submits two deterministic synthetic BGRA frames to Media Foundation for each profile in the fixed fallback order 3840x2160 at 60 FPS, 3840x2160 at 30 FPS, 2560x1440 at 60 FPS, and 1920x1080 at 60 FPS. A profile passes only when H.264 initializes, accepts both frames, finalizes a non-empty MP4, and removes the temporary MP4. This result establishes initialization and finalization capability on the tested stack; it does not establish sustained capture throughput, frame pacing, or 4K display availability.

The harness uses `windows-capture`'s system-default minimum update interval for 60 FPS runs, which the crate documents as 60 FPS, and applies a custom interval only for 30 FPS runs. This avoids rounding a nominal 60 FPS interval down to 16,666,666 nanoseconds before passing it to Windows Graphics Capture.

Verify generated JSON reports before attaching them to the issue:

```powershell
npm.cmd run native-capture:verify -- src-tauri/target/native-capture-spike/encoder-capability-01.json
npm.cmd run native-capture:verify -- src-tauri/target/native-capture-spike/1080p60-monitor-pass-01.json --scenario encode --min-source-width 1920 --min-source-height 1080
npm.cmd run native-capture:verify -- src-tauri/target/native-capture-spike/cancellation-cleanup-01.json --scenario cancel
npm.cmd run native-capture:verify -- src-tauri/target/native-capture-spike/source-close-cleanup-01.json --scenario source-close
npm.cmd run native-capture:verify -- src-tauri/target/native-capture-spike/encoder-failure-01.json --scenario encoder-failure
```

After the evidence set is collected, create a local evidence manifest based on `docs/spikes/native-capture-evidence.example.json`, replace its application-build values with the exact shared build, select either `adopt-windows-capture` or `direct-windows-api-fallback`, and run:

```powershell
npm.cmd run native-capture:verify -- --manifest path/to/native-capture-evidence.json
```

## Evidence Contract

Every closeout evidence set includes generated JSON summaries for:

- at least two 1080p60 monitor captures on the reference system;
- at least two 1440p60 monitor captures on the reference system;
- at least two selected-window captures through `picker-window` or the title-exact controlled fixture fallback;
- a synthetic encoder-capability report covering 4K60 and the fixed lower-rate fallback ladder;
- at least two cancellation-cleanup runs;
- one deliberate encoder-initialization failure report;

An adoption manifest marks every timed capture `expectedOutcome` as `pass` and additionally requires two selected-window source-close runs, two device-loss attempts, two protected-content attempts, HUD exclusion/fallback evidence, and completed manual accessibility evidence. A direct-Windows-API-fallback manifest marks measured timed runs as `capture-gate-failure`, requires at least one machine-checked failure for each monitor-resolution and selected-window role, and links source-close, device-loss, protected-content, and HUD exclusion/fallback validation to issue #9. This early-stop contract prevents a failed dependency path from being represented as adopted while preserving the remaining native-stack gates for the fallback implementation.

The JSON report records the Gamebook package version, exact source revision, build profile, redacted command and artifact label, anonymous target kind/index label, source dimensions, dimensions requested from the encoder after even-dimension padding, requested frame rate and duration, submitted frame count, capture timestamp span, finalized MP4 duration from the Windows media property system, estimated dropped frames from timestamp gaps, largest timestamp gap, duplicate or backwards timestamps, finalization time, output size, cancellation cleanup, startup failure message where applicable, and runtime environment probes. Environment probes include Windows version and memory, CPU, GPU/display driver and current display mode, anonymized audio-device status counts, storage-volume capabilities without drive letters, WebView2 runtime, and active power scheme.

The verifier checks schema, exact build identity, anonymous target labels, path redaction, required probes, scenario-specific state, the one-frame finalized output-duration tolerance, and the five-second finalization threshold. It separately verifies the complete ordered encoder-capability ladder, synthetic-only/no-capture declarations, per-attempt cleanup, first supported fallback, and build identity. Manifest verification requires one shared build and distinct repeated runs. Adoption requires at least 95% of the requested 30-second 60 FPS frame count for every pass role and completed manual rows; fallback requires structurally valid completed reports that fail throughput, duration, or finalization and a complete issue #9 gate handoff.

## Measured Reference Result

The closeout build was release commit `fd166f796a4f5411919798495a8e7b7b11c0dc33`, built from a clean worktree. The reference system reported Windows 11 Pro build 26200, an Intel Core Ultra 9 285K, an NVIDIA GeForce RTX 5080 with driver 32.0.15.9579, 64 GB RAM, NTFS storage, and the Balanced power scheme. Monitor runs used 1920 by 1080 at 60 Hz and 3440 by 1440 at the system-reported 164 Hz. The controlled fixture was observed live at 3432 by 1251 physical pixels and approximately 165 animation frames per second before the final run set.

For a 30-second 60 FPS pass, the verifier requires at least 1,710 submitted frames, output-duration error no greater than 16.6667 ms, and finalization within 5,000 ms.

| Role | Frames | Output-duration error | Largest timestamp gap | Finalization | Gate result |
| --- | ---: | ---: | ---: | ---: | --- |
| 1080p60 monitor 01 | 1,578 | +16.6500 ms | 33.3371 ms | 60 ms | Failed throughput |
| 1080p60 monitor 02 | 1,734 | -16.6834 ms | 33.3375 ms | 42 ms | Failed strict duration tolerance |
| 1440p60 monitor 01 | 1,649 | -0.0167 ms | 18.1977 ms | 37 ms | Failed throughput |
| 1440p60 monitor 02 | 1,649 | -0.0167 ms | 18.1966 ms | 38 ms | Failed throughput |
| Selected window 01 | 1,549 | +333.3166 ms | 1,473.6249 ms | 23 ms | Failed throughput and duration |
| Selected window 02 | 2 | +224,499.9833 ms | 127,253.2712 ms | 32,164 ms | Failed throughput, duration, and finalization |

The selected-window system picker was also attempted twice. Both picker calls completed immediately without returning a capture item, so no capture started and no report or MP4 was written. The title-exact controlled fixture fallback supplied the measured window runs above.

The exact-build no-pixel capability report completed with `captureStarted: false`, two synthetic frames per profile, successful cleanup, and all seven environment probes returning exit code 0.

| H.264 profile | Initialization | Finalization | MP4 bytes before cleanup | Result |
| --- | ---: | ---: | ---: | --- |
| 3840x2160 at 60 FPS | 571 ms | 58 ms | 3,001 | Supported |
| 3840x2160 at 30 FPS | 480 ms | 49 ms | 3,005 | Supported |
| 2560x1440 at 60 FPS | 480 ms | 43 ms | 2,041 | Supported |
| 1920x1080 at 60 FPS | 499 ms | 44 ms | 1,704 | Supported |

Two exact-build cancellation runs stopped after 274 submitted frames, reported `cancelled`, removed their partial MP4s, and left no output duration. The deliberate encoder-initialization failure reported `startup-failed`, submitted zero frames, and left no MP4.

## Architecture Recommendation

`windows-capture` 2.0.0 exposes the lifecycle needed for the capture portion of Milestone 2:

- monitor capture without a picker through `Monitor::primary` and `Monitor::from_index`;
- selected monitor/window capture through the system picker;
- cursor, border, secondary-window, dirty-region, frame-interval, and color-format controls;
- per-frame system-relative timestamps;
- H.264 MP4 finalization through Media Foundation;
- internal even-dimension padding in the encoder path.

Do not adopt the crate's integrated capture-and-encoding path for production. Repeated 1440p60 runs missed the frame-throughput gate, repeated 1080p60 runs did not both satisfy every gate, selected-window capture was unstable, and the system picker returned no item. The encoder-capability result shows that Media Foundation H.264 profile initialization is available; it does not offset the sustained capture failures.

Issue #9 must evaluate the direct Windows API fallback while preserving the proposed capture interfaces. It also owns source-close, device-loss, protected-content, HUD exclusion/fallback, interruption, quarantine, and final native-stack evidence. Issues #7 and #8 still own audio synchronization and exact decoding/color/aperture. No architecture decision record is accepted here; Milestone 5 records the durable capture decision after the remaining Milestone 2 gates are reviewed.

## Accessibility Contract For Production

The eventual production recording workflow must provide keyboard-operable start, stop, cancel, target selection, failure review, and fallback notification controls. Status must announce preparing, recording, elapsed time, stopping, finalizing, completed, cancelled, failed, and source-closed states. Warnings for HUD exclusion, protected content, HDR blocking, device loss, and partial-output quarantine must be textual, focusable, High Contrast safe, and not color-only. Reduced-motion users must not receive animated recording state as the only state cue.

This isolated CLI harness has no interactive or shipped user-facing UI, so keyboard navigation, focus, NVDA, High Contrast, reduced-motion, and scale checks do not apply to the executable itself. The written production contract above is the issue #6 accessibility evidence. Manual validation of actual recovery/fallback surfaces remains with issue #9, and manual validation of the shipped recording workflow remains a Milestone 7 acceptance requirement.

## Security And Privacy Notes

The harness uses desktop capture APIs only. It does not inject into game processes, read game memory, open network connections, or write project records. The capability scenario uses synthetic buffers without starting capture and removes every temporary MP4. The controlled fixture is self-contained and its verifier rejects external scripts, styles, network APIs, and local path markers. Audio and microphone capture are disabled in this issue's harness because WASAPI loopback and A/V synchronization are owned by the dependent audio spike. Cancellation evidence confirms partial MP4 output is absent; completed failed-gate MP4s remain unreferenced local artifacts. Report commands, output labels, and startup errors redact local paths; target labels omit monitor names, audio probes omit device names, and storage probes omit drive letters before JSON is written.

The harness output can contain sensitive screen contents and must stay local validation evidence unless the user intentionally shares it. No generated JSON or MP4 evidence is committed.
