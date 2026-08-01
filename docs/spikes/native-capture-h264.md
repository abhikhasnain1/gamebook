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

Move the browser window to the target display and press `F` inside the fixture to enter browser fullscreen. Press `P` to pause/resume and `R` to reset its counters. For selected-window and source-close scenarios, use `picker-window` and choose this browser window. Add `?run=RUN_ID` to the local file URL when a visible run label is useful. The harness `--countdown` option gives the operator up to 30 seconds to focus or fullscreen the fixture after selecting a target.

## Harness Commands

Run from the repository root:

```powershell
$buildId = git rev-parse HEAD
git status --short
cargo run --manifest-path src-tauri/Cargo.toml --example native_capture_spike -- --build-id $buildId --target primary-monitor --scenario encode --duration 30 --frame-rate 60 --countdown 5 --run-id 1080p60-monitor-pass-01
cargo run --manifest-path src-tauri/Cargo.toml --example native_capture_spike -- --build-id $buildId --target picker-window --scenario encode --duration 30 --frame-rate 60 --countdown 5 --run-id selected-window-pass-01
cargo run --manifest-path src-tauri/Cargo.toml --example native_capture_spike -- --build-id $buildId --target primary-monitor --scenario cancel --duration 5 --frame-rate 60 --countdown 5 --run-id cancellation-cleanup-01
cargo run --manifest-path src-tauri/Cargo.toml --example native_capture_spike -- --build-id $buildId --target picker-window --scenario source-close --duration 30 --frame-rate 60 --countdown 5 --run-id source-close-cleanup-01
cargo run --manifest-path src-tauri/Cargo.toml --example native_capture_spike -- --build-id $buildId --target primary-monitor --scenario encoder-failure --duration 1 --frame-rate 60 --run-id encoder-failure-01
```

Run only from a clean committed branch: `git status --short` must have no output. `--build-id` is required and accepts a 7-64 character hexadecimal commit ID so every report identifies the exact source revision. Target options are `primary-monitor`, `monitor-index:N`, `picker-window`, `picker-monitor`, and the non-closeout `picker` fallback. The picker API does not expose the selected item type after selection, so `picker-window` and `picker-monitor` are operator declarations: the operator must choose the declared target kind. Scenario options are `encode`, `cancel`, `source-close`, and `encoder-failure`. For `source-close`, close the selected window before the configured timeout; a timeout produces a failing `source-not-closed` report and removes the partial MP4. Run IDs are restricted to 1-80 ASCII letters, numbers, hyphens, or underscores so they cannot escape the configured output directory.

Verify generated JSON reports before attaching them to the issue:

```powershell
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
- at least two selected-window captures through `picker-window`;
- 4K60 capability report or explicit lower-rate fallback;
- at least two cancellation-cleanup runs;
- at least two selected-window source-close runs;
- at least two device-loss attempts with recovery or explicit fallback evidence;
- one deliberate encoder-initialization failure report;
- at least two protected-content attempts with explicit blocked or blank-source outcomes.

The JSON report records the Gamebook package version, exact source revision, build profile, redacted command and artifact label, anonymous target kind/index label, source dimensions, dimensions requested from the encoder after even-dimension padding, requested frame rate and duration, submitted frame count, capture timestamp span, finalized MP4 duration from the Windows media property system, estimated dropped frames from timestamp gaps, largest timestamp gap, duplicate or backwards timestamps, finalization time, output size, cancellation cleanup, startup failure message where applicable, and runtime environment probes. Environment probes include Windows version and memory, CPU, GPU/display driver and current display mode, anonymized audio-device status counts, storage-volume capabilities without drive letters, WebView2 runtime, and active power scheme.

The verifier checks schema, exact build identity, anonymous target labels, path redaction, required probes, scenario-specific state, the one-frame finalized output-duration tolerance, and the five-second finalization threshold. Manifest verification also requires every report to use the same declared application build, every automated evidence role, repeated-run counts, at least 95% of the requested 30-second 60 FPS frame count for pass roles, two attempts each for device-loss and protected-content evidence, and completed manual rows with notes. A manual row cannot pass as `not-applicable`.

## Preliminary Architecture Finding

`windows-capture` 2.0.0 exposes the lifecycle needed for the capture portion of Milestone 2:

- monitor capture without a picker through `Monitor::primary` and `Monitor::from_index`;
- selected monitor/window capture through the system picker;
- cursor, border, secondary-window, dirty-region, frame-interval, and color-format controls;
- per-frame system-relative timestamps;
- H.264 MP4 finalization through Media Foundation;
- internal even-dimension padding in the encoder path.

The production capture decision remains unlocked only after the measured reports satisfy issue #6 and the dependent audio, decoding/color, interruption, and native-stack decision spikes.

## Accessibility Contract For Production

The eventual production recording workflow must provide keyboard-operable start, stop, cancel, target selection, failure review, and fallback notification controls. Status must announce preparing, recording, elapsed time, stopping, finalizing, completed, cancelled, failed, and source-closed states. Warnings for HUD exclusion, protected content, HDR blocking, device loss, and partial-output quarantine must be textual, focusable, High Contrast safe, and not color-only. Reduced-motion users must not receive animated recording state as the only state cue.

This isolated CLI harness has no shipped user-facing UI. Manual issue evidence still needs to record the keyboard and assistive-technology expectations for the production flow before issue #6 is closed.

## Security And Privacy Notes

The harness uses desktop capture APIs only. It does not inject into game processes, read game memory, open network connections, or write project records. The controlled fixture is self-contained and its verifier rejects external scripts, styles, network APIs, and local path markers. Audio is disabled in this issue's harness because WASAPI loopback and A/V synchronization are owned by the dependent audio spike. Cancellation and source-close paths ensure partial MP4 output is absent instead of leaving a referenced artifact. Report commands, output labels, and startup errors redact local paths; target labels omit monitor names, audio probes omit device names, and storage probes omit drive letters before JSON is written.

The harness output can contain sensitive screen contents and must stay local validation evidence unless the user intentionally shares it.

## Current Validation

Measured 1080p60, 1440p60, 4K60, source-close, device-loss, protected-content, and manual accessibility evidence are pending reference-system runs.
