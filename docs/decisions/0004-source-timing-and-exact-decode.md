# ADR-0004: Source timing and exact decode

- Status: Accepted
- Date: 2026-08-03
- Governing issue: #18
- Roadmap milestone: Milestone 5
- Supersedes: None
- Superseded by: None

## Context

Gamebook must step, annotate, extract, split, trim, reopen, and export video without inventing frame identities. Integer microseconds are appropriate for user-facing ranges, but Media Foundation source timestamps use 100-nanosecond ticks and cannot always be represented exactly after conversion. Issue #8 verified exact CFR 30, CFR 60, and explicit variable-frame-rate sample order and presentation timestamps. It also found that Sink Writer RGB conversion inserted cadence samples while direct NV12 retained the submitted timeline.

## Decision drivers

- Preserve source sample order and presentation timestamps for exact evidence.
- Keep user-facing clip and annotation ranges deterministic and readable.
- Detect a requested-frame mismatch instead of returning a nearby frame.
- Avoid browser seek behavior as the authority for exact decoding.
- Preserve exact identity through save, reopen, split, trim, extraction, and export.

## Options considered

### Microsecond timestamp only

A single integer-microsecond timestamp simplifies schemas but can round away canonical 100-nanosecond source timing and cannot disambiguate samples that share a converted value.

### Sample index plus native source PTS

An ordered decoded sample index paired with the source presentation timestamp preserves identity for CFR and VFR media. Derived microseconds remain suitable for UI and range arithmetic while the native pair remains authoritative.

## Decision

The canonical frame identity is the ordered pair `(decodedSampleIndex, sourcePresentationTimestamp100ns)`. Source PTS is retained as an integer count of 100-nanosecond Media Foundation ticks. User-facing clip, marker, poster, and annotation ranges use integer microseconds derived from source time, but the schema must not round away canonical source PTS.

Exact-frame requests carry both expected sample index and expected source PTS. Native decoding walks Source Reader samples in order and succeeds only when both values match. A mismatch, decode failure, unsupported format, or out-of-range request fails explicitly rather than returning the nearest frame. Decoder duration normalization may differ by no more than one 100-nanosecond tick and never replaces source PTS as identity.

Direct NV12 submission and direct Source Reader decoding are required for Gamebook-generated exact evidence. The measured Sink Writer RGB conversion path is not allowed because it inserted VFR cadence samples. Normal browser playback may render approximate current frames, but exact stepping, frame extraction, timed export, and poster generation use the native identity contract.

## Consequences

Version 2 records need both a user-facing microsecond value and canonical native identity where exact frame provenance is required. Timeline indexes may be derived for performance but are rebuildable and never authoritative. Split and trim operations change source ranges, not canonical frame identity.

Repeated playback announcements must be throttled so source-time updates do not flood assistive technology. Exact-step commands announce the resulting source time and frame position after native confirmation.

## Compatibility and migration

This decision changes no version 1 record. Legacy screenshots have no video timeline to migrate. Future imported media without a valid, monotonic decodable sample sequence is rejected before evidence creation or represented only through a separately accepted compatibility path.

## Accessibility

Previous frame, next frame, seek, range selection, and exact-mode controls require semantic names, keyboard operation, visible focus, and textual state. Exact-frame success and failure are announced; repeated playback time updates are throttled. Time and frame identity cannot be communicated only through canvas pixels or motion.

## Security and privacy

Decode uses verified local assets through opaque scoped tokens. Paths, tokens, media bytes, titles, and frame content are excluded from default diagnostics. Bounds, sample counts, dimensions, and duration are validated before allocation or extraction, and a failed request creates no referenced output.

## Validation

The accepted evidence is Issue #8 revision `eb9cba1efee25f5e3249e6236e9ea7c295c05463`, binary SHA-256 `8CE0DC2EE94CB5A22BA9F63684ACC0D89E0D162F4EF58C3B595AFE243CA484DC`, eleven reports, and five SHA-256-verified synthetic MP4s. Production conformance covers CFR 30, CFR 60, VFR order, duplicate or close timestamps, one-tick duration normalization, expected-pair mismatch, cancellation, malformed media, and repeated save/reopen identity.

## Documentation impact

This record updates the native timing and interface sections of `docs/VIDEO-EVIDENCE-ARCHITECTURE.md` and constrains Issue #20 version 2 evidence, frame, clip, timeline, and annotation schemas.
