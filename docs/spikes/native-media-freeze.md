# Native media architecture freeze

## Scope

Issue #18 converts the measured Issues #6-#9 feasibility evidence into accepted native capture, timing, exact-decode, audio, color, aperture, and interrupted-recording contracts. It changes no production command, user interface, project schema, or current screenshot behavior.

The machine-checked [contract report](native-media-freeze-reference-report.json) traces exact source revisions, binary hashes where retained, thresholds, blocking results, accepted decisions, and planned conformance suites. Five accepted records own separate change boundaries:

- [ADR-0003](../decisions/0003-direct-windows-media-capture.md): direct Windows capture and H.264 encoding.
- [ADR-0004](../decisions/0004-source-timing-and-exact-decode.md): source timing, frame identity, and exact decoding.
- [ADR-0005](../decisions/0005-system-audio-loopback.md): whole-output-device audio, QPC synchronization, and consent.
- [ADR-0006](../decisions/0006-sdr-color-and-logical-aperture.md): SDR Rec.709, HDR blocking, padding, and logical aperture.
- [ADR-0007](../decisions/0007-interrupted-recording-recovery.md): staging, probing, drafts, quarantine, and cleanup.

```powershell
npm.cmd run native-media-contract:verify -- --self-test
npm.cmd run native-media-contract:verify -- --reference docs/spikes/native-media-freeze-reference-report.json
```

## Accepted stack

Rust owns direct Windows Graphics Capture and D3D11, direct NV12 Media Foundation H.264 encoding and Source Reader decoding, and direct shared-mode WASAPI loopback with Media Foundation AAC. No FFmpeg executable is bundled. The `windows-capture` 2.0.0 integrated recording path is not adopted; its isolated spike remains only for reproducibility.

Supported target concepts are monitor under pointer, selected monitor, and selected window. Production target enumeration and selection use native monitor/window identity rather than requiring the system picker, which did not return a usable item on the reference system. The selected target is represented by an opaque runtime ID and must not expose titles or device identifiers to project records or diagnostics.

## Capability and fallback

All six repeated direct 1080p, 1440p, and selected-window runs kept output duration within one 60 FPS frame and finalized below 38 ms. None reached the strict 1,710-frame sustained-throughput floor. This remains a blocking 60 FPS result.

The public request accepts 30 or 60 FPS, but 60 FPS is available only after the exact target class passes repeated 30-second conformance at 95 percent of requested frames, one-frame duration tolerance, and five-second finalization. Until qualified, Gamebook explains the limitation and uses 30 FPS. Media Foundation H.264 initialization through 4K60 is encoder capability evidence only and never qualifies sustained capture.

## Timing and exact frames

Native sample identity is the ordered pair of decoded sample index and source presentation timestamp in 100-nanosecond Media Foundation ticks. CFR 30, CFR 60, and explicit VFR fixtures retained exact submitted presentation timestamps and complete sample order. Decoder duration normalization may differ by at most one 100-nanosecond tick and cannot replace source PTS as identity.

User-facing clip and annotation ranges remain integer microseconds derived from source time. Milestone 5 schema work must retain enough native timeline information to reproduce sample identity without rounding the canonical source PTS away. Exact-frame requests include both expected sample index and timestamp; a mismatch fails rather than returning a nearby frame.

Direct NV12 submission and Source Reader decode are required for exact evidence. The measured Sink Writer RGB conversion path inserted VFR cadence samples and is not permitted for exact-evidence generation.

## Audio and consent

System audio is shared-mode WASAPI loopback of the complete default render/multimedia endpoint mix. It may contain notifications, voice chat, browsers, music, and other applications. Gamebook discloses this before first use and keeps video, system-audio, and microphone state independent, textual, keyboard operable, and announced.

The recording pins the activated output endpoint. A default-endpoint change is detected and recorded but does not silently switch the captured source. If the pinned endpoint fails, video continues, the audio discontinuity is retained, and the editor presents a warning. Microphone remains separate, default off, and separately consented; no project, settings recovery, update, or device change may enable it implicitly.

Audio packet QPC positions and the video reference clock share one QPC basis. The accepted gate is at most 50 ms drift after 30 seconds, encoded duration within one endpoint buffer, and finalization within five seconds. The evidence measured at most 22.28 ms absolute drift and 3 ms finalization with a 100 ms reference buffer.

## Color and aperture

Version 1 native output is 8-bit H.264 SDR with explicit BT.709 primaries, transfer, matrix, and full nominal range. Direct color conversion passed seven synthetic patches with maximum error 1 against tolerance 24. Decoded PNG evidence is sRGB.

PQ/BT.2020 and HLG/BT.2020 are blocked before output until a separate representative-pattern and game-content tone-mapping decision is accepted. No silent HDR conversion or tone-mapping claim is allowed.

Odd dimensions replicate no more than one right or bottom edge pixel. Trusted evidence metadata retains logical dimensions because the MP4 did not retain submitted `MFVideoArea`; decode reapplies that aperture and verifies the restored output dimensions.

## Capture lifecycle and recovery

Recording follows `idle -> preparing -> recording -> finalizing -> completed | failed | cancelled`. Media stays in a staging path beside a recovery journal and cannot become a project asset until final probing validates at least one playable video sample and the expected media contract.

Finalized but unpromoted playable media is an explicitly labeled recoverable draft. Unplayable interrupted media is quarantined. Neither is promoted, referenced, repaired, deleted, or included in diagnostics automatically. Recovery offers retry probe, recover eligible draft, reveal, or delete. Cancellation is idempotent, late events require the active recording ID, and every generated partial remains unreferenced.

The free-threaded selected-window path did not raise `GraphicsCaptureItem.Closed` on the reference system, so production requires an explicit source-lifecycle fallback. `WDA_EXCLUDEFROMCAPTURE` passed monitor HUD exclusion but did not hide a window captured as the direct target; it is not a protected-content guarantee. When visual HUD exclusion is not guaranteed, Gamebook uses a textual nonvisual fallback and warns the user.

## Accessibility, security, and compatibility

Production disclosures, target selection, start/stop/cancel, recording state, audio/microphone state, warnings, failure review, recovery, and quarantine are semantic keyboard workflows with visible/restored focus. Status and errors are announced without relying on color, sound, canvas, or motion. The surfaces must pass forced colors, reduced motion, 900 by 620, 100/150/200 percent scale, axe, Accessibility Insights, keyboard-only, and NVDA validation.

The native stack is local only. It does not inject into games, inspect game memory, change Windows privacy settings, require network access, or use destructive device manipulation. The frontend receives no unrestricted filesystem permission or native target/endpoint identifiers. Media uses a 256-bit random token bound to one application instance, workspace, asset digest, and allowed operation; it contains no path, is never persisted, expires after ten minutes of inactivity, and is revoked on project close, asset eviction, or application exit. The protocol permits only `GET` and `HEAD` with validated ranges and no directory listing.

Diagnostics exclude paths, titles, endpoint IDs, tokens, media, captions, transcripts, and note text. Interrupted media remains local, unreferenced, user controlled, and excluded from diagnostic export unless separately attached.

Gamebook 0.5.3 screenshot capture, the version 1 Gzip JSON format, recovery, editing, and exports remain unchanged. Issue #20 must carry the accepted native PTS, logical-dimension, staging, and recovery requirements into the version 2 schema without implementing recording before Milestone 7.
