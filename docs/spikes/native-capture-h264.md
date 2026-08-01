# Native Capture and H.264 Encoding Spike

> Status: Milestone 2 spike evidence for issue #6. This report is provisional and does not adopt a production recording architecture.

## Scope

This spike measures Windows Graphics Capture through `windows-capture` 2.0.0 and Media Foundation H.264 file finalization in an isolated Cargo example. It does not add production recording commands, UI, project-schema fields, or public recording behavior.

The harness lives at `src-tauri/examples/native_capture_spike.rs` and writes a local MP4 plus a JSON metrics report under `src-tauri/target/native-capture-spike/` by default. Generated MP4 and JSON outputs are validation artifacts and are not committed.

## Harness Commands

Run from the repository root:

```powershell
cargo run --manifest-path src-tauri/Cargo.toml --example native_capture_spike -- --target primary-monitor --scenario encode --duration 30 --frame-rate 60 --run-id 1080p60-monitor-pass-01
cargo run --manifest-path src-tauri/Cargo.toml --example native_capture_spike -- --target picker --scenario encode --duration 30 --frame-rate 60 --run-id selected-window-pass-01
cargo run --manifest-path src-tauri/Cargo.toml --example native_capture_spike -- --target primary-monitor --scenario cancel --duration 5 --frame-rate 60 --run-id cancellation-cleanup-01
cargo run --manifest-path src-tauri/Cargo.toml --example native_capture_spike -- --target primary-monitor --scenario encoder-failure --duration 1 --frame-rate 60 --run-id encoder-failure-01
```

Target options are `primary-monitor`, `monitor-index:N`, and `picker`. Scenario options are `encode`, `cancel`, and `encoder-failure`.

## Evidence Contract

Each committed closeout must attach the generated JSON summaries for:

- repeated 1080p60 monitor capture on the reference system;
- repeated 1440p60 monitor capture on the reference system;
- selected-window capture through the picker;
- 4K60 capability report or explicit lower-rate fallback;
- cancellation cleanup;
- source-close behavior;
- device-loss or encoder-failure behavior where the reference environment can reproduce it;
- protected-content behavior.

The JSON report records the command, target label, source dimensions, dimensions requested from the encoder after even-dimension padding, requested frame rate and duration, submitted frame count, capture timestamp span, largest timestamp gap, duplicate or backwards timestamps, finalization time, output size, cancellation cleanup, startup failure message where applicable, and runtime environment probes. Environment probes include Windows version and memory, CPU, GPU/display driver and current display mode, audio devices, storage volumes, WebView2 runtime, and active power scheme.

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

The harness uses desktop capture APIs only. It does not inject into game processes, read game memory, open network connections, or write project records. Audio is disabled in this issue's harness because WASAPI loopback and A/V synchronization are owned by the dependent audio spike. Cancellation and source-close paths remove partial MP4 output instead of leaving a referenced artifact.

The harness output can contain sensitive screen contents and must stay local validation evidence unless the user intentionally shares it.

## Current Validation

Measured 1080p60, 1440p60, 4K60, source-close, device-loss, protected-content, and manual accessibility evidence are pending reference-system runs.
