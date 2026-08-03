# Gamebook Product Specification

> Status: Proposed product direction. This document does not describe features that are implemented in Gamebook 0.5.3 unless they are explicitly marked as current behavior.

## Product purpose

Gamebook is a local-first Windows application for collecting, annotating, organizing, and reporting visual evidence from gameplay. It is intended to help a researcher move from a fleeting gameplay observation to traceable evidence, interpretation, and a shareable finding without breaking the play session.

The first publishable release is designed primarily for solo researchers: game designers, UX and accessibility researchers, analysts, journalists, and QA investigators. The architecture may support team workflows later, but accounts, shared projects, and real-time collaboration are not version 1 requirements.

## Product principles

- Evidence remains traceable to its source capture and time.
- Editing is non-destructive by default.
- The application remains useful without an account or internet connection.
- Screenshots, recordings, clips, and frames use one consistent research workflow.
- Pages are finite, predictable report surfaces; large evidence collections live in a searchable library.
- Accessibility is part of every feature's acceptance criteria.
- Captured media is potentially sensitive; privacy, disclosure, and local data control are product requirements.
- The application does not inject into games, inspect game memory, or attempt to bypass capture protections.

## Current behavior to preserve

Gamebook 0.5.3 provides a Windows tray application, `Ctrl+Shift+F12` screenshot capture, a centered finite 1600 by 900 page, Fabric-based annotations, crop extraction, connectors, page ordering, compressed version 1 projects, recovery autosave, and PNG, PDF, Markdown, and text exports.

These workflows must continue to work throughout the media program. A user must be able to open, edit, save, recover, and export an existing version 1 screenshot project without losing page order, source pixels, transforms, annotations, text, or metadata.

## Workspace model

The publishable product uses two complementary surfaces:

- **Pages:** finite 1600 by 900 research and report surfaces containing freely positioned evidence, annotations, and notes.
- **Evidence Library:** a searchable collection of source captures and derived evidence that does not place every item onto a page automatically.

The page viewport provides Fit, 25-200% view zoom, reset, and pan. View transforms never change logical page coordinates, undo history, saved data, thumbnails, or exported pixels. Fit remains the default when opening a page.

The application adds a collapsible right panel with Evidence, Frames, Notes, Search, and Outline views. The video timeline appears below the page only when video evidence is selected. The layout must remain operable at the existing 900 by 620 minimum window size.

## Evidence model

Version 1 supports these evidence types:

- Screenshot captured by Gamebook or imported from PNG/JPEG.
- Source video recorded by Gamebook or imported as H.264/AAC MP4.
- Non-destructive clip referencing a source-time range.
- Frame represented by a lossless PNG and linked to a source timestamp and decoded sample index.
- Page annotation or explicitly timed annotation.
- Structured note, timeline marker, tag, collection, and evidence relationship.

Every derived item retains provenance. A clip knows its source recording and source range. A frame knows its source recording, presentation timestamp, and decoded sample index. A timed annotation uses source-video time so trimming or splitting a clip does not invalidate it.

Source recordings are protected while clips, frames, timed annotations, or placements depend on them. Deletion remains unavailable until dependents are removed or materialized. Materializing a clip creates a new independently encoded H.264/AAC asset, redirects its dependents, and records the former source relationship in provenance. A frame is materialized once its PNG has been written and verified.

Eligible deletions move complete evidence records into Project Trash as one transaction. Trash preserves provenance and inbound references for 30 days by default. Undo restores the complete transaction. Empty Trash permanently removes records and omits newly unreferenced assets from the next successful archive Save. Batch deletion is all-or-nothing, and Gamebook lists affected placements, findings, and links before the user confirms any cascade.

## Capture and playback

Screenshot capture remains `Ctrl+Shift+F12`.

Video capture defaults are:

- Shortcut: `Ctrl+Shift+F11`.
- Target: monitor under the pointer.
- Resolution: native physical display resolution.
- Frame rate: up to 60 FPS, subject to hardware capability.
- Duration: 30 seconds, configurable from 5 through 300 seconds.
- System audio: enabled.
- Microphone: disabled.
- Cursor: follows the user's capture setting.

Version 1 system audio uses whole-output-device WASAPI loopback, not game-process-only capture. It may include notifications, voice chat, music, and other applications. Gamebook presents this disclosure before the first audio-enabled recording and keeps a visible audio state in recording settings and the HUD. Microphone capture has a separate first-use disclosure and can never be enabled implicitly.

Shortcuts are remappable and checked for conflicts. Pressing the video shortcut during a recording stops it early. A small keyboard-operable recording HUD shows elapsed and remaining time and is excluded from supported capture modes. When exclusion cannot be guaranteed, Gamebook warns the user and falls back to a nonvisual tray/notification signal.

After finalization, the editor opens on a new page containing the recording as the primary placement. It autoplays unless autoplay is disabled, reduced motion is requested, or finalization produced a recoverable warning. Playback controls include play/pause, mute, volume, speed, source timecode, decoded frame number, previous/next frame, and loop range.

Only one placement plays on a page at once in version 1. Other video placements display their selected poster frames.

## Color and HDR policy

Version 1 project media and exports use 8-bit SDR sRGB/Rec.709 for broad playback and export compatibility. The capture pipeline records whether the source display was using HDR and its reported color space.

On an HDR display, Gamebook must either produce a validated SDR tone-mapped recording or block video recording with a clear explanation. It must never silently create washed-out or clipped evidence. HDR/10-bit imports are outside the guaranteed version 1 import contract. Extracted frame PNGs and static exports use sRGB.

If an encoder requires even dimensions, Gamebook preserves the logical source dimensions and adds no more than one pixel of replicated-edge padding on the right or bottom. Display-aperture metadata removes that padding during playback, frame extraction, placement, and export.

## Editing and frame analysis

Trimming and splitting create clip records and never rewrite the source recording. Clip boundaries use integer source timestamps in microseconds.

Annotations are page-persistent by default, preserving the existing behavior. An explicit timed mode attaches an annotation to one frame or an adjustable source-time range. Timed annotations are visible only while their target placement is showing the applicable source time.

Frame capture creates an ordinary annotatable screenshot evidence item with source provenance. Batch extraction supports:

- Selected source range or complete clip.
- Every decoded frame.
- Every Nth decoded frame.
- A fixed time interval.

Before extraction, Gamebook shows frame count, estimated output size, available disk space, and expected duration. Extraction requires confirmation above 300 frames and is refused when projected free space would fall below the greater of 2 GB or 10% of the volume.

The virtualized Frame Bin provides numbered thumbnails, progress and failure states, range selection, filters, drag-to-page, batch deletion, chronological grid placement, and contact-sheet placement. Full-resolution PNG generation is cancellable; completed frames become available while the rest of the job continues.

## Research workflow

Projects contain research sessions with optional game, build, platform, level, test label, capture settings, and start/end metadata. Researchers can use controlled tags, freeform collections, timeline markers, evidence links, and full-text search.

Structured findings follow this workflow:

1. Observation
2. Evidence
3. Interpretation
4. Hypothesis
5. Follow-up

Each stage may reference pages, recordings, clips, frames, annotations, or source timestamps. A clean Review mode presents findings and their evidence without editing controls.

Search indexes are derived caches and never the sole copy of research information. Structured findings, tags, collections, and typed evidence relationships are canonical project records defined by the accepted version 2 schema before implementation begins.

## Settings and preferences

Global settings are versioned separately from project files. They include shortcuts, capture target, duration, frame-rate cap, cursor, system audio, microphone, autoplay, playback volume, reduced-motion override, UI scale, cache limits, trash retention, and diagnostic preferences.

Settings migrations are sequential and testable. Invalid values fall back individually instead of resetting the complete file. A corrupt settings file is preserved for diagnostics, defaults are restored, and the user is informed. Failed shortcut registration restores the previous working shortcut. Credentials for future cloud processors must use Windows Credential Manager and never settings JSON.

## Import and export

Guaranteed version 1 imports are PNG, JPEG, and 8-bit SDR H.264/AAC MP4. Unsupported codecs, HDR/10-bit video, and malformed media are rejected with a compatibility explanation before the project changes. Import copies and verifies media into the project workspace; it never depends permanently on an external path.

The canonical multimedia export is a self-contained ZIP containing an offline HTML report and relative media assets. It reconstructs page geometry, placement transforms, crop, rotation, z-order, annotations, and timed visibility while also exposing the same content through semantic headings, evidence lists, notes, captions, and transcripts.

PDF remains static. Each page first exports at its configured poster timestamps. Timed findings then produce timestamped evidence sheets containing the decoded frame, visible annotations, source name, timecode, note text, and provenance. PDF does not embed playable video or claim PDF/UA conformance.

Markdown exports rendered pages plus relative links to included MP4 assets and textual clip ranges. PNG and text remain available. JSON and CSV provide evidence indexes for further analysis.

## Version 1 boundary

Core version 1 includes reliable recording, playback, clips, exact frame stepping, frame extraction, the Evidence Library, structured notes, tags, search, provenance, accessible HTML export, project recovery, accessibility, privacy controls, versioned settings, signed direct-download installers, update recovery, and release documentation.

Post-version 1 work includes synchronized multi-video comparison, onion skinning, difference and motion views, measurement tools, input-event capture, telemetry tracks, local OCR/transcription, optional cloud processors, team collaboration, and macOS capture.

## Product acceptance

- A researcher can complete hotkey -> recording -> autoplay -> annotation -> save -> reopen -> export without leaving the intended gameplay workflow.
- Any clip, frame, or timed finding can navigate back to its source recording and exact source time.
- Existing screenshot projects and exports retain their content and behavior after migration.
- Primary workflows pass keyboard-only and NVDA testing.
- No project media or telemetry leaves the device without a specific, informed user action.
- HDR displays never produce silently incorrect color, and whole-system audio scope is disclosed before recording.
- Interrupted recordings, deleted evidence, corrupt settings, and failed updates all have explicit recovery paths.

Security, local-data handling, diagnostics, media protocol, and export privacy requirements are defined in [SECURITY-PRIVACY.md](SECURITY-PRIVACY.md).
