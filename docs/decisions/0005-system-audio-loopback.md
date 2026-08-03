# ADR-0005: System audio loopback

- Status: Accepted
- Date: 2026-08-03
- Governing issue: #18
- Roadmap milestone: Milestone 5
- Supersedes: None
- Superseded by: None

## Context

Gamebook needs synchronized system audio without implying that it isolates one game's process audio. Issue #7 measured shared-mode WASAPI loopback, silence, endpoint changes, 44.1 and 48 kHz mono and stereo input, PCM and float conversion, AAC output, duration, drift, cancellation, and finalization against a shared QPC clock.

The maximum measured absolute A/V drift was 22.28 ms after 30 seconds, encoded duration remained within the 100 ms reference endpoint buffer, and finalization completed within 3 ms. The evidence also confirmed that loopback captures the complete output-device mix and that a default endpoint change must not silently change the active source.

## Decision drivers

- Keep A/V drift at or below 50 ms after 30 seconds.
- Keep encoded audio duration within one active endpoint buffer.
- Describe whole-output-device capture truthfully before first use.
- Keep microphone consent separate, explicit, and default off.
- Preserve video when an audio device fails after recording starts.

## Options considered

### Shared-mode WASAPI loopback

This captures the complete selected render endpoint mix, supports the measured formats, and exposes packet QPC positions and discontinuities. It cannot claim per-process isolation.

### Per-process game audio

This could reduce incidental capture but was not proved by the feasibility work and has different compatibility and consent boundaries. It is not part of the accepted first recording contract.

## Decision

Use direct shared-mode WASAPI loopback of the default render endpoint in the multimedia role. The activated endpoint is pinned for the recording. Packet QPC positions and video timing share one QPC basis. Accepted PCM and float inputs include mono and stereo at 44.1 and 48 kHz; native processing converts to PCM16 for Media Foundation AAC encoding.

Gamebook discloses before first system-audio use that the complete output-device mix may include notifications, voice chat, browsers, music, and other applications. It never claims per-process audio. Video, system audio, and microphone are independent textual states.

A default-endpoint change is detected and recorded but does not silently switch the source. If the pinned endpoint fails after recording starts, video continues, the audio discontinuity is retained, and a warning is shown. Initialization failure before video starts aborts without referenced media. Microphone remains a separate future input, default off, and separately consented; settings migration, recovery, updates, or device changes cannot enable it implicitly.

## Consequences

Recording metadata must retain the endpoint role and format, disclosure version, discontinuities, and endpoint-change outcome without exposing raw device identifiers outside the protected workspace. The accepted gates are at most 50 ms A/V drift after 30 seconds, audio duration within one endpoint buffer, and finalization within five seconds.

The first implementation does not isolate game audio. Users receive an accurate disclosure and independent controls instead of a misleading capability claim.

## Compatibility and migration

No production setting or version 1 project changes in this decision. Future settings default system audio according to the accepted product flow and always default microphone off. Unknown or corrupt settings cannot promote microphone consent.

## Accessibility

The disclosure and independent video, system-audio, and microphone controls require accessible names, keyboard operation, visible focus, state exposure, and concise announcements. Device change, discontinuity, failure, and continued-video outcomes are textual and do not rely on sound or color. Status updates are throttled for screen readers.

## Security and privacy

Audio remains local. Gamebook does not mutate Windows privacy settings, enumerate device details into diagnostics, or include captured media by default in diagnostic exports. Endpoint IDs, paths, titles, media, captions, transcripts, and note text are redacted. Consent is versioned, explicit, and scoped separately for system audio and microphone.

## Validation

The accepted evidence is Issue #7 revision `43d3f2d15338b75263f4e69985af5ce5b3e4baa1`, binary SHA-256 `0FA775A6A61F8E49E9F04451B27637DCB0FAABBD04C3572E96FF8A811EB0EB8F`, and nine machine-verified reports. Production conformance repeats active audio, silence, endpoint change, post-start failure, cancellation, every accepted input class, duration, drift, finalization, disclosure, microphone default, and diagnostics redaction.

## Documentation impact

This record freezes the audio and consent sections in `docs/VIDEO-EVIDENCE-ARCHITECTURE.md` and constrains settings, recording metadata, recovery, diagnostics, and export work in later milestones.
