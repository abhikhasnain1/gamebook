# ADR-0003: Direct Windows media capture

- Status: Accepted
- Date: 2026-08-03
- Governing issue: #18
- Roadmap milestone: Milestone 5
- Supersedes: None
- Superseded by: None

## Context

Gamebook needs monitor-under-pointer, selected-monitor, and selected-window recording while preserving its non-injection boundary and existing screenshot workflow. Issue #6 tested the `windows-capture` 2.0.0 integrated recording path. Repeated 1080p, 1440p, and selected-window runs did not satisfy the strict 95 percent sustained-throughput gate, and the system picker did not return a usable target on the reference system. H.264 initialization through 4K60 proved encoder capability only.

Issue #9 then tested direct Windows Graphics Capture (WGC), D3D11, and Media Foundation bindings. Six repeated 60 FPS runs retained one encoded sample per submitted frame, stayed within one frame of requested duration, and finalized below 38 ms, but each remained below the required 1,710 submitted frames in 30 seconds. The same evidence proved native target resolution, monitor HUD exclusion, explicit cancellation/failure cleanup, and the need for source-lifecycle and selected-window HUD fallbacks.

## Decision drivers

- Keep frame ownership, timestamps, failure boundaries, and cleanup explicit in Rust.
- Support monitor-under-pointer, selected-monitor, and selected-window concepts without requiring the system picker.
- Preserve the strict sustained-throughput gate instead of inferring performance from encoder initialization.
- Keep the recording HUD out of monitor captures and provide a truthful fallback where exclusion is not guaranteed.
- Preserve Gamebook 0.5.3 screenshot behavior and version 1 project compatibility.

## Options considered

### `windows-capture` integrated recording

This option offers a convenient Rust abstraction and initialized Media Foundation H.264 through 4K60. Its measured integrated path did not pass sustained 1080p60, 1440p60, selected-window, or system-picker gates. It is retained only as isolated spike evidence and is not a production dependency for recording.

### Direct Windows APIs

This option binds WGC and D3D11 capture directly and submits NV12 samples to Media Foundation. It exposes the target, frame, clock, encoder, lifecycle, and failure boundaries needed by the accepted contracts. The evidence selected this stack while also demonstrating that 60 FPS cannot yet be enabled unconditionally.

## Decision

Use direct WGC and D3D11 bindings in Rust with direct NV12 Media Foundation H.264 submission. Production target enumeration resolves native monitor and window identities and returns opaque runtime IDs. The supported target concepts are monitor under pointer, selected monitor, and selected window.

The baseline recording rate is 30 FPS. Gamebook may expose 60 FPS for a target class only after repeated 30-second conformance runs on that class submit at least 95 percent of the requested frames, keep encoded duration within one requested frame, and finalize within five seconds. Encoder profile initialization, including 4K60 initialization, never qualifies sustained capture. An unqualified or unsupported target uses 30 FPS with a textual explanation.

WGC `GraphicsCaptureItem.Closed` is not the sole source-close signal. Production also monitors explicit source lifecycle and handles target loss as a recording failure boundary. `WDA_EXCLUDEFROMCAPTURE` is used for monitor HUD exclusion where supported, but is not a protected-content guarantee and cannot hide the directly selected window from its own capture. When visual HUD exclusion is not guaranteed, Gamebook uses a semantic textual recording status outside the captured content and warns the user.

No FFmpeg executable is bundled for this pipeline. This decision freezes the production contract but does not implement recording or authorize schema changes before their roadmap milestones.

## Consequences

The native layer owns capture sessions, D3D11 resources, sample submission, target lifecycle, capability qualification, and cleanup. Production must release native handles after stop, cancellation, source close, device loss, initialization failure, encoder failure, storage failure, or finalization failure.

The direct stack carries more platform integration code than the convenience abstraction. Its ownership boundaries are nevertheless testable and match the measured exact-frame, color, recovery, and privacy contracts. A future abstraction may replace the bindings only if it passes the same conformance suite without weakening these contracts.

## Compatibility and migration

This decision changes no production command, schema, stored project, or current user workflow. Gamebook 0.5.3 screenshot capture and version 1 Gzip JSON projects remain unchanged. Recording arrives only through later milestones and cannot make a version 1 project depend on media state.

## Accessibility

Target selection, disclosure, start, stop, cancel, status, warnings, and failure review require semantic keyboard controls, accessible names, visible and restored focus, and throttled announcements. Recording state, elapsed or remaining time, video state, and independent audio and microphone states cannot rely on color, motion, sound, or canvas content. The workflow must pass forced colors, reduced motion, 900 by 620 layout, 100/150/200 percent scale, keyboard-only, Accessibility Insights, and NVDA checks.

## Security and privacy

Capture remains local and does not inject into a game, inspect game memory, change Windows privacy settings, or require network access. Target titles and native IDs are not stored in project records or diagnostics. Failure tests use owned fixtures and injected boundaries rather than destructive device manipulation. Protected or unavailable pixels produce a warning or failure, never a claim that exclusion is an access-control boundary.

## Validation

The accepted evidence is the Issue #6 source revision `fd166f796a4f5411919798495a8e7b7b11c0dc33` and the Issue #9 direct-stack set from revision `f615378cb003b1a7e832ab601d59c56352658928`, binary SHA-256 `CF3E208FF67641E0D7CA93238DF7E7EACF274776F556ED2DFD5EF772EF5B5CD9`, and 29 machine-verified reports. Production conformance repeats target resolution, 30 FPS baseline, target-class 60 FPS qualification, duration, finalization, HUD, source-close, protected-content, cancellation, failure, and resource-cleanup scenarios.

## Documentation impact

This record is reflected in `docs/VIDEO-EVIDENCE-ARCHITECTURE.md`, `docs/spikes/native-media-freeze.md`, the native-media contract report, `docs/QA.md`, and the downstream version 2 schema and recording issues.
