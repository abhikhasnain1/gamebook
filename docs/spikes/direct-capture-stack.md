# Direct Windows Capture Stack And Recovery Spike

> Status: Isolated Milestone 2 feasibility harness for issue #9. This is not a production recording path or an accepted architecture decision.

## Purpose

The harness evaluates direct Windows Graphics Capture, D3D11 readback, explicit SDR Rec.709 BGRA-to-NV12 conversion, Media Foundation H.264 encoding, target selection, capture exclusion, failure cleanup, interruption, and recovery classification. It does not add a Tauri command, recording UI, project record, schema, archive, setting, or production media protocol.

The direct path avoids the rejected `windows-capture` integrated recording path measured by issue #6. The issue #6 example and dependency remain isolated for reproducibility; this harness calls Windows APIs through `windows` bindings.

## Build And Run

Use one clean release source revision for a complete evidence set:

```powershell
cargo build --release --manifest-path src-tauri/Cargo.toml --example direct_capture_stack_spike

src-tauri\target\release\examples\direct_capture_stack_spike.exe `
  --build-id COMMIT_SHA `
  --run-id selected-window-01 `
  --target controlled-fixture-window `
  --scenario capture `
  --duration 30 `
  --frame-rate 60 `
  --countdown 3
```

Targets are:

- `monitor-under-pointer`: resolves the monitor containing the pointer without a picker.
- `controlled-fixture-window`: spawns and captures an animated local Win32 fixture with an anonymous report label.
- `fixture-monitor`: captures the monitor containing the owned fixture for HUD exclusion validation.

The controlled fixture uses no external asset, browser, network request, project data, audio, or microphone. Its child process watches a private parent pipe and closes itself after forced parent termination.

## Direct Pipeline

The harness creates a BGRA-capable D3D11 hardware device, converts it to an `IDirect3DDevice`, creates a free-threaded Windows Graphics Capture frame pool, and resolves target items through `IGraphicsCaptureItemInterop`. Each callback copies the actual WGC backing texture into a reusable staging texture and returns only the logical content rectangle.

Frames retain WGC `SystemRelativeTime` values. An absolute requested-rate schedule samples a faster source without resetting cadence from the previously accepted frame. The CPU conversion uses parallel fixed-point full-range Rec.709 coefficients bounded within one channel value of the accepted floating-point reference. Odd dimensions replicate at most one right or bottom edge pixel before direct NV12 submission.

Media Foundation Sink Writer receives explicit NV12, progressive H.264, SDR Rec.709 primaries, transfer, matrix, full nominal range, frame size, frame rate, and pixel aspect ratio. It does not use the RGB conversion stage that issue #8 found could insert variable-frame-rate cadence samples.

## Scenarios

- `capture`: finalize a non-empty local MP4 and record frame, timing, padding, conversion, submission, and finalization metrics.
- `cancel`: drop the unfinalized writer and remove the partial MP4.
- `source-close`: close the owned source window, finalize received media, and record whether WGC's `Closed` event or the owned-source fallback detected it.
- `initialization-failure`, `encoder-failure`, `gpu-failure`, `storage-failure`, `finalization-failure`, and `decoder-failure`: inject the named boundary and require explicit cleanup with no retained MP4.
- `device-loss`: inject a non-destructive device-loss boundary after 30 samples and finalize an unreferenced draft. It does not disable or manipulate a physical adapter.
- `protected-content`: apply `WDA_EXCLUDEFROMCAPTURE` to the selected fixture and report whether direct selected-window capture still exposes pixels.
- `hud-exclusion`: apply `WDA_EXCLUDEFROMCAPTURE` to the fixture, capture its monitor, and report whether the distinctive HUD marker remains visible or a fallback is required.
- `capture-interrupt`: retain an unfinalized staging MP4 and journal without project references or automatic deletion.
- `promotion-interrupt`: finalize staging media but interrupt promotion, retaining the media and journal.
- `recovery-check`: probe a retained staging MP4 through Media Foundation Source Reader and classify it as a recoverable playable draft or quarantined unplayable media without deleting it.

Recovery checks use `--input-run-id` to select a redacted local artifact identity:

```powershell
src-tauri\target\release\examples\direct_capture_stack_spike.exe `
  --build-id COMMIT_SHA `
  --run-id promotion-recovery-01 `
  --scenario recovery-check `
  --input-run-id promotion-interrupt-01 `
  --duration 1 `
  --countdown 0
```

## Evidence And Verification

Reports and media are written below `src-tauri/target/direct-capture-stack-spike` by default and remain uncommitted. Reports contain anonymous target kinds and artifact identities, not window titles, local paths, user identifiers, or media bytes.

Verify individual reports or a complete local manifest based on `direct-capture-stack-evidence.example.json`:

```powershell
npm.cmd run direct-stack:verify -- path/to/report.json --scenario capture
npm.cmd run direct-stack:verify -- --manifest path/to/evidence-manifest.json
npm.cmd run direct-stack:verify -- --self-test
```

The manifest binds every retained artifact to its byte count and SHA-256 hash, every report to one application build, and required repeated roles to explicit minimum counts.

## Accessibility Contract For Production

This isolated CLI and owned test fixture do not ship an interactive workflow, so keyboard navigation, focus order, NVDA, High Contrast, reduced motion, display scale, and window-size validation do not apply to the executables. Production target selection, recovery, quarantine, protected-content warning, HUD fallback, and failure review must be keyboard operable and textual. State changes and outcomes must be announced without relying on color, motion, sound, or canvas interpretation. Quarantine review must identify the failed operation, preserve the prior usable state, and expose deliberate retain or delete commands.

## Security And Privacy

The harness captures only after an explicit local invocation. Audio and microphone capture are absent. It does not inject into games, inspect game memory, open network connections, change Windows privacy settings, disable a device, write projects, or automatically delete interrupted media. Reports exclude local paths, target titles, user identifiers, media bytes, and device identifiers.

Completed validation media, interrupted staging files, recovery journals, and full reports remain local. Failure and cancellation cleanup may remove only the artifact created for that run. Recovery checks never promote, reference, or delete media.

## Current Validation

Focused tests and Clippy with warnings denied pass. Controlled smoke runs have exercised direct monitor and selected-window capture, one-pixel padding, cancellation and failure cleanup, source close, injected device loss, direct-window protected-content behavior, monitor HUD exclusion, unfinalized and finalized interruption, Media Foundation recovery probing, and true parent-process force termination. These smoke runs used a dirty development revision and are not closeout evidence. Exact clean-release repeated performance, display-mode, artifact-hash, and full manifest evidence remains required before the issue can select the final stack.
