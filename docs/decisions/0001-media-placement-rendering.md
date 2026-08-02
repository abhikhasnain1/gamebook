# ADR-0001: Media placement rendering

- Status: Proposed
- Date: 2026-08-01
- Governing issue: #13
- Roadmap milestone: Milestone 3
- Supersedes: None
- Superseded by: None

## Context

Gamebook needs normal video playback, exact-frame substitution, poster frames, Fabric selection and transforms, timed annotations, connectors, page switching, and static export without putting runtime media state into a project. The proposed architecture preferred a full-resolution offscreen drawing surface as the Fabric image source, with layered DOM video as the fallback if the performance gate failed.

Issue #13 measured both approaches from exact implementation revision `4f63b5e00d793c4d90e212f6f9aa1e7bde05264c` using deterministic 1080p60 and 1440p60 H.264 fixtures. The retained [comparison report](../spikes/media-rendering-comparison-reference-report.json) and [methodology](../spikes/media-rendering-performance.md) contain the redacted evidence. This record remains Proposed until the Milestone 5 architecture freeze.

## Decision drivers

- Sustain at least 55 rendered FPS and keep p95 transform latency below 50 ms.
- Release callbacks, sources, decoded frames, and video elements after lifecycle stress.
- Return process private memory within 100 MB of baseline.
- Preserve Fabric geometry, hit testing, stacking, connectors, history, and static composition.
- Keep runtime URLs, media elements, decoded frames, and filesystem paths out of serialized projects.
- Preserve Gamebook 0.5.3 screenshot behavior and version 1 project compatibility.

## Options considered

### Fabric offscreen surface

A hidden video element supplies frames to a full-resolution drawing surface through the browser video-frame callback. `MediaPlacement` uses that surface as its Fabric image source. Two decision runs passed at 59.49-59.63 rendered FPS, 6.3-6.5 ms p95 transform latency, zero runtime leaks, and private-memory deltas of 22,667,264 and 21,848,064 bytes.

This keeps playback composition in the same Fabric scene as placement geometry, annotations, connectors, hit testing, viewport transforms, and static rendering. Its cost is a full-resolution drawing surface per active placement and one browser-to-canvas copy for each presented frame.

### Layered DOM video

A visible DOM video element is synchronized with a transparent Fabric `MediaPlacement`; Fabric annotations render above it. The fallback run passed at 59.53-59.88 rendered FPS, 6.2 ms p95 transform latency, zero runtime leaks, and a 4,481,024-byte private-memory delta.

This avoids the normal-playback full-resolution surface, but introduces a second composition system. Production would have to synchronize placement, crop, rotation, z-order, viewport transforms, visibility, exact-frame substitution, export, and cleanup across DOM and Fabric boundaries.

## Decision

Propose the Fabric offscreen-surface approach for normal playback. A `MediaPlacement` owns serializable geometry and identifiers; its runtime controller owns the hidden video element, video-frame callback, and drawing surface. Each presented frame is drawn once and requests one Fabric render. Exact decoded frames and poster frames use the same surface. Only one placement plays at a time.

Layered DOM video remains the measured fallback if later representative hardware, multi-placement requirements, or implementation evidence causes the Fabric approach to miss a frozen gate. This Proposed record does not authorize production media UI, recording, or schema work before Milestone 5 acceptance.

## Consequences

Fabric remains the single visual composition system for playback, placement, annotations, connectors, transforms, and page switching. Runtime ownership and cleanup stay behind the placement playback controller. Full-resolution surfaces require explicit lifecycle disposal and repeat memory validation on reference hardware.

Failure or cancellation must pause playback, cancel callbacks, clear source tokens, remove media elements, release decoded frames, and restore a poster or empty placement state. The isolated spike can be discarded without affecting the production editor.

## Compatibility and migration

This proposal changes no production code or stored project. Version 1 projects continue to parse, save, recover, and export exactly as Gamebook 0.5.3 does. A future accepted version 2 format stores only placement records and evidence identifiers; it never stores a drawing surface, video element, object URL, decoded frame, or filesystem path.

Rollback before schema freeze is deletion of the isolated spike. If the fallback is selected later, placement records remain compatible because rendering runtime state is excluded from serialization.

## Accessibility

Playback rendering does not replace semantic controls. Commands require accessible names, keyboard operation, visible focus, and polite state announcements. The isolated harness has one named Run command and a named composition alternative; axe found no serious or critical violations.

The 900 by 620 matrix passed at 100, 150, and 200 percent UI scale, including reduced-motion and forced-colors emulation. NVDA speech verification is still required before issue #13 and Milestone 3 can close.

## Security and privacy

Native code owns file access and issues revocable runtime media tokens. The webview receives no filesystem paths. Runtime URLs, video elements, frame bitmaps, decoded-frame references, and media bytes are excluded from serialization and diagnostics. The spike uses synthetic local fixtures, loopback-only requests, no project writes, and an isolated temporary browser profile.

## Validation

- Two 30-second Fabric runs and one 30-second layered-DOM run from the same exact revision and fixture hashes.
- Deterministic 1920 by 1080 and 2560 by 1440, 60 FPS, 1,800-frame H.264 fixtures.
- Frame rate, transform latency, pause, seek, exact frame, page switch, CPU, GPU, private memory, visual-state, and ten-loop cleanup evidence.
- Vitest gate tests, component semantics, keyboard focus, and axe serious/critical checks.
- Edge runs at 900 by 620 and 100, 150, and 200 percent UI scale, reduced motion, and forced colors.
- Pending: NVDA version and spoken control/status summary on the reference Windows system.

Revisit the proposal if representative hardware falls below 55 rendered FPS, reaches 50 ms p95 transform latency, retains more than 100 MB after cleanup, leaks runtime state, or cannot preserve exact frame and annotation composition.

## Documentation impact

- `docs/VIDEO-EVIDENCE-ARCHITECTURE.md`
- `docs/spikes/media-rendering-performance.md`
- `docs/QA.md`
- GitHub issue #13 and the Milestone 3 pull request
- A Milestone 5 placement-rendering ADR must accept, revise, or reject this proposal.
