# Video and Evidence Architecture

> Status: Proposed architecture. Media, `MediaPlacement`, and archive feasibility spikes must pass before this design becomes the version 2 implementation contract.

## Decision sequence

Implementation must not begin with the final version 2 schema. The required order is:

1. Native capture, encoding, audio, timing, and decoding spike.
2. WebView playback and Fabric `MediaPlacement` spike.
3. ZIP64 lazy-loading and streamed-save spike.
4. Review measured results and freeze the architecture.
5. Implement version 2 screenshot compatibility before integrating video into the main product.

Spike code is disposable and isolated from production paths. Each spike produces a short report containing configuration, measurements, failures, and the resulting architecture decision.

## Runtime ownership

Rust owns global shortcuts, capture targets, recording state, Windows Graphics Capture, WASAPI loopback, Media Foundation encoding/decoding, media probing, frame extraction jobs, asset verification, workspace/archive I/O, cache lifecycle, and native window behavior.

React owns settings, the Evidence Library, research metadata, timeline controls, progress and recovery UI, the page viewport, semantic accessibility representation, and export orchestration.

Fabric owns logical page geometry, object selection, transforms, z-order, connector anchors, annotation drawing, undo/redo, and static composition. It does not own source media bytes or native recording state.

## Native media feasibility gate

Milestone 2 selected direct Windows Graphics Capture and D3D11 bindings, direct Media Foundation H.264/AAC encoding and decoding, and direct WASAPI loopback audio as the proposed native foundation. The `windows-capture` 2.0.0 integrated recording path is not adopted. No FFmpeg executable is bundled in version 1.

The spike must validate:

- Full-resolution 1080p60 and 1440p60 capture on reference hardware.
- Capability-reported 4K60 with a clear lower-rate fallback when unsupported.
- Monitor-under-pointer and selected-window capture.
- Capture HUD exclusion and fallback notification behavior.
- System audio initialization, device changes, silence, cancellation, and synchronization.
- Whole-output-device audio disclosure and proof that microphone capture cannot be enabled implicitly.
- SDR capture on SDR displays and validated SDR tone mapping or explicit blocking on HDR displays.
- Odd-dimension source padding and display-aperture restoration.
- Submitted-frame timestamps, dropped-frame accounting, and final track duration.
- H.264/AAC finalization, playback, seeking, exact native frame decode, and PNG extraction.
- Recovery behavior for interruption during recording and finalization.
- Encoder, decoder, GPU-device, protected-content, and source-closed failures.

The direct-binding reference runs retained exact encoded sample counts, one-frame output duration, fast finalization, and explicit lifecycle/recovery behavior, but repeated 1080p, 1440p, and selected-window runs did not meet the strict 95% sustained-frame threshold. Production therefore preserves the interfaces below while capability-gating 60 FPS and exposing a clear lower-rate fallback until that threshold is separately proved.

Every media report records Windows version, CPU, GPU, graphics driver, RAM, display resolution and refresh rate, audio device, WebView2 version, storage type, power mode, and application build.

## Proposed domain interfaces

All time values are integer microseconds. IDs are opaque UUID strings.

```ts
interface CaptureSettings {
  target: { kind: "monitor-under-pointer" } | { kind: "monitor"; id: string } | { kind: "window"; id: string };
  durationSeconds: number;
  frameRateCap: 30 | 60;
  includeSystemAudio: boolean;
  includeMicrophone: boolean;
  includeCursor: boolean;
  outputColorSpace: "sdr-rec709";
}

interface MediaPlacementRecord {
  id: string;
  evidenceId: string;
  left: number;
  top: number;
  scaleX: number;
  scaleY: number;
  angle: number;
  crop?: { x: number; y: number; width: number; height: number };
  posterTimestampUs?: number;
  zIndex: number;
}

interface DecodedFrameRef {
  assetToken: string;
  width: number;
  height: number;
  timestampUs: number;
  sampleIndex: number;
  mimeType: "image/png";
}

type AnnotationScope =
  | { kind: "page" }
  | { kind: "time"; evidenceId: string; startUs: number; endUs: number };
```

`assetToken` is a short-lived reference to a verified cache entry exposed through the narrowly scoped application media protocol. Decoded bytes never cross IPC as base64.

Proposed commands:

```ts
startVideoCapture(settings: CaptureSettings): Promise<RecordingId>
stopVideoCapture(recordingId: RecordingId): Promise<void>
probeMedia(assetId: AssetId): Promise<MediaMetadata>
decodeVideoFrame(request: FrameRequest): Promise<DecodedFrameRef>
extractFrames(request: ExtractionRequest): Promise<JobId>
cancelMediaJob(jobId: JobId): Promise<void>
```

Proposed events are `video-recording-state`, `video-capture-created`, `media-job-progress`, `media-job-completed`, and `media-job-error`. Every event includes its recording or job ID so stale events cannot mutate a newer operation.

## Recording state and timing

Recording follows `idle -> preparing -> recording -> finalizing -> completed | failed | cancelled`. Only one recording may exist at once. Starting a screenshot while video is active is rejected with an accessible status message.

The encoder writes into a staging path with a recording journal containing the recording ID, settings, target metadata, start time, expected output, and current state. A project record never references this path. Clean finalization probes the media, verifies duration and decodability, imports the asset, and only then creates evidence.

At startup, interrupted staging files enter Recovery. If native probing confirms that a file is playable and has at least one decoded video sample, the user may recover it as draft evidence. Unplayable files remain quarantined with size and failure details until the user explicitly discards them. Version 1 does not attempt destructive media repair unless the feasibility spike proves a deterministic native repair path.

Captured media stores each submitted frame's presentation timestamp and dropped-frame metadata. Imported variable-frame-rate media uses decoder sample order and source presentation timestamps; Gamebook never invents constant-rate frame numbers for it.

Clips and timed annotations store source-video time, not clip-relative time. A clip maps its local playhead into the source interval. Splitting or trimming therefore changes only clip boundaries.

System audio uses whole-output-device WASAPI loopback in version 1. The recording metadata stores the selected endpoint ID, format, discontinuities, and whether the user acknowledged the current disclosure version. Per-process game audio is not claimed or simulated.

If system audio fails after recording starts, video continues, the audio discontinuity is recorded in metadata, and the editor presents a warning. Capture or encoder initialization failure aborts without creating referenced partial evidence.

The encoder output is 8-bit H.264 SDR Rec.709. HDR source state and color-space metadata are recorded separately. HDR capture must pass reference color-pattern and representative-game comparisons after tone mapping; otherwise recording is blocked while HDR is active. At most one replicated-edge pixel is added to satisfy even encoder dimensions. The exact-decode spike found that Media Foundation MP4 output does not retain the submitted `MFVideoArea` as container metadata, so trusted evidence metadata must retain the logical dimensions and reapply the aperture during decode; production must not infer the logical aperture from the MP4 alone.

## `MediaPlacement` rendering contract

A custom Fabric `MediaPlacement` represents placement geometry and selection. It serializes the `MediaPlacementRecord`, stable object ID, and connector anchor information only.

Each placement owns an offscreen drawing surface used as the Fabric image source:

- During normal playback, a hidden HTML video element draws its current frame into the surface using the browser's video-frame callback, then requests one Fabric render.
- During exact-frame mode, native decoding produces a `DecodedFrameRef`; the verified PNG is drawn into the same surface.
- When inactive, the placement displays its configured poster frame.

Only one placement plays at once in version 1. Starting another pauses the first. Page switching, export, exact-frame mode, app minimization, evidence deletion, or component disposal cancels callbacks and releases the video source.

Media placements are ordered among themselves by `zIndex` and render beneath page annotations. Timed annotations render above their target while its source playhead intersects the annotation range. Connectors use the stable placement ID and are independent of the current video frame.

The spike must prove move, scale, rotate, crop, selection, hit testing, connectors, undo/redo, page switching, normal playback, exact-frame substitution, poster restoration, and static export. No placement state may include a filesystem path, object URL, video element, frame bitmap, or media bytes.

## `MediaPlacement` performance gate

On the recorded reference environment, test 1080p60 and 1440p60 playback for 30 seconds with representative annotations and connectors. Record:

- Presented and rendered frames per second and dropped render callbacks.
- CPU and GPU utilization.
- Process private memory before, during, and after ten playback loops.
- Pointer-to-transform visual latency while playback is active.
- Time to pause, seek, enter exact-frame mode, and switch pages.

The preferred Fabric approach passes when it sustains at least 55 rendered FPS for a 60 FPS source on reference hardware, keeps transform latency below 50 ms at the 95th percentile, and returns within 100 MB of pre-loop memory after cleanup. If it fails, the architecture review evaluates a layered DOM video surface synchronized with Fabric geometry before the schema is frozen.

## View-only zoom and pan

The logical page remains 1600 by 900. Fit is the default view. Users may choose 25-200% zoom, reset, or Fit without modifying page data.

Zoom uses the Fabric viewport transform. Pan is available through Space+drag, middle-button drag, dedicated accessible controls, and Space+Arrow. Arrow keys continue moving selected objects by one page pixel; Shift+Arrow moves by ten.

View state is ephemeral per window and is excluded from page serialization, undo/redo, thumbnails, exports, and connector calculations.

## Static and multimedia export rendering

Static composition decodes every video placement at `posterTimestampUs` before rendering the 1600 by 900 page. Timed evidence sheets decode the target source timestamp and include annotations active at that time.

HTML export reconstructs each page with positioned media elements using the saved transform, crop, rotation, and media z-order. An annotation layer applies page-persistent and timed visibility above the media. The report also emits a semantic evidence representation outside the visual page so reading order and research content do not depend on canvas interpretation.

## Failure and cleanup rules

- Cancellation is idempotent.
- Late native events are ignored unless their recording/job ID is current.
- Partial generated assets remain unreferenced and are removed after the job stops.
- Interrupted recording outputs are quarantined for explicit recovery or deletion rather than silently removed.
- Device loss or page disposal releases render callbacks and native handles.
- Source evidence cannot be deleted while dependents remain.
- Unsupported imported codecs are rejected before an evidence record is created.
- Media protocol and diagnostic behavior follow [SECURITY-PRIVACY.md](SECURITY-PRIVACY.md).
