# Exact Decode, Color, And Aperture Spike

> Status: Isolated Milestone 2 feasibility harness for issue #8. This is measured spike evidence, not a production media path or an accepted architecture decision.

## Purpose

The harness generates deterministic synthetic H.264 media with Media Foundation Sink Writer, decodes it with Media Foundation Source Reader, extracts requested samples as PNG, and records exact timeline, frame-identity, color, aperture, HDR-blocking, and cleanup evidence. It does not add a Tauri command, recording or playback UI, project records, schema, persistence, import, archive, or production media protocol.

The generation and decode paths use NV12 directly. Avoiding Sink Writer RGB conversion is material: the RGB conversion stage inserted cadence frames for variable-frame-rate input. Direct NV12 submission preserves one decoded sample for each submitted VFR sample.

## Build And Run

Use one exact clean release source revision for every report in an evidence set:

```powershell
cargo build --manifest-path src-tauri/Cargo.toml --example native_decode_spike --release

src-tauri\target\release\examples\native_decode_spike.exe `
  --build-id COMMIT_SHA `
  --scenario cfr-30 `
  --run-id cfr-30-01
```

Reports, synthetic MP4s, and requested-sample PNGs are written below `src-tauri/target/native-decode-spike` by default. They are local evidence and must remain uncommitted except for the single redacted reference report named below.

Available scenarios are:

- `cfr-30`: 30 submitted samples at native integer 30 FPS boundaries; extracts samples 0, 15, and 29.
- `cfr-60`: 60 submitted samples at native integer 60 FPS boundaries; extracts samples 0, 30, and 59.
- `vfr`: 12 samples with an explicit nonuniform duration schedule; extracts samples 0, 4, and 11.
- `sdr-color`: SDR Rec.709 color bars with seven central-patch comparisons.
- `odd-aperture`: a 161 by 91 logical frame padded to 162 by 92 with one replicated edge pixel, then restored to 161 by 91 PNG output.
- `hdr-pq-block`: explicit PQ/BT.2020 rejection before output creation.
- `hdr-hlg-block`: explicit HLG/BT.2020 rejection before output creation.
- `malformed`: invalid input rejection and cleanup.
- `out-of-range`: requested-sample bounds rejection and cleanup.
- `cancel`: unfinalized encode cancellation and partial-file cleanup.
- `decoder-failure`: injected post-decode failure and cleanup of source and partial extraction artifacts.

## Timeline And Identity Contract

CFR timestamps use integer Media Foundation boundaries:

```text
pts = floor(sample_index * 10,000,000 / fps)
duration = next_pts - pts
```

The VFR fixture uses explicit positive integer durations and strictly increasing presentation timestamps. The verifier requires decoded presentation timestamps to equal the submitted timestamps and decoded identities to equal the complete submitted sample order. Requested-sample PNG entries must match the requested indices and decoded identities exactly.

Media Foundation can normalize decoded sample-duration metadata by one 100-nanosecond tick while retaining exact presentation timestamps. The report therefore records both submitted integer durations and decoder-reported durations; exact evidence selection is governed by sample order plus submitted and decoded presentation timestamps.

The 60-frame identity palette uses a 4 by 4 by 4 RGB cube with 64-value channel spacing. Identity is determined from the decoded central pixel after the harness's explicit NV12-to-Rec.709 conversion. This proves sample identity across lossy H.264; it does not claim pixel-byte equality.

## Color And HDR Contract

The SDR fixture declares BT.709 primaries, BT.709 transfer, BT.709 matrix, and full nominal range on both encoder media types. Seven decoded central patches are compared to synthetic bars with a documented maximum absolute error of 24 per channel. The reference system observed at most one channel value of error.

PQ/BT.2020 and HLG/BT.2020 inputs are blocked before evidence output. These scenarios prove classification and explicit rejection only. They do not implement or claim tone mapping. Production recording remains blocked for unsupported HDR until representative-game and reference-pattern tone mapping is separately accepted.

## Odd Dimensions And Aperture

The odd-size fixture pads only the right and bottom edges, by one replicated pixel each. Requested PNG extraction uses a zero-offset 161 by 91 `MFVideoArea` and restores the logical dimensions.

The measured MP4 Sink Writer path does not retain the submitted `MFVideoArea` as Source Reader container metadata. The negotiated decode media type does retain the trusted aperture supplied by the extraction request. Production design must therefore retain logical dimensions in trusted evidence metadata and reapply them during exact decode; it must not assume the MP4 container carries `MF_MT_GEOMETRIC_APERTURE`. This is a measured constraint for issue #9 and the Milestone 5 format decision, not a schema change in this spike.

## Evidence Contract

A complete evidence set uses one exact clean release binary and contains one independent report for every scenario. Record the binary SHA-256 and exact application build identity in a local copy of `native-decode-evidence.example.json`, then verify it:

```powershell
npm.cmd run native-decode:verify -- --manifest path/to/native-decode-evidence.json
```

Individual reports and verifier behavior can be checked with:

```powershell
npm.cmd run native-decode:verify -- path/to/report.json --scenario cfr-30
npm.cmd run native-decode:verify -- --self-test
```

The verifier rejects missing roles, duplicate runs, mixed build identities, path or private-marker leakage, non-synthetic input, network or project writes, non-exact timestamps or order, incorrect requested-sample identity, failed color patches, un-restored logical dimensions, unsupported HDR output, and retained failure artifacts.

## Accessibility Contract For Production

This isolated CLI has no interactive or shipped interface, so keyboard navigation, focus, NVDA, High Contrast, reduced motion, window sizing, and display scale checks do not apply to the executable. Production decode and extraction failures, unsupported HDR, and color warnings must be exposed as text, announced without relying on color or motion, identify the failed operation, and preserve the prior usable state.

## Security And Privacy

The harness uses generated synthetic pixels and local Media Foundation APIs only. It does not capture a screen, camera, microphone, game, window, or audio endpoint; open a network connection; write project data; or include media bytes, local paths, user identifiers, or private environment data in reports.

Synthetic MP4s, requested PNGs, and complete local reports remain ignored and uncommitted. Reports use `artifact:` labels rather than filesystem paths. Malformed, out-of-range, cancellation, HDR-blocking, and injected decoder-failure scenarios retain no media artifacts.

## Current Validation

The checked-in reference report and final measurements are populated only from the clean release evidence run used to close issue #8. Debug smoke runs are not acceptance evidence.
