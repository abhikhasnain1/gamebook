# ADR-0006: SDR color and logical aperture

- Status: Accepted
- Date: 2026-08-03
- Governing issue: #18
- Roadmap milestone: Milestone 5
- Supersedes: None
- Superseded by: None

## Context

Gamebook must not silently alter color or expose encoder padding as source pixels. Issue #8 measured direct NV12 H.264 encode/decode with SDR patches, PQ/BT.2020, HLG/BT.2020, and an odd 161 by 91 source. SDR Rec.709 full-range output passed with maximum patch error 1 against tolerance 24. Both HDR transfer functions were blocked before output. The odd source was padded to 162 by 92 with one replicated right and bottom pixel, but the resulting MP4 did not retain submitted `MFVideoArea` metadata.

## Decision drivers

- Produce explicit and testable SDR color metadata.
- Never claim tone mapping that has not passed representative validation.
- Preserve source logical dimensions independently of container aperture behavior.
- Keep exact decoded PNG evidence consistent with the logical source.
- Fail unsupported color paths before creating referenced media.

## Options considered

### Silent HDR-to-SDR conversion

This appears convenient but was not validated for reference patterns and representative game content. It risks clipping, hue shifts, and false evidence.

### Explicit SDR output with HDR blocking

This preserves the measured path and clearly reports unsupported HDR input. A later tone-mapping ADR may replace the block after it passes dedicated color validation.

## Decision

Gamebook-generated native video is 8-bit H.264 SDR with explicit BT.709 primaries, BT.709 transfer, BT.709 matrix, and full nominal range. Decoded PNG evidence is sRGB. SDR conformance uses a maximum per-channel patch error of 24; the accepted evidence measured 1.

PQ/BT.2020 and HLG/BT.2020 inputs are blocked before output. Gamebook does not silently tone map or label converted HDR as validated SDR. A future tone-mapping path requires a separate accepted decision based on representative patterns and game content.

Odd source dimensions may add at most one replicated right-edge pixel and one replicated bottom-edge pixel for encoder compatibility. Trusted evidence metadata stores the logical width and height outside the MP4 because the container aperture is not authoritative. Decode reapplies the trusted aperture, verifies bounds, and emits logical dimensions; it never infers those dimensions from padded pixels alone.

## Consequences

Capture setup must detect unsupported HDR before evidence promotion and explain the block. Evidence and timeline schemas must retain logical and encoded dimensions plus explicit color metadata. Import validation cannot assign trusted logical dimensions that are absent from an untrusted container without a separately accepted rule.

## Compatibility and migration

This decision does not alter version 1 screenshots or their export colors. Future version 2 video records add explicit color and logical-dimension metadata. A failed or unsupported conversion creates no project reference and does not mutate source media.

## Accessibility

HDR blocks, color-space failures, and aperture failures are textual, announced, keyboard reachable, and not conveyed only through color. Warnings pass forced colors and remain readable at 100/150/200 percent scale and 900 by 620. Reduced motion does not hide or delay the warning.

## Security and privacy

Dimensions, allocation sizes, color metadata, aperture offsets, and decoded output bounds are validated before allocation or visibility. Generated files remain local and unreferenced until probing succeeds. Diagnostics may include redacted color-space and dimension classes but exclude media, paths, titles, tokens, and frame content.

## Validation

The accepted evidence is Issue #8 revision `eb9cba1efee25f5e3249e6236e9ea7c295c05463`, binary SHA-256 `8CE0DC2EE94CB5A22BA9F63684ACC0D89E0D162F4EF58C3B595AFE243CA484DC`, eleven reports, and five synthetic MP4 fixtures. Production conformance covers SDR patches, explicit metadata, PQ and HLG blocking, odd width, odd height, both odd dimensions, replicated-edge limits, logical-dimension restoration, malformed aperture, cancellation, and no-reference-on-failure.

## Documentation impact

This record freezes the color and aperture sections in `docs/VIDEO-EVIDENCE-ARCHITECTURE.md` and constrains Issue #20 evidence metadata, native capture, exact decode, frame extraction, import, and export work.
