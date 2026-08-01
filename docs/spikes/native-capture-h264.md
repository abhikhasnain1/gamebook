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

After the full evidence set is collected, create a local evidence manifest based on `docs/spikes/native-capture-evidence.example.json`, replace its application-build values with the exact shared build, update the paths and manual evidence statuses, and run:

```powershell
npm.cmd run native-capture:verify -- --manifest path/to/native-capture-evidence.json
```

## Evidence Contract

Each closeout evidence set must include the generated JSON summaries for:

- at least two 1080p60 monitor captures on the reference system;
- at least two 1440p60 monitor captures on the reference system;
- at least two selected-window captures through `picker-window` or the title-exact controlled fixture fallback;
- a synthetic encoder-capability report covering 4K60 and the fixed lower-rate fallback ladder;
- at least two cancellation-cleanup runs;
- at least two selected-window source-close runs;
- at least two device-loss attempts with recovery or explicit fallback evidence;
- one deliberate encoder-initialization failure report;
- at least two protected-content attempts with explicit blocked or blank-source outcomes.

The JSON report records the Gamebook package version, exact source revision, build profile, redacted command and artifact label, anonymous target kind/index label, source dimensions, dimensions requested from the encoder after even-dimension padding, requested frame rate and duration, submitted frame count, capture timestamp span, finalized MP4 duration from the Windows media property system, estimated dropped frames from timestamp gaps, largest timestamp gap, duplicate or backwards timestamps, finalization time, output size, cancellation cleanup, startup failure message where applicable, and runtime environment probes. Environment probes include Windows version and memory, CPU, GPU/display driver and current display mode, anonymized audio-device status counts, storage-volume capabilities without drive letters, WebView2 runtime, and active power scheme.

The verifier checks schema, exact build identity, anonymous target labels, path redaction, required probes, scenario-specific state, the one-frame finalized output-duration tolerance, and the five-second finalization threshold. It separately verifies the complete ordered encoder-capability ladder, synthetic-only/no-capture declarations, per-attempt cleanup, first supported fallback, and build identity. Manifest verification also requires every report to use the same declared application build, every automated evidence role, repeated-run counts, at least 95% of the requested 30-second 60 FPS frame count for pass roles, two attempts each for device-loss and protected-content evidence, and completed manual rows with notes. A manual row cannot pass as `not-applicable`.

## Preliminary Architecture Finding

`windows-capture` 2.0.0 exposes the lifecycle needed for the capture portion of Milestone 2:

- monitor capture without a picker through `Monitor::primary` and `Monitor::from_index`;
- selected monitor/window capture through the system picker;
- cursor, border, secondary-window, dirty-region, frame-interval, and color-format controls;
- per-frame system-relative timestamps;
- H.264 MP4 finalization through Media Foundation;
- internal even-dimension padding in the encoder path.

The production capture decision remains unlocked only after the measured reports satisfy issue #6 and the dependent audio, decoding/color, interruption, and native-stack decision spikes.

On the reference system, two attempts to launch `windows-capture` 2.0.0's system picker completed immediately without returning an item. No capture started and no report or MP4 was written. The controlled fixture target uses the same crate's direct window capture path so timing and source-close behavior can still be measured while the picker limitation remains an explicit architecture input.

## Accessibility Contract For Production

The eventual production recording workflow must provide keyboard-operable start, stop, cancel, target selection, failure review, and fallback notification controls. Status must announce preparing, recording, elapsed time, stopping, finalizing, completed, cancelled, failed, and source-closed states. Warnings for HUD exclusion, protected content, HDR blocking, device loss, and partial-output quarantine must be textual, focusable, High Contrast safe, and not color-only. Reduced-motion users must not receive animated recording state as the only state cue.

This isolated CLI harness has no shipped user-facing UI. Manual issue evidence still needs to record the keyboard and assistive-technology expectations for the production flow before issue #6 is closed.

## Security And Privacy Notes

The harness uses desktop capture APIs only. It does not inject into game processes, read game memory, open network connections, or write project records. The capability scenario uses synthetic buffers without starting capture and removes every temporary MP4. The controlled fixture is self-contained and its verifier rejects external scripts, styles, network APIs, and local path markers. Audio is disabled in this issue's harness because WASAPI loopback and A/V synchronization are owned by the dependent audio spike. Cancellation and source-close paths ensure partial MP4 output is absent instead of leaving a referenced artifact. Report commands, output labels, and startup errors redact local paths; target labels omit monitor names, audio probes omit device names, and storage probes omit drive letters before JSON is written.

The harness output can contain sensitive screen contents and must stay local validation evidence unless the user intentionally shares it.

## Current Validation

A preliminary no-pixel capability run from commit `4fd85d1` completed on the reference system with `captureStarted: false`, two synthetic frames per profile, successful cleanup, and all seven environment probes returning exit code 0.

| H.264 profile | Initialization | Finalization | MP4 bytes before cleanup | Result |
| --- | ---: | ---: | ---: | --- |
| 3840x2160 at 60 FPS | 621 ms | 54 ms | 3,001 | Supported |
| 3840x2160 at 30 FPS | 458 ms | 53 ms | 3,005 | Supported |
| 2560x1440 at 60 FPS | 462 ms | 36 ms | 2,041 | Supported |
| 1920x1080 at 60 FPS | 434 ms | 27 ms | 1,704 | Supported |

The capability result must be rerun from the final shared closeout build so its build identity matches every capture report in the evidence manifest. Measured 1080p60, 1440p60, selected-window, cancellation, source-close, device-loss, protected-content, HUD fallback, and manual accessibility evidence remain pending reference-system runs.
