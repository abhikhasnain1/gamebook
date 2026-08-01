# Offscreen Playback and Exact-Frame Substitution Spike

> Status: Isolated Milestone 3 feasibility harness for issue #11. This is spike evidence, not a production media path or an accepted architecture decision.

## Scope

The harness evaluates a hidden HTML video feeding the same offscreen canvas used by a Fabric `MediaPlacement`, with `requestVideoFrameCallback` scheduling, one-active-placement coordination, source-time seeking, native-decoded PNG substitution, poster restoration, timed annotation visibility, and deterministic cleanup.

The verified Gamebook 0.5.3 editor and version 1 project schema are not imported by or changed for the harness. The standalone entry is `tools/spikes/media-playback.html`; all runtime code and synthetic media remain under `src/spikes/` and are unreachable from the production entry point.

Issue #10 owns stable placement geometry. Issue #12 owns complete viewport zoom and pan. Issue #13 owns 1080p60 and 1440p60 performance, transform latency, ten-loop memory recovery, consolidated manual accessibility evidence, and the final rendering-architecture selection. This issue accepts no architecture decision record.

## Rendering Boundary

Normal playback opens a hidden muted video from an opaque runtime token. Each compositor frame is copied into the placement's offscreen canvas and requests one Fabric render. Exact mode first cancels the browser frame callback and releases the video source, then copies a verified native-decoded PNG into that same canvas. Leaving playback or exact mode restores a deterministic poster without changing Fabric geometry.

Only stable `MediaPlacementRecord` fields serialize. Runtime tokens, source URLs, DOM elements, video elements, callback handles, decoded images, frame pixels, and media bytes remain runtime-only. The isolated token registry returns one generic error for missing, expired, or wrong-operation references. The browser fixture uses bundled synthetic assets and performs no network request beyond the local harness origin.

Pause, page switch, export suspension, minimize suspension, placement deletion, and controller disposal cancel callbacks, pause media, clear the video source, and restore the poster where the placement remains. Exact-frame failure also restores the poster and exposes a textual error while preserving stable geometry.

## Synthetic Fixtures

The checked-in H.264 MP4 and three PNGs are copied from issue #8's exact release evidence for the 60 FPS CFR scenario. They contain generated color identities only and no captured gameplay, audio, user data, paths, or third-party media.

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| `native-decode-cfr60.mp4` | 7,644 | `b1b33aa040553a781420fcc2d56a0e5f2089c430f85b20deac657d1c9d935795` |
| `native-decode-cfr60-sample-0.png` | 630 | `92733c616ee073ce05b8c03fbd15ac2495bbbc6c19c8835aebb57f7d9cd619ee` |
| `native-decode-cfr60-sample-30.png` | 629 | `639aba824b4406b29ccfdd5d72f5aa14ab9e11776dccef3a40cc3fc33249ccfd` |
| `native-decode-cfr60-sample-59.png` | 628 | `afed20a5d9ea783dc1e16c9cafbb467356d73a2bd7e0ec3e03ce7d247ca52d01` |

The source timeline uses decoder sample order and integer source timestamps. Sample 30 is `500000` microseconds and sample 59 is `983333` microseconds. The fixture has no audio track.

## Run

```powershell
npm.cmd run start
```

Open:

```text
http://127.0.0.1:1420/tools/spikes/media-playback.html?build=COMMIT_SHA
```

The footer reports the automated browser scenario result. The page exposes the complete JSON evidence in the hidden `#spike-report-json` element for deterministic collection.

Verify the report contract and verifier behavior:

```powershell
npm.cmd run media-playback:verify -- --self-test
npm.cmd run media-playback:verify -- --report PATH
```

## Accessibility Contract

The visible harness provides semantic placement selection, play/pause, source-time seeking, previous/next exact frame, poster restore, current state, current source time, decoded sample index, polite action status, and assertive failure text outside the canvas. Native controls provide keyboard operation. Focus styles, forced-colors rules, non-color state text, and reduced-motion rules are included; autoplay is suppressed whenever reduced motion is requested.

Automated component coverage checks names, state, keyboard activation, seeking, exact-frame controls, status, errors, and serious or critical axe violations. Issue #13 retains the Milestone 3 NVDA, Windows High Contrast, 100/150/200 percent scale, and reference playback performance review.

## Evidence Contract

The retained browser report must use one exact implementation commit and record:

- successful Chromium `requestVideoFrameCallback` rendering;
- source-time seek followed by a compositor frame;
- one-active-placement enforcement and poster restoration;
- exact sample 30 substitution at 500000 microseconds on unchanged geometry;
- timed annotation visibility above media;
- generic expired-token failure with a usable poster;
- zero callbacks and zero live sources after pause, page switch, export, minimize, deletion, and disposal;
- stable serialization without runtime token, URL, element, callback, or media state;
- semantic controls outside the canvas;
- browser, viewport, hardware concurrency, fixture hashes, and exact build revision.

Rendered FPS, pointer latency, CPU/GPU utilization, memory recovery, and production architecture adoption are deliberately not claimed here; issue #13 owns those measured gates.
