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

Closeout performance runs use `fixture-monitor` for both display resolutions so the selected monitor contains a continuously animated, locally owned stimulus. A run is an explicit blocking result when it misses 95% of the requested frames, the finalized video duration differs from 30 seconds by more than one requested frame, or finalization exceeds five seconds; the report does not relabel that result as a successful performance gate.

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

Each report records Gamebook 0.5.3, the exact source revision, debug or release profile, requested rate and duration, a redacted reference-environment probe set, and local-data/privacy declarations. Finalized reports are re-read through Media Foundation Source Reader and record encoded sample count, output timeline duration, backwards timestamps, one-frame duration tolerance, throughput result, and finalization result. The manifest binds the exact release executable and every retained media artifact to its byte count and SHA-256 hash.

Verify individual reports or a complete local manifest based on `direct-capture-stack-evidence.example.json`:

```powershell
npm.cmd run direct-stack:verify -- path/to/report.json --scenario capture
npm.cmd run direct-stack:verify -- --manifest path/to/evidence-manifest.json
npm.cmd run direct-stack:verify -- --self-test
```

The manifest binds every retained artifact to its byte count and SHA-256 hash, every report to one application build, and required repeated roles to fixed minimum counts. The fixed role set includes two runs each for 1080p60 monitor, 1440p60 monitor, selected window, source close, device loss, protected content, HUD exclusion, and cancellation; recording/finalization interruption and recovery; true force-termination recovery; and every injected initialization, encoder, decoder, GPU, storage, and finalization boundary.

## Accessibility Contract For Production

This isolated CLI and owned test fixture do not ship an interactive workflow, so keyboard navigation, focus order, NVDA, High Contrast, reduced motion, display scale, and window-size validation do not apply to the executables. Production target selection, recovery, quarantine, protected-content warning, HUD fallback, and failure review must be keyboard operable and textual. State changes and outcomes must be announced without relying on color, motion, sound, or canvas interpretation. Quarantine review must identify the failed operation, preserve the prior usable state, and expose deliberate retain or delete commands.

## Security And Privacy

The harness captures only after an explicit local invocation. Audio and microphone capture are absent. It does not inject into games, inspect game memory, open network connections, change Windows privacy settings, disable a device, write projects, or automatically delete interrupted media. Reports exclude local paths, target titles, user identifiers, media bytes, and device identifiers.

Completed validation media, interrupted staging files, recovery journals, and full reports remain local. Failure and cancellation cleanup may remove only the artifact created for that run. Recovery checks never promote, reference, or delete media.

## Current Validation

The closeout set used clean release source `f615378cb003b1a7e832ab601d59c56352658928` and one executable with SHA-256 `CF3E208FF67641E0D7CA93238DF7E7EACF274776F556ED2DFD5EF772EF5B5CD9`. The local manifest machine-verifies 27 reports, the executable, and every retained MP4 from that exact build.

The reference system reported Windows 11 Pro build 26200, an Intel Core Ultra 9 285K with 24 logical processors, approximately 63.38 GiB of visible memory, an NVIDIA GeForce RTX 5080 with driver 32.0.15.9579, healthy NTFS storage, the Balanced power scheme, and WebView2 150.0.4078.105. Monitor runs used a temporary verified 1920 by 1080 at 60 Hz mode and the restored 3440 by 1440 at 165 Hz mode. Audio and microphone capture remained disabled.

Every finalized performance report retained exactly one encoded sample for every submitted frame, had no backwards encoded timestamps, stayed within one 60 FPS frame of 30 seconds, and finalized in less than 38 ms. None reached the required 1,710 submitted frames, so all six are explicit blocking results rather than performance passes.

| Role | Submitted frames | Output-duration error | Finalization | Result |
| --- | ---: | ---: | ---: | --- |
| 1080p60 monitor 01 | 1,651 | -16.4501 ms | 37.4444 ms | Blocked by throughput |
| 1080p60 monitor 02 | 1,648 | +0.2499 ms | 36.8513 ms | Blocked by throughput |
| 1440p60 monitor 01 | 1,641 | -1.2334 ms | 31.6845 ms | Blocked by throughput |
| 1440p60 monitor 02 | 1,641 | -1.2334 ms | 27.4024 ms | Blocked by throughput |
| Selected window 01 | 1,621 | +4.8332 ms | 31.8227 ms | Blocked by throughput |
| Selected window 02 | 1,621 | +4.7999 ms | 31.9638 ms | Blocked by throughput |

The direct conversion and writer calls were not the measured throughput limit. Mean BGRA-to-NV12 conversion ranged from 1.28 ms per selected-window frame to 2.61 ms per 3440 by 1440 frame; mean `WriteSample` time ranged from 0.45 ms to 1.68 ms. The reference compositor/capture cadence remained below the strict 57 FPS floor.

Two source-close runs finalized 37 and 40 samples as unreferenced drafts. The free-threaded WGC item did not raise `Closed`; both runs used the explicit owned-source-process fallback. Two non-destructive device-loss injections finalized 30-sample unreferenced drafts. Two direct selected-window exclusion runs still exposed the controlled pixels, so `WDA_EXCLUDEFROMCAPTURE` is not treated as protected-content enforcement for a directly targeted window. Two 3440 by 1440 monitor runs excluded the distinctive HUD marker without fallback.

Two cancellations and every injected initialization, encoder, decoder, GPU, storage, and finalization failure left no media. Graceful recording interruption and exact parent-process force termination both retained unplayable staging media classified as quarantined. Finalized-but-unpromoted staging media was playable and classified as a recoverable draft. Every recovery result remained local, unreferenced, user-controlled, and undeleted.

Validation passed for the complete local manifest, verifier self-tests, five focused harness tests, all 29 Rust tests, all-target Clippy with warnings denied, TypeScript, 21 deterministic fixtures, 10 frontend tests, the frontend production build, the complete Tauri application build, and NSIS/MSI packaging. The existing 0.5.3 screenshot implementation and version 1 project format were unchanged.

## Architecture Recommendation

Select direct Windows API bindings as the Milestone 2 native implementation foundation:

- Direct Windows Graphics Capture and D3D11 through the `windows` bindings, with owned monitor/window resolution instead of the unreliable system-picker path measured in issue #6.
- Direct NV12 Media Foundation H.264 submission, Source Reader decoding, source presentation timestamps, trusted logical aperture metadata, and explicit SDR Rec.709 fields from issue #8.
- Direct shared-mode WASAPI loopback, PCM16-to-AAC encoding, and a shared QPC timing basis from issue #7. Microphone remains a separate, default-off production capability.
- Staging media plus a journal until final probing, with playable finalized drafts recoverable and unplayable outputs quarantined without automatic deletion or project references.

Do not adopt `windows-capture` 2.0.0's integrated recording path. Preserve the proposed public capture interfaces, but capability-gate 60 FPS and expose an explicit lower-rate fallback until a later implementation proves the strict 95% sustained-frame threshold. Preserve issue #6's successful H.264 4K60 initialization result as capability evidence only; it is not sustained 4K60 capture evidence. Keep PQ/BT.2020 and HLG/BT.2020 recording blocked until separately approved tone mapping exists.

This recommendation is a measured input to Milestone 5. It does not add production recording behavior or create an accepted architecture decision before architecture freeze.
